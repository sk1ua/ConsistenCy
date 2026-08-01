# HTTP API

默认 API 地址：`http://127.0.0.1:8787`。开发 Web 地址：`http://127.0.0.1:5173`。全栈 E2E 为避免污染本地数据，会使用隔离的临时 API 端口 `3001`。

## 认证

配置 `CONSISTENCY_API_TOKEN` 后，受保护请求需要：

```http
Authorization: Bearer <CONSISTENCY_API_TOKEN>
```

未配置 token 的本地 Demo 不需要认证。生产环境应配置 token、HTTPS 和显式 CORS origin。

## 路由

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | API、数据库、Worker 和配置状态 |
| `GET` | `/jobs` | Job 列表 |
| `GET` | `/jobs/:id` | Job 详情 |
| `GET` | `/jobs/:id/report` | Job 对应 ReviewReport |
| `GET` | `/reports/recent?limit=10` | 最近报告 |
| `GET` | `/stats` | Dashboard 统计 |
| `GET` | `/real-data` | 已导入的公开数据快照 |
| `POST` | `/github/webhook` | GitHub 签名 Webhook |
| `POST` | `/demo/seed` | 创建固定 Demo 数据 |
| `POST` | `/analyze-file` | 对本地文件请求确定性分析 |
| `POST` | `/jobs/run-next` | 手动运行下一个 Job |
| `POST` | `/jobs/:id/run` | 手动运行指定 Job |

共享类型位于 `packages/schema/src/`：HTTP、ReviewReport、Job 与 stdio wire contract 使用同一份 Zod Schema 定义，前后端与 Python 引擎两侧校验。
