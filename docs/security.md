# 安全

## 控制点

- API 和 Vite dev server 默认绑定 loopback。
- 生产环境需要显式 CORS origin 和 API token。
- GitHub webhook body 使用 HMAC SHA-256 校验。
- Delivery ID 会持久化，用于防重放。
- 仓库文件被视为不可信输入。
- 类 secret 路径和 token 模式会被跳过或脱敏。
- LLM 输出通过严格 zod schema 解析。

## 生产检查清单

- 设置 `NODE_ENV=production`。
- 使用 HTTPS。
- 将密钥放入 secret manager。
- 不暴露 SQLite 或 workspace 目录。
- 疑似泄露后轮换 API token 和 webhook secret。
