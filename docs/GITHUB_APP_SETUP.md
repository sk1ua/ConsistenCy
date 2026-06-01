# GitHub App Setup

ConsistenCy can run as a GitHub App and post PR review comments automatically.

The project now has two GitHub App surfaces:

- `apps/api` is the TypeScript product shell for webhook verification,
  event routing, and job orchestration.
- `backend/github_app_server.py` remains the Python/Flask implementation
  that can run repository scanning and comment posting directly.

Prefer the TypeScript shell for new product/API work. Keep parser, agents,
  scoring, evaluation, and model-heavy logic in Python.

## Prerequisites

- Python 3.12+
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
GITHUB_APP_ENCRYPTION_KEY=your-64-char-hex-key
GITHUB_APP_ENV=production
FLASK_DEBUG=false
PORT=8000
```

Generate an encryption key:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

## Run

```bash
pip install -r requirements-dev.txt
python backend/github_app_server.py
```

For production, run behind HTTPS with a process manager or WSGI server.

## Security Checklist

- Webhook secret is set.
- Private key file permissions are restricted.
- `GITHUB_APP_ENV=production` is set.
- `FLASK_DEBUG=false` is set.
- HTTPS terminates before the webhook endpoint.
- Repository access is limited to intended installations.

## Troubleshooting

- Signature failures usually mean the webhook secret differs from GitHub settings.
- Missing PR comments usually mean the app lacks pull request write permission.
- Clone or API errors usually mean the private key, installation, or repository permission is wrong.
