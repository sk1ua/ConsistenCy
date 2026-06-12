# Demo Guide

## Start

```powershell
npm install
Copy-Item .env.example .env
npm run dev:api
```

In a second terminal:

```powershell
npm run dev:web
```

Open `http://127.0.0.1:5173`.

## Seed Data

```powershell
$headers = @{ Authorization = "Bearer $env:CONSISTENCY_API_TOKEN" }
Invoke-RestMethod -Method Post http://127.0.0.1:8787/demo/seed -Headers $headers
```

The operation is idempotent and inserts succeeded, queued, running, and failed examples. It is disabled in production.

## Suggested Recording Flow

1. Show Dashboard metrics, risk distribution, recent findings, and eight jobs.
2. Open Jobs and filter by repository, status, and severity.
3. Open a succeeded review report.
4. Expand a finding to show evidence, reasoning, recommendation, and confidence.
5. Switch grouping from severity to agent.
6. Show the agent-run timeline.
7. Open Settings to show configuration presence without exposing secret values.
8. Show a GitHub PR comment or the Markdown renderer test output.

## Demo Talking Points

- Webhook delivery and job state are durable, not in-memory only.
- Every confirmed finding must point to evidence and lines.
- MockLLM makes tests and the demo deterministic.
- GitHub comment failure is isolated from report persistence.
- Python analysis remains available without owning the main orchestration flow.

## Screenshots

- Approved reference: `docs/design/dashboard-reference.jpg`
- Current implementation: `docs/design/dashboard-implementation.png`
- Side-by-side QA: `docs/design/dashboard-comparison.jpg`
