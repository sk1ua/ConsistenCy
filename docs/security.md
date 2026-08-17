# 安全边界

## 控制点

- API 与 Vite dev server 默认绑定 loopback；生产环境需要显式 CORS origin、API token 和 HTTPS。
- GitHub Webhook body 使用 HMAC-SHA-256 校验，Delivery ID 持久化用于防重放。
- 外部命令使用 `execFile`，并校验 SHA、NUL 路径、参数、Secret、Binary 和 UTF-8 字节预算。
- 仓库文件、diff、评论和静态分析输出都按不可信输入处理；送入 LLM 时带有边界和长度预算。
- JSON-over-stdio 的 stdout 只允许协议消息；未知 ID、错误 Schema、非 JSON 或超长输出会触发协议熔断。
- LLM 输出使用共享 Zod Schema 解析；LLM 不是安全策略的唯一执行点。
- 公开 PR URL 只接受 canonical `https://github.com/{owner}/{repo}/pull/{number}`。
- 公开读取模式不需要 GitHub App installation；可使用匿名 GitHub API，或使用 API 进程从环境变量/本地加密配置读取的 `GITHUB_PUBLIC_READ_TOKEN`。
- PAT 认证失败不会静默降级为匿名；保存后不会向 WebUI 回显，也不进入数据库、日志、SSE 或错误响应。
- 公开 Job 固定 `accessMode=public_read` 和 `publicationPolicy=disabled`；内存 Store 与 SQLite Store 都会再次强制这一边界。
- Notebook 来源绑定 repository、PR、base/head SHA；文件读取拒绝绝对路径、路径穿越、Secret 路径、二进制和超出预算的内容。
- Notebook Agent 只读、无 shell、无工作区写入、无测试执行、无补丁应用和无 GitHub 发布权限；补丁建议只是文本。
- SQLite、workspace、Outbox 和本地评估结果不应直接暴露给公网。
- 运行时可观测性 DTO (`GET /api/runtime/runs/:runId`) 和 Task Manager 页面严格去敏感化：永不包含原始 CapabilityHandle (`cap_<64hex>`)、GitHub token、LLM API key、父进程环境变量或 Context 源码全文，只提供 12 位 Hex 指纹、元数据和截断的 Diagnostics。

## v3 运行时安全维度

| 安全维度 | 机制 | 状态 / 声明 |
| --- | --- | --- |
| 授权 (Authorization) | `CapabilityBroker` 按 Syscall 逐次鉴权 | **已强制 (ENFORCED)** |
| 外部 Commit 发布 | `CommitCoordinator` 拦截 `github.publish` / `repo.write` | **已强制 (ENFORCED)** |
| 进程内存隔离 | Node `child-process` 沙箱独立 PID 与 Heap | **已强制 (ENFORCED)** |
| 父进程密钥隔离 | 沙箱显式环境变量 Allowlist，不继承父进程 `process.env` | **已强制 (ENFORCED)** |
| 文件系统 OS 隔离 | 节点系统级文件访问未施加 OS 级限制 | **未强制 (NOT ENFORCED)** |
| 网络 OS 隔离 | 节点网络套接字创建未施加 OS 级限制 | **未强制 (NOT ENFORCED)** |
| 子进程 OS 隔离 | 节点子进程衍生未施加 OS 级限制 | **未强制 (NOT ENFORCED)** |

## 访问模式

| 模式 | App 安装 | 读取凭据 | 评论 |
| --- | ---: | --- | ---: |
| Demo Mode | 否 | 固定本地数据 | 否 |
| Public Read — Anonymous | 否 | 匿名公开 API/clone | 否 |
| Public Read — PAT | 否 | 服务端本地只读 PAT | 否 |
| Webhook Review | 是 | GitHub App installation token | 按发布策略 |

匿名 GitHub REST API 和 authenticated API 遵守 GitHub 官方限流规则；应用不通过并发或重试绕过限流。[GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

## 生产检查清单

- 设置 `NODE_ENV=production`，使用 HTTPS、secret manager 和进程管理器。
- Webhook Review 需要 GitHub App、`GITHUB_APP_ID`、`GITHUB_PRIVATE_KEY` 和 webhook secret。
- 公开读取可不配置 App，但必须显式启用 `CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED`，并接受公开 API 限流。
- 如果配置 `GITHUB_PUBLIC_READ_TOKEN`，选择最小权限、只读目标公开仓库的 PAT，并定期轮换。[GitHub personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- 限制 `CONSISTENCY_ALLOWED_ORIGINS`，不要使用通配符。
- 检查 workspace、SQLite、日志和截图中没有 token、私钥、绝对路径或不必要的 App ID。
- 疑似泄露后立即轮换 API token、Webhook secret、GitHub private key、public read token 和模型 key。
