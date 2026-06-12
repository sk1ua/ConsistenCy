# GitHub App Setup

## Create the App

Create a GitHub App owned by your account or organization.

Recommended settings:

- Webhook URL: `https://your-api.example.com/github/webhook`
- Webhook secret: generate a high-entropy value.
- Repository permissions:
  - Contents: Read
  - Metadata: Read
  - Pull requests: Read and write
  - Issues: Read and write, if required by the PR comment endpoint policy
- Subscribe to `Pull request` events.

Install the App on the repositories ConsistenCy should review.

## Configure ConsistenCy

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
CONSISTENCY_API_TOKEN=replace-with-a-long-random-token
CONSISTENCY_ALLOWED_ORIGINS=https://review.example.com
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=replace-with-the-webhook-secret
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=replace-with-provider-key
```

`GITHUB_PRIVATE_KEY` accepts either real multiline PEM text or escaped `\n` sequences. Installation tokens are generated dynamically with `@octokit/auth-app`; they are not stored in the database.

## Supported Events

`pull_request` actions:

- `opened`
- `synchronize`
- `reopened`
- `ready_for_review`

`push` events are recorded as ignored and do not create jobs.

## Delivery Idempotency

The `x-github-delivery` header is the primary key in `webhook_deliveries`. Replayed deliveries return `duplicate` and cannot enqueue a second job.

## Local Delivery Test

For local development, use a tunnel that forwards HTTPS traffic to `127.0.0.1:8787`. Keep the API bound to loopback and expose only the tunnel endpoint. Verify that GitHub reports a successful delivery and that `/jobs` contains one queued job.

## Troubleshooting

- `INVALID_SIGNATURE`: webhook secret mismatch or modified request body.
- `WEBHOOK_NOT_CONFIGURED`: `GITHUB_WEBHOOK_SECRET` is missing.
- Installation authentication failure: check App ID, PEM formatting, and repository installation.
- Comment status `failed`: verify Pull request/Issues write permission. The report remains available in the Web UI.
