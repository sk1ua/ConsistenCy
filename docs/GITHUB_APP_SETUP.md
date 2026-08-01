# GitHub App 设置

## 必要设置

Webhook URL：

```text
https://your-server.example.com/github/webhook
```

| 权限 | 访问级别 |
| --- | --- |
| Metadata | Read |
| Contents | Read |
| Pull requests | Read and write |

事件：`pull_request`、`push`、`installation`。

## 环境变量

```bash
GITHUB_APP_ID=<your-app-id>
GITHUB_PRIVATE_KEY=/secure/path/private-key.pem
GITHUB_WEBHOOK_SECRET=replace-me
CONSISTENCY_API_TOKEN=replace-me
CONSISTENCY_ALLOWED_ORIGINS=https://your-web.example.com
```

不要把私钥提交到仓库；Settings 页面只接受替换值，不会回显已保存 secret。

## 本地运行

本地启动步骤见 [Demo 与截图](demo.md)。

API 默认监听 `127.0.0.1:8787`。生产环境使用 HTTPS、secret manager、进程管理器和隔离 workspace。
