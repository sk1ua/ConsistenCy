# GitHub App Setup

ConsistenCy can run as a GitHub App and post PR review comments automatically.

The GitHub App surface is owned by `apps/api`: it verifies webhooks, creates
durable review jobs, runs the worker-backed review workflow, stores reports,
and posts PR comments. Python remains available behind the compatibility bridge
for parser, agent, scoring, evaluation, and model-heavy analysis code.

## Prerequisites

- Python 3.12+
- Node.js 22+
- npm
- Git
- A public webhook URL
- A GitHub account with permission to create GitHub Apps

## Create The App

1. Open GitHub Settings -> Developer settings -> GitHub Apps.
2. Create a new app.
3. Set the webhook URL to:

```text
https://your-server.example.com/github/webhook
```

4. Add permissions:

| Permission | Access |
| --- | --- |
| Metadata | Read |
| Contents | Read |
| Pull requests | Read and write |

5. Subscribe to pull request, push, and installation events.
6. Generate and download a private key.

## Configure Environment

Copy the example file:

```bash
cp .env.example .env
```

Set these values:

```bash
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=/path/to/consistency-app.pem
GITHUB_WEBHOOK_SECRET=your-webhook-secret
```

For production, also set an API token and allowed origins:

```bash
CONSISTENCY_API_TOKEN=replace-with-a-long-random-token
CONSISTENCY_ALLOWED_ORIGINS=https://your-web.example.com
```

## Run

```bash
npm install
python -m pip install -r requirements-dev.txt
npm run dev:api
npm run dev:web
```

For production, run the API behind HTTPS with a process manager and point the
GitHub App webhook URL at `/github/webhook`.

## Security Checklist

- Webhook secret is set.
- Private key file permissions are restricted.
- `CONSISTENCY_API_TOKEN` is set for non-webhook API routes.
- `CONSISTENCY_ALLOWED_ORIGINS` is explicit.
- HTTPS terminates before the webhook endpoint.
- Repository access is limited to intended installations.

## Troubleshooting

- Signature failures usually mean the webhook secret differs from GitHub settings.
- Missing PR comments usually mean the app lacks pull request write permission.
- Clone or API errors usually mean the private key, installation, or repository permission is wrong.
