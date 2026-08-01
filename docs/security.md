# 安全边界

## 控制点

- API 与 Vite dev server 默认绑定 loopback；生产环境需要显式 CORS origin 和 API token。
- GitHub Webhook body 使用 HMAC-SHA-256 校验，Delivery ID 持久化用于防重放。
- 外部命令使用 `execFile`，并校验 SHA、NUL 路径、参数、Secret、Binary 和 UTF-8 字节预算。
- 仓库文件、diff、评论和静态分析输出都是不可信输入；注入 LLM 时带有明确边界和长度预算。
- JSON-over-stdio 的 stdout 只允许协议消息；未知 ID、错误 Schema、非 JSON 或超长输出会触发协议熔断。
- LLM 输出使用共享 Zod Schema 解析；LLM 不是安全策略的唯一执行点。
- SQLite、workspace、Outbox 和本地评估结果不应直接暴露给公网。

## 生产检查清单

- 设置 `NODE_ENV=production`，使用 HTTPS 和 secret manager。
- 为 GitHub App、Webhook、API 和 LLM 密钥配置最小权限与轮换流程。
- 限制 `CONSISTENCY_ALLOWED_ORIGINS`，不要使用通配符。
- 检查 workspace、SQLite、日志和截图中没有 token、私钥、绝对路径或不必要的 App ID。
- 疑似泄露后立即轮换 API token、Webhook secret、GitHub private key 和模型 key。
