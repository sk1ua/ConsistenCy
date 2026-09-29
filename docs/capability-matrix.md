# ConsistenCy Mode Capability Matrix

This matrix states what each product mode actually does today. It is not a
roadmap. Cells describe observed runtime behavior on HEAD. A blank claim in
other docs that contradicts this table is the one that is wrong.

Modes:

- **public-PR read-only**: `accessMode=public_read` — clone a public GitHub PR, analyze, never write back.
- **local_git**: registered local checkout, working-tree or SHA-range review.
- **cli**: `consistency review` — terminal one-shot host. It assembles the same review runtime the daemon assembles (`createReviewRuntime`), runs it with `accessMode=local_git`, keeps the job store in memory (`InMemoryJobQueue`) instead of SQLite, and always runs with `publicationPolicy=disabled`.

The Electron desktop host and the Web UI were deleted (v4). The CLI and the headless HTTP daemon are the two hosts of the same review implementation; only the daemon persists jobs.

Legend: **yes** = implemented and reachable; **no** = not implemented (and not claimed); **limited** = implemented with the restriction in the notes column.

## Review and evidence

| Capability | public-PR | local_git | cli | Notes |
|---|---|---|---|---|
| Real LLM review (Pi runtime) | yes | yes | yes | Rejected with `LLM_NOT_CONFIGURED` when no key is configured. With no configured provider the CLI stops before the run with a setup error naming `npm run setup` and `npm run config -- set llm.provider`. |
| Deterministic analyzers (Python stdio + TS plugins) | yes | yes | yes | Analyze source as data; generated code is never executed. |
| Working-tree snapshot pin | no | yes | no | local_git working-tree jobs persist review-time diff + redacted file contents (migrations 0023/0024). Range/GitHub jobs pin SHAs. The CLI selects the same working-tree or range head, but its in-memory job store persists no job, report, or snapshot row. |
| Notebook over review-time snapshot | limited | limited | no | Review changed-files and diffs resolve from persisted snapshots (working-tree) or pinned commit clones (range/PR). Pre-snapshot historical jobs lack review snapshots; unchanged files are capped at 2KB preview; arbitrary repo paths outside the review set are not fully content-pinned. The Notebook API exists (`POST /notebooks/:id/messages`, `POST /notebooks/:id/cards`) but the repository ships no UI for it, and the CLI exposes no Notebook surface. |
| Finding patch preview | no | yes | no | Preview only against a local checkout; the CLI has no patch command. |
| Finding patch apply | no | yes | no | local_git working tree only; never commits or force-pushes. |
| GitHub review comment publish | no | no | no | public-PR and local_git publication policy is `disabled`; the CLI always runs with `publicationPolicy=disabled`. github_app jobs may enqueue comments through CommitCoordinator. |
| Cancel in-flight review | yes | yes | no | In the daemon, `POST /jobs/:id/cancel` routes through RuntimeRegistry to the run-scoped AbortSignal that reaches the provider transport (`workload.cancelRun()`); the response keeps `externalOutcome` unknown until the run settles. The one-shot CLI exposes no cancel path, so interrupting it only terminates the process. |

## Isolation (honest)

Review agents run **in-process**. Isolation flags on a review run are therefore **not-enforced** unless every agent in that run is a sandboxed `child-process` (plugin path). OS filesystem/network/subprocess jails are never claimed.

| Guarantee | public-PR | local_git | cli |
|---|---|---|---|
| Capability syscall default-deny | yes | yes | yes |
| github.publish gated by CommitCoordinator | yes (unused: policy disabled) | yes (unused) | yes (unused: policy disabled) |
| Process memory isolation for review agents | no | no | no |
| Parent env secret isolation for review agents | no | no | no |
| OS fs/net/subprocess containment | no | no | no |

## Surfaces that require a real LLM

| Surface | HTTP | Unconfigured |
|---|---|---|
| Local / public-PR review | `POST /reviews/local`, `POST /reviews/public-pr` | 503 `LLM_NOT_CONFIGURED` (preflight); 400 during model resolution |
| Workflow Copilot | `POST /workflow-runtime/copilot/proposal`, `/chat` | 503 `LLM_NOT_CONFIGURED` |
| Notebook messages / cards | `POST /notebooks/:id/messages`, `/cards` | Notebook graph throws `LLM_NOT_CONFIGURED` |

Review preflight returns 503 `LLM_NOT_CONFIGURED` when no provider is configured; 400 is returned during the model resolution stage (e.g. invalid model override).

## Workflow runtime vs review report

The Cordis workflow-runtime MiniReport records `status`, `error`, agent summaries, and evidence counts. It does **not** share `reviewReport.coverage` (`complete` / `degraded`). A failed workflow agent fails the whole run; a failed review specialist degrades coverage but can still persist a report. Those are two products, not one missing field.

Runtime Workflow analysis is intentionally bounded and does not perform a full-repository review. `apps/api/src/workflow-runtime/host.ts:82` caps the candidate set (`MAX_ANALYSIS_FILES = 10`), applied by `planAnalysisSelection` (`apps/api/src/workflow-runtime/selection.ts:59`), which sorts the language-supported paths and slices them to that quota.

## Completion reporting to a supervisor channel

| Capability | public-PR | local_git | cli | Notes |
|---|---|---|---|---|
| Terminal completion notice (runId, attempt, result, evidence references, remaining budget) | limited | limited | no | Only when `CONSISTENCY_COMPLETION_WEBHOOK_URL` is explicitly configured; there is no default destination. Unconfigured ⇒ silently off (no outbox writes, no delivery, no timers) and `health.configuration.completionReporting.enabled=false`. The reporting hook is wired only by the HTTP daemon (`apps/api/src/server.ts:218`); the one-shot CLI never records a terminal notice. |
| Persistent outbox with bounded-backoff retries | limited | limited | no | Receiver errors never drop the task: rows persist (`pending`/`retrying`) until delivered or the bounded attempt budget settles them in `failed` with a sanitized error, visible in outbox stats. Delivery is event-driven (terminal notices + a one-shot startup recovery replay) — no polling loop, no timers. The CLI writes no outbox rows because it writes no SQLite. |
| Redacted notification content | yes | yes | n/a (no notices from the CLI) | Notices are allowlisted and pass the shared redact helpers before persistence: no secrets, no bearer credentials, no absolute local paths, no raw private prompts, evidence by id/path/fingerprint reference only. |

The completion credential (`CONSISTENCY_COMPLETION_WEBHOOK_TOKEN`) exists only inside the API process's outbound requests; it is never logged, persisted into outbox payloads, or included in any DTO.
