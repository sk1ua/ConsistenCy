# GitHub App Setup Guide

This guide walks through setting up ConsistenCy as a GitHub App for automatic PR review.

## Prerequisites

- A server with Python 3.12+ and Git
- A public IP or domain (for webhooks)
- A GitHub account (for creating the app)

## Step 1: Create GitHub App

1. Go to your GitHub Settings → Developer Settings → GitHub Apps
2. Click "New GitHub App"
3. Fill in:
   - **GitHub App Name**: `ConsistenCy` (or your preferred name)
   - **Homepage URL**: Your server URL
   - **Webhook URL**: `https://your-server/github/webhook`
   - **Webhook Secret**: Generate a strong random string
4. Permissions needed:
   - **Repository contents**: Read-only
   - **Pull requests**: Read & write (for posting comments)
   - **Metadata**: Read-only
5. Subscribe to events:
   - Pull request
   - Push
   - Installation
6. Save and note the **App ID**
7. Generate and download a **Private Key** (`.pem` file)

## Step 2: Install Dependencies

```bash
cd ConsistenCy
pip install -r backend/requirements.txt
# Required for token encryption
pip install cryptography
```

## Step 3: Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```bash
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=/path/to/consistency-app.pem
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_APP_ENCRYPTION_KEY=$(python -c "import secrets; print(secrets.token_hex(32))")
GITHUB_APP_ENV=production
FLASK_DEBUG=false
PORT=8000
```

**Important**: Generate a secure encryption key:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

## Step 4: Start Server

```bash
cd backend
python github_app_server.py
```

Or use gunicorn for production:
```bash
gunicorn -w 4 -b 0.0.0.0:8000 github_app_server:create_app()
```

## Step 5: Install App on Repositories

1. Go to your GitHub App's "Install App" tab
2. Click "Install" next to your organization/account
3. Select repositories (or all repos)
4. Click Install

## Step 6: Verify Setup

1. Create a test PR
2. You should see analysis activity in server logs
3. A comment should appear on the PR with risk report

## Security Checklist

- [ ] Webhook secret is set and signature verification is working
- [ ] Token encryption key is set in production
- [ ] `GITHUB_APP_ENV=production` is set
- [ ] `FLASK_DEBUG=false` is set
- [ ] Private key file has restricted permissions (`chmod 600`)
- [ ] Server uses HTTPS (via reverse proxy)
- [ ] Firewall rules restrict access to webhook endpoint only

## Troubleshooting

### Signature verification failures
Check that `GITHUB_WEBHOOK_SECRET` matches exactly what you set in GitHub App settings.

### Token encryption errors
Ensure `cryptography` is installed and `GITHUB_APP_ENCRYPTION_KEY` is set.

### Clone failures
Verify the private key is valid and the App has repository permissions.

### No PR comments
Check server logs for errors. Ensure App has "Pull requests: Write" permission.

## Advanced Configuration

### Rate Limiting

Set `RATE_LIMIT_PER_MINUTE=60` in `.env` to limit requests per IP.

### Allowed Repository Paths

Set `ALLOWED_REPO_PATHS=/data/repos` to restrict which paths can be analyzed via CLI.

### Custom Port

Set `PORT=5000` to run on a different port.
