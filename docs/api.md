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
| `GET` | `/repositories/:id/git/status` | Read registered repository branch, working tree, and safe remote projection | Authenticated |
| `GET` | `/repositories/:id/git/commits` | Read commit history for a registered local repository | Authenticated |
| `GET` | `/repositories/:id/pull-requests` | List provider Pull Requests associated with the registered repository | Authenticated |
| `GET` | `/repositories/:id/review-preparation` | Read review preparation sources for the registered repository | Authenticated |
| `GET` | `/repositories/:id/reviews` | Bounded per-repository review job history (canonically associated jobs only; CKPT3 Phase 4) | Authenticated |
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
| `GET` | `/workflow-runtime/overview` | Built-in VerifiedMiniReview definition + registry node types (CKPT3 Phase 1) | Authenticated |
| `POST` | `/workflow-runtime/validate` | Validate + compile a workflow definition (fail-closed; creates no Run) | Authenticated |
| `GET` | `/workflow-runtime/definitions` | List persisted workflow definitions (builtin seed + user drafts; CKPT3 Phase 2) | Authenticated |
| `POST` | `/workflow-runtime/definitions` | Append a definition revision (schema-invalid → 400 sanitized; builtin immutable → 409) | Authenticated |
| `GET` | `/workflow-runtime/definitions/:id/revisions/:rev` | Read one persisted definition revision | Authenticated |
| `GET` | `/workflow-runtime/definitions/:id/revisions/:rev/dry-load` | Per-node feasibility report (compile-sourced; NOT an authorization) | Authenticated |
| `DELETE` | `/workflow-runtime/definitions/:id` | Delete a user definition (refused with run history) | Authenticated |
| `POST` | `/workflow-runtime/runs` | Trigger a revision-pinned run on a registered repository (canonical HEAD-pinned snapshot; no LLM) | Authenticated |
| `GET` | `/workflow-runtime/runs` | Bounded persisted run history summaries | Authenticated |
| `GET` | `/workflow-runtime/runs/:runId` | Run detail: pinned revision, evidence summaries, MiniReport, audit counts | Authenticated |
| `GET` | `/workflow-runtime/repositories/:id/bindings` | List a repository's workflow bindings (CKPT3 Phase 3) | Authenticated |
| `PUT` | `/workflow-runtime/repositories/:id/bindings/:definitionId` | Idempotently enable/disable a binding | Authenticated |
| `POST` | `/workflow-runtime/repositories/:id/runs` | Binding-gated manual trigger (latest validated revision; fail-closed 404/409) | Authenticated |
| `GET` | `/workflow-runtime/repositories/:id/runs` | Bounded per-repository run history (canonical repositoryId join) | Authenticated |
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

Standalone public PR URL ingestion is separate from repository workspace listing. It is read-only and does not use a GitHub App installation token merely because an App is configured.

## 4. Repository Authority and Safe Responses

The `:id` in repository routes is the opaque registered `Repository.id`. An exact audit-store registration is required. Display names, remote names, `local:` aliases, heartbeat roots, project-root shortcuts, relative paths, and absolute paths are not selectors. Local filesystem locators remain server-only and are resolved only for exact registered `local_git` records.

Git remote objects returned by repository routes have exactly this shape:

```json
{"name": "origin", "githubFullName": "owner/repository"}
```

`githubFullName` is optional. Raw fetch URLs, raw push URLs, and embedded credentials are never returned.

## 5. Local Review Trigger

```http
POST /reviews/local
Authorization: Bearer <CONSISTENCY_API_TOKEN>
Content-Type: application/json

{
  "repositoryId": "repo_opaque_id",
  "baseRef": "main",
  "headRef": "feature",
  "model": {"provider": "openai", "model": "gpt-model"}
}
```

The request requires `repositoryId`. `baseRef` and `headRef` are optional. A per-review model override may use `model` or `llm`; when both are present, `model` takes precedence. The body is strict and does not accept `repoPath`. The server resolves the local filesystem locator from the exact registered repository, and the locator does not cross the renderer/API response boundary.

## 6. Pull Request Lifecycle Fields

Provider state remains `open` or `closed`. `mergedAt` is required nullable metadata. The UI derives merged display from `closed` plus non-null `mergedAt`; it never infers merge state from Git history.

---

## 7. Local Repository Registration (Desktop IPC)

```http
POST /internal/repositories/local
Authorization: Bearer <CONSISTENCY_API_TOKEN>
x-consistency-desktop-control: <CONSISTENCY_DESKTOP_CONTROL_TOKEN>
Content-Type: application/json

{
  "path": "<server-only-local-path>",
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
