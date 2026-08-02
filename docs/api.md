# HTTP API

默认 API 地址为 `http://127.0.0.1:8787`，开发 Web 地址为 `http://127.0.0.1:5173`。全栈 E2E 使用隔离的临时 API 端口 `3001`，不会复用本地开发数据库。

## 认证

配置 `CONSISTENCY_API_TOKEN` 后，受保护请求需要：

```http
Authorization: Bearer <CONSISTENCY_API_TOKEN>
```

本地 Demo 未配置 API token 时可直接调用。生产环境应配置 API token、HTTPS 和显式 CORS origin。

## 路由

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | API、数据库、Worker、LLM 和访问模式状态 |
| `GET` | `/jobs` | Job 列表 |
| `GET` | `/jobs/:id` | Job 详情 |
| `GET` | `/jobs/:id/report` | ReviewReport |
| `GET` | `/reports/recent?limit=10` | 最近报告 |
| `GET` | `/stats` | Dashboard 统计 |
| `GET` | `/real-data` | 已导入的公开数据快照 |
| `GET` | `/settings` | 当前运行配置的脱敏视图 |
| `PUT` | `/settings` | 开发环境更新可编辑配置 |
| `POST` | `/github/webhook` | HMAC 校验的 GitHub Webhook |
| `POST` | `/demo/seed` | 创建固定 Demo 数据 |
| `POST` | `/reviews/public-pr` | 读取公开 PR URL，创建分析 Job 和 Notebook |
| `GET` | `/notebooks/:id` | Notebook、来源、消息和卡片 |
| `GET` | `/notebooks/:id/sources` | 仓库、PR、base/head SHA 和索引状态 |
| `POST` | `/notebooks/:id/messages` | 只读 Notebook 对话，返回 SSE |
| `POST` | `/notebooks/:id/cards` | 生成 Notebook 卡片，返回 SSE |

共享类型位于 `packages/schema/src/`。HTTP、ReviewReport、Job 和 JSON-over-stdio contract 使用同一套 Zod Schema 边界。

## 公开 PR 入队

```http
POST /reviews/public-pr
Authorization: Bearer <CONSISTENCY_API_TOKEN>
Content-Type: application/json

{"url":"https://github.com/espnet/espnet/pull/6327"}
```

只接受 `https://github.com/{owner}/{repo}/pull/{number}`。查询参数和 fragment 会被忽略，Issue、Commit、Compare、clone URL、其他主机和非 HTTPS URL 都会被拒绝。

公开 PR 使用 `accessMode=public_read`：

- 未配置 `GITHUB_PUBLIC_READ_TOKEN` 时，使用匿名 GitHub API 和匿名 Git clone；
- 配置该变量时，使用服务端只读 PAT；PAT 不发送到浏览器、不写数据库、不写日志；
- 不调用 GitHub App installation lookup；
- 统一创建 `publicationPolicy=disabled` 的 Job，不进入 GitHub 评论 Outbox；
- 记录并校验 base/head SHA，分析期间快照改变会以 `PUBLIC_GITHUB_SNAPSHOT_CHANGED` 失败。

成功返回 `202`：

```json
{
  "jobId": "job_...",
  "notebookId": "notebook_...",
  "repository": "espnet/espnet",
  "pullRequestNumber": 6327,
  "baseSha": "...",
  "headSha": "...",
  "publicationPolicy": "disabled",
  "status": "queued"
}
```

安全错误码包括：

| Code | HTTP | 含义 |
| --- | ---: | --- |
| `INVALID_PUBLIC_PR_URL` | 400 | URL 不是允许的公开 PR 格式 |
| `PUBLIC_GITHUB_NOT_FOUND` | 404 | 公开 PR 不存在或不可见 |
| `PUBLIC_GITHUB_RATE_LIMITED` | 429 | GitHub public API 达到限额 |
| `PUBLIC_GITHUB_FORBIDDEN` | 403 | GitHub 拒绝当前公开读取凭据 |
| `PUBLIC_GITHUB_UNAVAILABLE` | 502 | GitHub 暂时不可用 |
| `PUBLIC_GITHUB_SNAPSHOT_CHANGED` | 失败 Job | base/head 在构建上下文期间发生变化 |

错误响应不会包含 PAT、Authorization header、私钥、完整 GitHub 响应或本地绝对路径。限流响应只保留安全的 reset/retry-after 信息。

## Health

`GET /health` 的配置状态包含：

```json
{
  "publicPrAnalysis": true,
  "publicPrAccessMode": "anonymous",
  "notebook": true,
  "configuration": {
    "githubAppConfigured": false,
    "publicReadTokenConfigured": false
  }
}
```

`publicPrAccessMode` 只会是 `anonymous`、`pat` 或 `disabled`。健康接口只报告是否配置，不返回 secret 内容。

## Notebook SSE

`POST /notebooks/:id/messages` 请求体：

```json
{
  "content": "Which evidence should the reviewer inspect first?",
  "sourceJobIds": ["job_..."]
}
```

前端使用 `fetch()` 读取 SSE。事件包括 `run.started`、`source.selected`、`tool.started`、`tool.result`、`citation`、`text.delta`、`usage`、`run.completed`、`run.degraded` 和 `run.failed`。

代码事实必须带 repository、PR、head SHA、文件和行号；证据不足时返回“当前上下文无法确认”，不使用模型常识补齐。Notebook 工具只允许搜索、读取文件、读取 diff/base、读取 Evidence Pack/findings 和生成 unified diff 文本，不写文件、不执行命令、不应用补丁、不运行测试、不发布评论。

`POST /notebooks/:id/cards` 的 `kind` 为 `change_map`、`architecture_impact`、`risk_brief` 或 `fix_plan`。LLM 不可用时，已有 ReviewReport 仍可查看；可降级的卡片会标明来源，不能确认的模型结论不会伪造成成功结果。
