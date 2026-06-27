# Web API

Default API URL: `http://127.0.0.1:8787`.

Protected routes require:

```http
Authorization: Bearer <CONSISTENCY_API_TOKEN>
```

## Routes

- `GET /health`
- `GET /jobs`
- `GET /jobs/:id`
- `GET /jobs/:id/report`
- `GET /reports/recent?limit=10`
- `GET /stats`
- `POST /github/webhook`
- `POST /demo/seed`
- `POST /analyze-file`
- `POST /jobs/run-next`
- `POST /jobs/:id/run`

Shared API schemas live in `packages/schema/src/api.ts`.
