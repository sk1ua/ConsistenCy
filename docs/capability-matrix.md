# ConsistenCy Mode Capability Matrix

This matrix states what each product mode actually does today. It is not a
roadmap. Cells describe observed runtime behavior on HEAD plus the uncommitted
audit-remediation worktree. A blank claim in other docs that contradicts this
table is the one that is wrong.

Modes:

- **public-PR read-only**: `accessMode=public_read` — clone a public GitHub PR, analyze, never write back.
- **local_git**: registered local checkout, working-tree or SHA-range review.
- **desktop**: Electron host of the same API; OS process boundary plus credential isolation in main.

Legend: **yes** = implemented and reachable; **no** = not implemented (and not claimed); **limited** = implemented with the restriction in the notes column.

## Review and evidence

| Capability | public-PR | local_git | desktop | Notes |
|---|---|---|---|---|
| Real LLM review (Pi runtime) | yes | yes | yes | Rejected with `LLM_NOT_CONFIGURED` when no key is configured. |
| Deterministic analyzers (Python stdio + TS plugins) | yes | yes | yes | Analyze source as data; generated code is never executed. |
| Working-tree snapshot pin | no | yes | yes | local_git working-tree jobs persist review-time diff + redacted file contents (migrations 0023/0024). Range/GitHub jobs pin SHAs. |
| Notebook over review-time snapshot | limited | limited | limited | Review changed-files and diffs resolve from persisted snapshots (working-tree) or pinned commit clones (range/PR). Pre-snapshot historical jobs lack review snapshots; unchanged files are capped at 2KB preview; arbitrary repo paths outside the review set are not fully content-pinned. |
| Finding patch preview | no | yes | yes | Preview only against a local checkout. |
| Finding patch apply | no | yes | yes | local_git working tree only; never commits or force-pushes. |
| GitHub review comment publish | no | no | no | public-PR and local_git publication policy is `disabled`. github_app jobs may enqueue comments through CommitCoordinator. |
| Cancel in-flight review | yes | yes | yes | `POST /jobs/:id/cancel` aborts the provider call; Web UI ReportPage provides a cancel button calling this endpoint. |

## Isolation (honest)

Review agents run **in-process**. Isolation flags on a review run are therefore **not-enforced** unless every agent in that run is a sandboxed `child-process` (plugin path). OS filesystem/network/subprocess jails are never claimed.

| Guarantee | public-PR | local_git | desktop |
|---|---|---|---|
| Capability syscall default-deny | yes | yes | yes |
| github.publish gated by CommitCoordinator | yes (unused: policy disabled) | yes (unused) | yes (unused for local) |
| Process memory isolation for review agents | no | no | no |
| Parent env secret isolation for review agents | no | no | no |
| OS fs/net/subprocess containment | no | no | no |
| Desktop credential storage outside renderer | n/a | n/a | yes (`safeStorage` / main process) |

## Surfaces that require a real LLM

| Surface | HTTP | Unconfigured |
|---|---|---|
| Local / public-PR review | `POST /reviews/local`, `POST /reviews/public-pr` | 503 `LLM_NOT_CONFIGURED` (preflight); 400 during model resolution |
| Workflow Copilot | `POST /workflow-runtime/copilot/proposal`, `/chat` | 503 `LLM_NOT_CONFIGURED` |
| Notebook messages / cards | `POST /notebooks/:id/messages`, `/cards` | Notebook graph throws `LLM_NOT_CONFIGURED` |

Review preflight returns 503 `LLM_NOT_CONFIGURED` when no provider is configured; 400 is returned during the model resolution stage (e.g. invalid model override).

## Workflow runtime vs review report

The Cordis workflow-runtime MiniReport records `status`, `error`, agent summaries, and evidence counts. It does **not** share `reviewReport.coverage` (`complete` / `degraded`). A failed workflow agent fails the whole run; a failed review specialist degrades coverage but can still persist a report. Those are two products, not one missing field.

Runtime Workflow analysis is intentionally bounded and does not perform a full-repository review. `apps/api/src/workflow-runtime/host.ts` (L52-53) limits candidate file selection to at most the first 10 language-supported files (`MAX_ANALYSIS_FILES = 10`) sorted alphabetically from the snapshot.

## Completion reporting to a supervisor channel

| Capability | public-PR | local_git | desktop | Notes |
|---|---|---|---|---|
| Terminal completion notice (runId, attempt, result, evidence references, remaining budget) | limited | limited | limited | Only when `CONSISTENCY_COMPLETION_WEBHOOK_URL` is explicitly configured; there is no default destination. Unconfigured ⇒ silently off (no outbox writes, no delivery, no timers) and `health.configuration.completionReporting.enabled=false`. |
| Persistent outbox with bounded-backoff retries | limited | limited | limited | Receiver errors never drop the task: rows persist (`pending`/`retrying`) until delivered or the bounded attempt budget settles them in `failed` with a sanitized error, visible in outbox stats. Delivery is event-driven (terminal notices + a one-shot startup recovery replay) — no polling loop, no timers. |
| Redacted notification content | yes | yes | yes | Notices are allowlisted and pass the shared redact helpers before persistence: no secrets, no bearer credentials, no absolute local paths, no raw private prompts, evidence by id/path/fingerprint reference only. |

The completion credential (`CONSISTENCY_COMPLETION_WEBHOOK_TOKEN`) exists only inside the API process's outbound requests; it is never logged, persisted into outbox payloads, or included in any DTO.
