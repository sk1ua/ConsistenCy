# Web API

Default base URL: `http://127.0.0.1:8787`.

When `CONSISTENCY_API_TOKEN` is configured, all routes except `POST /github/webhook` and CORS preflight require:

```http
Authorization: Bearer <token>
```

Errors use:

```json
{
  "error": {
    "code": "JOB_NOT_FOUND",
    "message": "Job not found"
  }
}
```

## Routes

### `GET /health`

Returns service, database, worker, provider, and configuration-presence status. Secret values are never returned.

### `GET /jobs`

Query parameters:

- `status`: queued, running, succeeded, failed, cancelled
- `repository`: case-insensitive repository substring
- `severity`: critical, high, medium, low, info

Response: `{ "jobs": ReviewJob[] }`.

### `GET /jobs/:id`

Returns `{ "job": ReviewJob }`.

### `GET /jobs/:id/report`

Returns `{ "report": ReviewReport }`. A running job returns `409 JOB_NOT_READY`.

### `GET /reports/recent?limit=10`

Returns up to 50 recent reports.

### `GET /stats`

Returns totals, average duration, risk distribution, and top repositories.

### `POST /github/webhook`

GitHub-only route. Requires `x-github-event`, `x-github-delivery`, and valid `x-hub-signature-256` headers. Supported PR actions create queued jobs; push is ignored.

### `POST /demo/seed`

Development and test only. Creates deterministic idempotent demo jobs.

### `POST /analyze-file`

Development only. Both paths must be relative regular files inside `CONSISTENCY_WORKSPACE_ROOT`.

```json
{
  "currentFile": "job-id/src/new.py",
  "baselineFile": "job-id/src/old.py"
}
```

### `POST /jobs/run-next`

Compatibility/manual runner for one queued job. The primary production path is the automatic worker.

### `POST /jobs/:id/run`

Compatibility/manual runner for a specific job.

## Canonical Types

API schemas are defined in `packages/schema/src/api.ts`. Frontend code imports these schemas directly and parses every API response before use.
