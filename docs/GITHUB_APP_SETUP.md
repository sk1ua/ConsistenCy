# GitHub App 设置

## 必要设置

Webhook URL：

```text
https://your-server.example.com/github/webhook
```

权限：

| 权限 | 访问级别 |
| --- | --- |
| Metadata | Read |
| Contents | Read |
| Pull requests | Read and write |

事件：pull request、push、installation。

## 环境变量

```bash
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=/path/to/private-key.pem
GITHUB_WEBHOOK_SECRET=replace-me
CONSISTENCY_API_TOKEN=replace-me
CONSISTENCY_ALLOWED_ORIGINS=https://your-web.example.com
```

## 本地运行

```bash
npm install
npm run dev:api
npm run dev:web
```

生产环境应使用 HTTPS 和进程管理器。
