# GitHub App Setup

## Required Settings

Webhook URL:

```text
https://your-server.example.com/github/webhook
```

Permissions:

| Permission | Access |
| --- | --- |
| Metadata | Read |
| Contents | Read |
| Pull requests | Read and write |

Events: pull request, push, installation.

## Environment

```bash
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=/path/to/private-key.pem
GITHUB_WEBHOOK_SECRET=replace-me
CONSISTENCY_API_TOKEN=replace-me
CONSISTENCY_ALLOWED_ORIGINS=https://your-web.example.com
```

## Run Locally

```bash
npm install
npm run dev:api
npm run dev:web
```

Use HTTPS and a process manager in production.
