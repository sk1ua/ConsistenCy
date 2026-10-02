# ConsistenCy HTTP API Reference

The default development API address is `http://127.0.0.1:8787` (`HOST` and `PORT` default to `127.0.0.1` and `8787`). The daemon is headless: no UI ships in this repository. The routes below are the HTTP control plane around the same review implementation the terminal entry point runs (§1).

---

## 1. Primary Entry Point: the CLI

`consistency review` is the product entry point. The HTTP daemon exists to host the same review implementation for HTTP callers, persistent job history, workers, and GitHub integration.

```bash
npm run consistency -- review --repo ../my-checkout --base main --head feature
```

- The CLI is a *host* for the existing runtime, not a second implementation: `apps/cli/src/review.ts:149` calls the same `createReviewRuntime` (`apps/api/src/review/workloadRuntime.ts:142`) that the daemon's worker calls (`apps/api/src/jobs/worker.ts:89`). Analysis, agents, and the kernel are not re-implemented under `apps/cli`.
- One run reviews the checkout at `--repo` in a single process: no HTTP call and no repository registration are involved. The run keeps its job state in memory (`InMemoryJobQueue`, `apps/cli/src/review.ts:145`) and writes its evidence workspace under a CLI-scoped artifact directory in the install root instead of the daemon's SQLite job/report tables.
- CLI project memory normally reads/writes `.consistency/cli/knowledge/<repo>.sqlite` under the install root. `--no-memory` or `CONSISTENCY_NO_MEMORY=1` skips both knowledge-context indexing/reads and `record_review` write-back, without opening, creating or changing that database. Normal review/report generation stays enabled; daemon memory defaults are unchanged.
- A real LLM provider is required (DeepSeek, OpenAI, or Anthropic). Without one the command fails before the run with a setup error pointing at `npm run setup` or `npm run config -- set llm.provider <deepseek|openai|anthropic>`; there is no user-facing mock provider.
- Exit codes are the contract for automation: `0` the review ran and nothing met `--threshold`; `1` the review ran and at least one finding met the threshold; `2` the review did not run, or its coverage was incomplete — exit `2` is not a result a gate can trust.
- The commands are `consistency review [options]` (`--repo`, `--base`, `--head`, `--json`, `--verbose`, `--limit`, `--all`, `--threshold`, `--language`, `--provider`, `--model`, `--color` / `--no-color`, `--no-memory`, `--help` / `-h`) and `consistency help`. An unknown command prints usage and exits `2`. `npm run review` is the same review command without the extra `--`.

---

## 2. Authentication & Security

When `CONSISTENCY_API_TOKEN` is configured, protected requests require:

```http
Authorization: Bearer <CONSISTENCY_API_TOKEN>
```

`GET /health` and `POST /github/webhook` (HMAC-verified header) are the unauthenticated entries; every other route in §3 is authenticated. Provider credentials, GitHub private keys, and local filesystem locators are never returned by any route — see §7.

---

## 3. API Routes Summary

| Method | Path | Description | Access / Auth |
|---|---|---|---|
| `GET` | `/health` | Service health, database status, LLM configuration, and worker state | Public |
| `GET` | `/repositories` | List connected repositories | Authenticated |
| `POST` | `/repositories/connect-public` | Resolve or verify and connect a public github.com repository | Authenticated |
| `GET` | `/repositories/:id` | Get repository details, Git state, and recent reviews | Authenticated |
| `GET` | `/repositories/:id/git/status` | Read registered repository branch, working tree, and safe remote projection | Authenticated |
| `GET` | `/repositories/:id/git/commits` | Read commit history for a registered local repository | Authenticated |
| `GET` | `/repositories/:id/git/tree` | List one directory of a registered local repository (lazy Shell tree) | Authenticated |
| `GET` | `/repositories/:id/git/file` | Read a bounded text preview of one file in a registered local repository | Authenticated |
| `GET` | `/repositories/:id/pull-requests` | List up to the 100 newest provider Pull Request summaries, with truncation metadata | Authenticated |
| `GET` | `/repositories/:id/review-preparation` | Read review preparation sources for the registered repository | Authenticated |
| `GET` | `/repositories/:id/reviews` | Bounded per-repository review job history (canonically associated jobs only; CKPT3 Phase 4) | Authenticated |
| `GET` | `/jobs` | List review jobs | Authenticated |
| `GET` | `/jobs/:id` | Get job details and execution status | Authenticated |
| `POST` | `/jobs/:id/cancel` | Cancel a queued or running review: signals the live run (AbortSignal to the provider) then stores `cancelled`. 404 unknown, 409 already terminal (including publish in flight) | Authenticated |
| `GET` | `/jobs/:id/report` | Get completed `ReviewReport` JSON | Authenticated |
| `GET` | `/jobs/:id/findings/:findingId/patch` | Preview a finding's suggested unified diff (read-only; verifies against local checkout when `accessMode=local_git`) | Authenticated |
| `POST` | `/jobs/:id/findings/:findingId/patch/apply` | Apply a finding patch to the registered **local_git** working tree only (never commits / force-pushes) | Authenticated |
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
| `GET` | `/workflow-runtime/runs` | Bounded persisted run history summaries (optional trigger provenance) | Authenticated |
| `GET` | `/workflow-runtime/runs/:runId` | Run detail: pinned revision, evidence summaries, MiniReport, audit counts, trigger provenance | Authenticated |
| `GET` | `/workflow-runtime/repositories/:id/bindings` | List a repository's workflow bindings with `triggerMode` (CKPT3 Phase 3; CKPT5) | Authenticated |
| `PUT` | `/workflow-runtime/repositories/:id/bindings/:definitionId` | Idempotently enable/disable a binding; optional `triggerMode` (`manual` default / `on_change` automatic change trigger — CKPT5) | Authenticated |
| `POST` | `/workflow-runtime/repositories/:id/runs` | Binding-gated manual trigger (latest validated revision; fail-closed 404/409) | Authenticated |
| `GET` | `/workflow-runtime/repositories/:id/runs` | Bounded per-repository run history (canonical repositoryId join; optional trigger provenance) | Authenticated |
| `POST` | `/workflow-runtime/copilot/proposal` | Generate a structured WorkflowPatch proposal from natural language (zero persistence, zero side effects; sanitized fail-closed errors) | Authenticated (Real LLM Required) |
| `POST` | `/workflow-runtime/copilot/chat` | Conversational graph editing: client-held message history (≤24, last message `user`) + definition/definitionId → `{ reply, patch, basis.definitionFingerprint }`. Empty `patch` is a purely conversational reply. Full reducer vocabulary (`ADD_NODE`/`ADD_EDGE`/`REMOVE_NODE`/`REMOVE_EDGE`/`UPDATE_PARAMS`) validated in order server-side + compile precheck; zero session state server-side. Unknown `flow`/definition → 404; sanitized 400/502 otherwise | Authenticated (Real LLM Required) |
| `GET` | `/settings` | Get sanitized runtime configuration snapshot | Authenticated |
| `PUT` | `/settings` | Update editable runtime settings | Authenticated |
| `POST` | `/settings/github/test-connection` | Single bounded read-only GitHub connection probe: targets the ACTIVE runtime credential by default, or one unsaved draft PAT supplied as `{"publicReadToken": "..."}` (probe only; never persisted, logged, or echoed). Sanitized status enum + bounded retry metadata only (CKPT4 Slice 2, Phase 2C) | Authenticated |
| `POST` | `/settings/github/oauth/start` | Compatibility route for the GitHub OAuth Device Flow: proxies github.com with the server-configured public client id and returns `{ flowId, userCode, verificationUri, expiresAt, intervalSeconds }`. The `device_code` never leaves the server process; 503 `GITHUB_OAUTH_NOT_CONFIGURED` when unset. | Authenticated |
| `POST` | `/settings/github/oauth/poll` | Compatibility polling route: `{ "flowId": "..." }`. Server-enforced polling interval; returns `pending` / `expired` / `denied` / `unavailable`, or `connected`, which carries the access token exactly once. | Authenticated |
| `POST` | `/github/webhook` | Incoming HMAC-verified GitHub webhook event | GitHub HMAC Header |

The Notebook routes are the model-visible question-answering surface (tool-calling Q&A over a pinned repository/PR snapshot). They require `CONSISTENCY_NOTEBOOK_ENABLED` plus a wired notebook store, and answer `404` with code `NOTEBOOK_DISABLED` otherwise. The API exists but this repository ships no interface for it — there is no bundled UI. See docs/notebook.md.

---

## 4. Public Repository Connection

```http
POST /repositories/connect-public
Authorization: Bearer <CONSISTENCY_API_TOKEN>
Content-Type: application/json

{"input": "openai/codex"}
```

The input may be a strict `owner/repository` coordinate or an exact canonical `https://github.com/owner/repository` URL. URL input must equal the raw canonical reconstruction byte-for-byte: the server rejects other hosts, explicit ports, trailing slashes, uppercase/noncanonical scheme or host forms, credentials, query strings, fragments, percent encoding, dot segments, backslashes, WHATWG-normalized paths, malformed coordinates, and raw whitespace/control characters before any provider request. Short `owner/repository` input remains supported. Every request, including one matching a pre-existing GitHub or local row, verifies current repository access and metadata through the fixed GitHub API client before returning success. After verification, provider metadata is reconciled into the existing row while preserving its opaque ID; deleted, private, or inaccessible repositories fail rather than trusting persisted metadata. Local repositories with a matching `remoteFullName` remain canonical. Read candidates retain the established GitHub App installation token → configured public-read token → anonymous order. No raw remote URL, local path, or credential is returned.

Failures use typed codes for invalid input, unsupported hosts, unavailable/not-found repositories, authentication-required/private repositories, rate limits, and provider unavailability. Generic `POST /repositories` rejects `source: "github"`; GitHub records must pass through this verified endpoint.

## 5. Bounded Pull Request History

`GET /repositories/:id/pull-requests` performs a single fixed-host GitHub read for the newest Pull Requests first (`state=all`, created descending, page 1, 100 rows). An available response contains the server-resolved canonical `repositoryFullName`, `page: { "limit": 100, "truncated": boolean }`, and no more than 100 provider summaries. `truncated` means GitHub advertised a next page; it is not a total count. Every summary URL must equal the exact raw canonical reconstruction `https://github.com/{owner}/{repo}/pull/{number}`: dot segments, parent-segment normalization, backslashes, percent encoding, credentials, ports, query strings, fragments, and every other WHATWG normalization difference fail closed. The URL owner/repository match `repositoryFullName` case-insensitively while preserving legal mixed-case provider coordinates, and the positive safe-integer PR number matches its decimal URL segment exactly without leading or numeric-precision ambiguity. Repository coordinates use the same shared parser as Git remote discovery: owners are 1–39 alphanumeric/hyphen characters, begin and end alphanumerically, and repositories are 1–100 alphanumeric/dot/underscore/hyphen characters but cannot consist entirely of dots; whitespace, control characters, untrimmed input, and overlong components fail closed. The optional `latestReview` association is selected only by exact opaque `repositoryId`, PR-review kind, and one of the at-most-100 PR numbers in the provider response. Memory and SQLite stores return the exact latest job per requested number; the SQLite adapter uses one bounded query, and no fixed recent-history cutoff or repository-name inference is used. Unavailable responses contain an empty `pullRequests` array plus a stable `reasonCode` (`not_github`, `identity_unavailable`, `not_found`, `access_denied`, `rate_limited`, `provider_unavailable`, or `invalid_provider_data`) and a sanitized fixed reason. Before sending, the API validates the complete response schema and maps any invalid internal/provider response to the fixed `PULL_REQUEST_HISTORY_RESPONSE_INVALID` server error.

Each request is a single bounded provider read: the route does not poll in the background, synchronize provider data, automatically load another page, or expose a load-more/infinite-query flow. Public GitHub access is read-only and publication remains disabled; this route cannot mutate, comment on, label, close, reopen, or merge a Pull Request.

## 6. Public PR Review Ingestion

```http
POST /reviews/public-pr
Authorization: Bearer <CONSISTENCY_API_TOKEN>
Content-Type: application/json

{"url": "https://github.com/espnet/espnet/pull/6327"}
```

- Accepts canonical `https://github.com/{owner}/{repo}/pull/{number}` URLs only through the shared GitHub identity/PR URL parser. The raw input must equal the parser's exact canonical reconstruction; credentials, explicit ports (including `:443`), query strings, fragments, percent-encoded ambiguity, dot segments, parent-segment normalization, backslashes, dirty input, malformed coordinates, leading-zero numbers, non-safe-integer numbers, and every other WHATWG normalization difference are rejected.
- Creates an analysis-only job (`accessMode=public_read`, `publicationPolicy=disabled`).
- Requires a configured real LLM provider (DeepSeek, OpenAI, or Anthropic) to execute analysis.

Standalone public PR URL ingestion is separate from repository workspace listing. It is read-only and does not use a GitHub App installation token merely because an App is configured.

## 7. Repository Authority and Safe Responses

The `:id` in repository routes is the opaque registered `Repository.id`. An exact audit-store registration is required. Display names, remote names, `local:` aliases, heartbeat roots, project-root shortcuts, relative paths, and absolute paths are not selectors. Local filesystem locators remain server-only and are resolved only for exact registered `local_git` records.

Git remote objects returned by repository routes have exactly this shape:

```json
{"name": "origin", "githubFullName": "owner/repository"}
```

`githubFullName` is optional. Raw fetch URLs, raw push URLs, and embedded credentials are never returned.

`GET /repositories/:id/reviews` returns the strict bounded shape `{ repositoryId, reviews }`, with at most 200 `ReviewJob` DTOs. Every returned review must carry the exact same canonical opaque `repositoryId`; legacy rows without an association and rows associated with another repository fail the response contract. The API validates the final response before sending it against the same shared schema any client parses. Malformed responses fail closed with fixed errors rather than exposing provider, persistence, or row details.

## 8. Local Review Trigger

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

The request requires `repositoryId`. `baseRef` and `headRef` are optional. A per-review model override may use `model` or `llm`; when both are present, `model` takes precedence. The body is strict and does not accept `repoPath`. The server resolves the local filesystem locator from the exact registered repository, and the locator is never returned in an API response.

## 9. Pull Request Lifecycle Fields

Provider state remains `open` or `closed`. `closedAt` and `mergedAt` are required nullable metadata. Open rows require both timestamps to be null; closed rows require `closedAt`; merged rows are closed rows with non-null `mergedAt`. `updatedAt`, `closedAt`, and `mergedAt` cannot predate `createdAt`; `updatedAt` cannot predate either `closedAt` or `mergedAt`; and `mergedAt` cannot follow `closedAt`. Shared DTO validation and provider payload validation use the same lifecycle seam. Merged display is derived from `closed` plus non-null `mergedAt`; merge state is never inferred from Git history.

---

## 10. Audit Control Plane (runs, capabilities, events, export)

The audit domain (draft planning → executor bridging) exposes the following routes, all authenticated:

| Method | Path | Description |
|---|---|---|
| `GET` | `/audit/capabilities` | Computed capability truth: `persistence`, `automationScheduling`, `auditExecution` (executor armed), `auditRunEvents`, `auditExport`, and friends |
| `GET` | `/audit-runs` | List audit runs (optional `?repositoryId=` filter) |
| `POST` | `/audit-runs` | Create a durable draft run (still reports a draft-only `execution` block) |
| `GET` | `/audit-runs/:id` | One run with lifecycle status, `workflowRuntimeRunId` link, and `executionError` when failed |
| `POST` | `/audit-runs/:id/cancel` | Cancel a created/queued run |
| `GET` | `/audit-runs/:id/steps` | Run step artifacts |
| `GET` | `/audit-runs/:id/report` | V2 run report payload when present (`AUDIT_REPORT_NOT_FOUND` otherwise) |
| `GET` | `/audit-runs/:id/events` | Append-only lifecycle events `{ events: [...] }`; every event includes positive per-run `seq` allocated from 1 and returned in stable ascending `seq` order; unknown run → 404 `AUDIT_RUN_NOT_FOUND` |
| `GET`/`POST` | `/audit-runs/:id/export` | Durable export document (schema v1): run fields + event sequence + automation summary (when planned by one) + linked workflow-runtime run summary (when executed); identical read-only payload for both verbs |

Export document shape (declared once in `@consistency/schema`, see
docs/output_schema.md contract notes):

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-27T00:00:00.000Z",
  "run": { "id": "auditrun_...", "status": "succeeded", "workflowRuntimeRunId": "wfrun_...", "...": "..." },
  "events": [{ "id": "runevt_...", "auditRunId": "auditrun_...", "seq": 1, "eventType": "run_queued", "payload": {}, "createdAt": "..." }],
  "automation": { "id": "automation_...", "runtimeDefinitionId": "def-..." },
  "workflowRuntimeRun": { "runId": "wfrun_...", "status": "succeeded", "findingCount": 2 }
}
```

`automation` is present only when the run references a persisted automation;
`workflowRuntimeRun` only when the executor bridged it. Local filesystem
locators never appear in any exported surface.

**Execution availability semantics:** planning responses
(`POST /automations/:id/run`) compute `execution.available` as: audit
executor armed ∧ automation mapped to a workflow-runtime definition ∧
repository locally monitored. Unavailable results carry one of these reasons:
"disabled in this deployment" / "no workflow runtime definition mapping" /
"limited to locally monitored repositories". See
docs/workflow-runtime.md ("Appendix: audit execution bridge") for the full
decision record.

---

## 11. Workflow Copilot Proposal (CKPT6 Phase 3)

`POST /workflow-runtime/copilot/proposal` turns one natural-language
instruction into a structured `WorkflowPatch` proposal (SPEC §18.2/§18.3/§36).
The endpoint is a pure advisor: it never persists anything, never triggers a
run or dry-load, and never mutates a definition. The only path to a persisted
change is an explicit definition save through
`POST /workflow-runtime/definitions` (§3), which walks the canonical validate →
save-revision gate chain; the Copilot can never bypass the compiler.

Request (exactly one of `definition` / `definitionId` — sending both is a 400;
`definitionId` resolves to the definition's latest persisted revision). Inline
definition:

```json
{
  "instruction": "add a secret scan before the synthesizer",
  "definition": {
    "id": "my-flow",
    "version": 1,
    "nodes": [{ "id": "analyze", "type": "analyzer.deterministic-evidence", "serviceRef": "deterministic-evidence.analyzer", "parameters": {}, "failurePolicy": "fail-closed" }],
    "edges": []
  }
}
```

or, to patch the latest persisted revision of an already saved definition:

```json
{
  "instruction": "add a secret scan before the synthesizer",
  "definitionId": "my-flow"
}
```

Response:

```json
{
  "proposal": {
    "patch": [
      { "op": "ADD_NODE", "nodeId": "secret-scan", "serviceRef": "deterministic-evidence.analyzer" },
      { "op": "ADD_EDGE", "from": "analyze", "to": "secret-scan" }
    ],
    "rationale": "…",
    "basis": { "definitionFingerprint": "sha256-… of the definition the patch was computed against" }
  }
}
```

The v1 patch vocabulary is `ADD_NODE` and `ADD_EDGE` only. `ADD_EDGE`
deliberately carries no `condition` field: the current edge schema supports
`{ from, to }` only, and this contract does not invent capability the graph
schema cannot represent (conditions can be enabled when the edge schema grows
them). `ADD_NODE.name` is a descriptive label suggestion; the definition schema
has no name field, so it is never persisted.

Generation uses the configured real LLM (DeepSeek/OpenAI) with a server-built
prompt whose node-type whitelist comes from the runtime Node Registry
(`listWorkflowNodeTypes()`); client-supplied registries are never trusted.
After generation the server fail-closed validates the proposal and compiles
"current definition + patch" with zero side effects before responding.

Error codes (fail-closed, sanitized):

| Status | Code | Meaning |
|---|---|---|
| 400 | `WORKFLOW_PATCH_INVALID` | Malformed request, unknown `serviceRef` (hallucination detection against the server-owned registry), edge endpoints missing after the patch, duplicate `ADD_EDGE` (already in the definition or repeated within the patch), or failed compile precheck; `details.issues` carries sanitized issues |
| 404 | `WORKFLOW_DEFINITION_NOT_FOUND` | Unknown `definitionId` |
| 400 | `INVALID_REVIEW_MODEL` | Unsupported provider/model override |
| 502 | `WORKFLOW_PATCH_GENERATION_FAILED` | The LLM failed to produce schema-valid output (after the provider's own repair attempt) or the provider call failed; the raw LLM output is never echoed |
| 503 | `LLM_NOT_CONFIGURED` / `LLM_PROVIDER_NOT_CONFIGURED` | No real LLM provider configured |
| 503 | `WORKFLOW_RUNTIME_UNAVAILABLE` | Workflow runtime host is not wired |
