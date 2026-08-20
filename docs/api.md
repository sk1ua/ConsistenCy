# ConsistenCy HTTP API Reference

The default development API address is `http://127.0.0.1:8787`. In Electron Desktop mode, the API binds to an ephemeral dynamic loopback port on `127.0.0.1`.

---

## 1. Authentication & Security

When `CONSISTENCY_API_TOKEN` is configured, protected requests require:

```http
Authorization: Bearer <CONSISTENCY_API_TOKEN>
```

In Electron Desktop mode, the main process injects this token automatically via the `consistency://app` protocol proxy. Internal administration endpoints (such as local repository registration) additionally require the desktop control header:

```http
x-consistency-desktop-control: <CONSISTENCY_DESKTOP_CONTROL_TOKEN>
```

---

## 2. API Routes Summary

| Method | Path | Description | Access / Auth |
|---|---|---|---|
| `GET` | `/health` | Service health, database status, LLM configuration, and worker state | Public |
| `GET` | `/repositories` | List connected repositories | Authenticated |
| `GET` | `/repositories/:id` | Get repository details, Git state, and recent reviews | Authenticated |
| `POST` | `/internal/repositories/local` | Register a local Git repository path | Desktop Control Token |
| `GET` | `/jobs` | List review jobs | Authenticated |
| `GET` | `/jobs/:id` | Get job details and execution status | Authenticated |
| `GET` | `/jobs/:id/report` | Get completed `ReviewReport` JSON | Authenticated |
| `POST` | `/reviews/local` | Trigger a review run for a local registered repository | Authenticated (Real LLM Required) |
| `POST` | `/reviews/public-pr` | Ingest public GitHub PR URL and enqueue review run | Authenticated (Real LLM Required) |
| `GET` | `/notebooks/:id` | Get notebook workspace, sources, and card history | Authenticated |
| `GET` | `/notebooks/:id/sources` | Get pinned repository, PR, base/head SHA indices | Authenticated |
| `POST` | `/notebooks/:id/messages` | Stream interactive notebook reasoning via SSE | Authenticated (Real LLM Required) |
| `POST` | `/notebooks/:id/cards` | Generate analysis card (change map, risk brief, etc.) via SSE | Authenticated (Real LLM Required) |
| `GET` | `/api/runtime/runs` | List active and recent runtime telemetry runs | Authenticated |
| `GET` | `/api/runtime/runs/:runId` | Get full runtime snapshot (ACBs, Context VM, process tree) | Authenticated |
| `GET` | `/settings` | Get sanitized runtime configuration snapshot | Authenticated |
| `PUT` | `/settings` | Update editable runtime settings (dev / desktop mode) | Authenticated |
| `POST` | `/github/webhook` | Incoming HMAC-verified GitHub webhook event | GitHub HMAC Header |

---

## 3. Public PR Review Ingestion

```http
POST /reviews/public-pr
Authorization: Bearer <CONSISTENCY_API_TOKEN>
Content-Type: application/json

{"url": "https://github.com/espnet/espnet/pull/6327"}
```

- Accepts canonical `https://github.com/{owner}/{repo}/pull/{number}` URLs only.
- Creates an analysis-only job (`accessMode=public_read`, `publicationPolicy=disabled`).
- Requires a configured real LLM provider (DeepSeek or OpenAI) to execute analysis.

---

## 4. Local Repository Registration (Desktop IPC)

```http
POST /internal/repositories/local
Authorization: Bearer <CONSISTENCY_API_TOKEN>
x-consistency-desktop-control: <CONSISTENCY_DESKTOP_CONTROL_TOKEN>
Content-Type: application/json

{
  "path": "D:\\projects\\my-repo",
  "displayName": "my-repo",
  "monitoringEnabled": true
}
```

Response (`201 Created`):
```json
{
  "repository": {
    "id": "repo_...",
    "displayName": "my-repo",
    "source": "local_git",
    "trustLevel": "untrusted_readonly",
    "monitoringEnabled": true,
    "createdAt": "2026-08-20T00:00:00.000Z",
    "updatedAt": "2026-08-20T00:00:00.000Z"
  }
}
```
*(The local filesystem path is verified and retained internally; it is never echoed in the public Repository DTO).*
