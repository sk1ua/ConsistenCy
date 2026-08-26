# Workflow Runtime（CKPT3 — Verified Workflow Runtime）

Status: Phase 1 vertical slice + Phase 1.1 canonical snapshot remediation
ACCEPTED (2026-08-23); Phase 2 productization increment (persisted
definitions with append-only revisions, persisted run history, dry-load
feasibility panel) shipped the same day. CKPT5 (2026-08-25) adds automatic
change-triggered execution for `on_change` bindings (see below).

## Dual-schema decision record (Phase 2 D1; fixed as decision by Phase 5 D3)

DECISION (owner, 2026-08-23/24): two workflow schemas coexist by design, in
separate namespaces, and the legacy side is FROZEN:

| | `packages/schema/src/workflow.ts` | `packages/schema/src/workflow-runtime.ts` |
|---|---|---|
| Positioning | **engine-legacy** (frozen) | Kernel/Harness runtime surface |
| Executor | Python engine DAG (`run_workflow` over JSON-stdio) | Kernel Run → ACB → Scheduler → Cordis Fiber → per-syscall authorize |
| HTTP namespace | `/workflows*` (legacy CRUD + validate) | `/workflow-runtime*` |
| Status | zero-touch, zero-migration since Phase 2 | active surface (Phases 1–4; CKPT5 triggers) |

- The migration decision (whether/how to converge or retire the legacy
  surface) is DEFERRED to the next checkpoint.
- Re-evaluation trigger: the next checkpoint's planning cycle reviews this
  record before any workflow-schema work is scheduled.
- Until then: no new capabilities are added to the legacy surface, and the
  runtime surface must not grow a second execution world.

CKPT5 planning-cycle review of this record (2026-08-25): the FREEZE IS
MAINTAINED. Executing legacy WorkflowSpecs (e.g. via the Python engine DAG)
would add capability to the frozen surface and is therefore not an option
for automatic execution. CKPT5's automatic triggers execute ONLY
workflow-runtime definitions through the canonical executor. Full
convergence/retirement of the legacy surface remains deferred: it entangles
the engine-parity provider used for review grounding and the automation
control plane, and is a product-level owner decision (candidate for a later
checkpoint). The audit control plane keeps advertising `auditExecution:
false` truthfully; nothing in CKPT5 changes legacy-side behavior.

## What the runtime is

The built-in seed `verified-mini-review` (immutable; revision 1 seeded at
server startup) plus USER definitions execute this chain:

```
Pinned repository HEAD snapshot
  → deterministic Analyzer Agent/Fiber
  → Evidence (fingerprint + provenance, persisted via Kernel)
  → deterministic Verifier Agent/Fiber (consumes persisted Evidence only)
  → Findings / MiniReport
```

Every stage runs on the same Kernel/Harness primitives as the authoritative
review runtime (see the execution-chain reference below — unchanged since
Phase 1). No LLM anywhere in this workflow.

## Definition lifecycle (Phase 2)

- Definitions persist in SQLite (migration `0017`) as **append-only
  revisions**; runs pin `definitionId + revisionId` and history stays
  traceable forever.
- Saving requires a schema-parseable body (400 otherwise, nothing saved).
  Graph-invalid drafts save with status `draft_with_issues` + recorded
  issues but are REFUSED at trigger (409 fail-closed, no Run created).
- The builtin definition is immutable (save/delete → 409).
- Delete semantics (no prior convention existed, chosen conservatively):
  deleting a definition WITH run history is refused (409) — history
  traceability wins; without history the definition + revisions delete
  cleanly. Completed runs always stay readable.
- Bounds: 100 definitions max; run list bounded (default 50, max 200);
  request body 1 MB (existing `MAX_BODY_BYTES`).

## Run persistence & restart honesty (Phase 2)

Run records (status, snapshot identity, evidence summaries, MiniReport,
audit summary, pinned revision) persist in SQLite; the Phase 1 in-memory
Map is fully retired. On startup, any run still marked `running` from a
previous process is honestly marked `failed("run interrupted by API
restart")` — success is never fabricated.

## Dry-load feasibility (Phase 2)

`GET /workflow-runtime/definitions/:id/revisions/:rev/dry-load` reports
per-node: node-type registration ✓/✗, serviceRef match ✓/✗, coeffect
availability ✓/✗, capability-requirement satisfiability ✓/✗ — all derived
from the SAME registry/compile functions execution uses (single source of
truth; no second judgment logic). Overall verdict vocabulary is
`feasible` / `not-feasible` ONLY (never "authorized"/"passed"). The DTO and
UI carry the fixed disclaimer: a successful dry-load does NOT authorize any
syscall; every protected operation is authorized per-call by the Kernel.

## Repository bindings (Phase 3)

A binding is `(repositoryId, definitionId, enabled)` — DATA/intent, never an
authorization. Registration never auto-enables anything; enabling is an
explicit user action.

- Storage: migration `0018` (`workflow_runtime_bindings`,
  `UNIQUE(repository_id, definition_id)`); toggles are idempotent UPSERTs
  (repeated enable never duplicates); bounded at 20 bindings per repository.
- Listing: bindings join the CURRENT definition summary; a deleted
  definition is shown honestly as unavailable (`definition: null`) — never
  silently hidden.
- Manual trigger from a repository context
  (`POST /workflow-runtime/repositories/:id/runs`) enforces, BEFORE any Run
  record / snapshot / authorization: binding exists (404), binding enabled
  (409), definition still exists (404), latest VALIDATED revision resolves
  (409). The run then follows the exact Phase 1.1/2 canonical path and
  records the resolved revisionId (owner decision D2).
- Per-repository run history filters on the run record's canonical opaque
  `repository_id` (persisted since 0018; pre-0018 rows have NULL and simply
  never match a filter — no name-based inference joins, per Master Spec §27.6).
- Deferred by owner decision (CKPT3): automatic PR/webhook triggers,
  default-workflow flag (no consumer yet), per-binding parameters, trigger
  rate limiting (auth-gated dev surface stands).
  CKPT5 (2026-08-25) lifts ONE deferral: repository change-event triggers
  for LOCAL monitored repositories (next section). PR/webhook triggers for
  repositories without a local checkout, per-binding parameters, and rate
  limiting beyond the per-event dedupe remain deferred.

## Automatic change triggers (CKPT5)

A binding carries `triggerMode: "manual" | "on_change"` (default `manual` —
every pre-CKPT5 binding keeps its exact behavior). `on_change` is DATA /
intent: it never widens authorization. The chain:

```
RepositorySupervisor observes a monitored local repository
  → persisted RepositoryEvent (idempotent, deduped per repository/head/config)
  → WorkflowTriggerPlanner creates one durable trigger plan per enabled
    on_change binding (UNIQUE(repository, definition, dedupe_key))
  → WorkflowTriggerExecutor (single-flight background loop) claims the plan
    (fenced pending→executing UPDATE) and executes it through the SAME
    host.triggerBinding gate sequence as a manual click
  → Run records trigger provenance { source, eventId } (observability only)
```

Semantics:

- **At most once per event**: the plan dedupe key is derived from
  (repository, definition, event dedupe key); replays of the same persisted
  event never re-plan. One attempt per plan — no retry loop; a failed plan
  keeps its sanitized reason.
- **Snapshot pinning is at execution time**: the run pins the repository
  HEAD when the executor runs, not when the event fired.
- **Event re-arming on configuration change**: enabled on_change binding
  definition-ids are part of the supervisor registration digest. The
  digest material includes the bindings key ONLY when such bindings exist,
  so repositories without on_change bindings keep byte-identical digests
  across the CKPT5 upgrade (no event storm, no silent re-arm).
- **Honest restart recovery**: plans still `executing` after an API restart
  are marked `failed("trigger execution interrupted by API restart")`;
  the dedupe key still blocks silent re-execution of the same event.
- **Terminal plan statuses**: `succeeded` (a canonical run was created —
  runId linked; the RUN's own status tracks execution outcome),
  `skipped` (the binding no longer exists or is disabled at execution
  time — the intent went away), `failed` (sanitized reason: snapshot
  unavailable, definition not executable, store failure, …).
- **Scope boundary**: change triggers require a LOCAL monitored repository
  (the supervisor's domain). Public GitHub repositories without a local
  checkout fail closed at the snapshot and are documented as manual-only.
- **Kill switch**: `CONSISTENCY_WORKFLOW_TRIGGERS_ENABLED=false` disables
  the executor loop (planning continues; plans drain when re-enabled).
  Poll interval: `CONSISTENCY_WORKFLOW_TRIGGER_POLL_INTERVAL_MS`.

Kernel authority is unchanged: the executor is host-side trusted code
exactly like the manual route handler; every protected syscall inside the
run is authorized per-call by the Kernel (`repo.read`, `evidence.write`,
`evidence.read`).

## API

All routes are auth-gated and additive (legacy `/workflows*` untouched):

- `GET /workflow-runtime/overview` — seed definition + registry node types.
- `POST /workflow-runtime/validate` — validate + compile a definition body
  (creates nothing).
- `GET /workflow-runtime/definitions` — persisted definition summaries
  (origin builtin/user, latest revision + status).
- `POST /workflow-runtime/definitions` — append a revision (schema-invalid
  → 400 sanitized, nothing saved; builtin → 409).
- `GET /workflow-runtime/definitions/:id/revisions/:rev` — one revision
  (404 sanitized when unknown/mismatched).
- `GET /workflow-runtime/definitions/:id/revisions/:rev/dry-load` —
  feasibility report (see above).
- `DELETE /workflow-runtime/definitions/:id` — refuse-with-history (409) /
  clean delete; builtin 409.
- `POST /workflow-runtime/runs` — `{ repositoryId, definitionId?,
  revisionId? }` (omitted definition = the built-in seed). Canonical
  snapshot wiring as Phase 1.1: unknown repository → 404
  `REPOSITORY_NOT_FOUND`; un-pinnable repository → 503
  `WORKFLOW_SNAPSHOT_UNAVAILABLE`; unknown/non-executable definition →
  404/409; all fail-closed BEFORE any run record.
- `GET /workflow-runtime/runs?limit=N` — bounded run history summaries.
- `GET /workflow-runtime/runs/:runId` — run detail with pinned revisionId,
  origin, evidence summaries (provenance + fingerprints only), MiniReport,
  audit allow/deny counts.
- `GET /workflow-runtime/repositories/:id/bindings` — binding summaries,
  each carrying `enabled` and `triggerMode` (CKPT5).
- `PUT /workflow-runtime/repositories/:id/bindings/:definitionId` —
  `{ enabled, triggerMode? }` (idempotent UPSERT; absent `triggerMode`
  keeps the stored mode; default `manual`).
- `POST /workflow-runtime/repositories/:id/runs` — binding-gated manual
  trigger; the created run records `trigger: { source: "manual" }`.

Run summaries and run detail carry an optional `trigger` object
(`{ source: "manual" | "repository_change", eventId? }`) — pure provenance;
runs persisted before migration `0020` have no trigger field (honest NULL,
never fabricated).

### Snapshot fallback policy (unchanged from Phase 1.1)

The canonical review runtime documents a `contentBackedSnapshot` fallback
fed by the review context builder's SHA-pinned contents. The workflow host
has no such content source and never fabricates a digest pseudo-sha: a
repository that cannot produce a real pinned Git snapshot fails CLOSED with
a sanitized error. No third snapshot representation exists.

## Web UI

The Workflows page's "已验证运行时 / Verified runtime" tab covers the full
Phase 2 loop: persisted definitions list (builtin + user drafts), JSON
editor, validate (both outcome states), save-revision, dry-load panel (✓/✗
+ disclaimer), revision-pinned trigger bound to a registered repository
(opaque ids; honest EMPTY ≠ UNAVAILABLE), live run detail (pinned revision,
snapshot identity, evidence, findings, audit counts), and persisted run
history with refresh. Registry node types come from the API — the UI never
invents executable node types. No canvas, no redesign.

CKPT5: the Repository Workflows view adds a per-binding trigger-mode
selector (手动 Manual / 变更时 On change) with an automatic-trigger hint for
enabled on_change bindings; run history rows and run detail show the
trigger-source badge (手动/变更触发, event id on hover) for runs that carry
provenance. The global runtime tab shows the same provenance line in run
detail and history rows.

## Execution-chain reference (Phase 1, unchanged)

| Stage | Authority / primitive | Implementation |
|---|---|---|
| Definition schema + validation | data only (fail-closed) | `packages/schema/src/workflow-runtime.ts` |
| Compilation (Capability Requirement Check + ExecutablePlan) | descriptive only — issues NO authorization | `apps/api/src/workflow-runtime/compile.ts` |
| Node Registry (registry truth) | runtime-owned; UI must not invent node types | `apps/api/src/workflow-runtime/registry.ts` |
| Persistence (Phase 2) | trusted host side — NOT in the agent capability system | `apps/api/src/workflow-runtime/store.ts` |
| Run / ACB creation | `KernelScheduler.registerRun` / `registerAgent` | `apps/api/src/workflow-runtime/executor.ts` |
| Admission | `KernelScheduler.ready` + `admit` (priority/concurrency; no DENIED state exists — a non-admitted agent stays READY) | same |
| Fiber lifecycle | Cordis via `SchedulerAgentBridge` (agent-scoped isolate; ACTIVE on admission) | same |
| Context | `ContextManager` base image + per-agent copy-on-write `fork` | same |
| Protected operations | `CapabilityBoundRepoFacade` / `CapabilityBoundEvidenceFacade` → `SyscallGateway` → `CapabilityBroker.authorise` (Default DENY, DENY before handler, per-call) | same |
| Evidence | `EvidenceStore` with deterministic `computeEvidenceFingerprint` | Kernel |
| Deterministic analysis | `DeterministicEvidenceRunner` (plugins-builtin Style + Secret analyzers — the authoritative PR-4 path; the Python engine is NOT the workflow execution core) | `@consistency/workload-review` |

Capabilities used (all pre-existing Kernel syscalls; none invented):
`repo.read`, `evidence.write`, `evidence.read`. The MiniReport persists
host-side (like the canonical report boundary — there is deliberately no
`report.write` capability in the Kernel).

## Failure semantics (fail-closed)

| Failure | Behavior |
|---|---|
| Definition body schema-invalid | 400 sanitized; nothing saved |
| Graph-invalid draft | saved with issues; trigger refused 409, no Run |
| Unknown definitionId/revisionId | 404 sanitized; no Run, no authorization events |
| Store read/write failure | 503 sanitized; never masquerade as persistence truth |
| Run `running` at restart | honestly `failed("run interrupted by API restart")` |
| Definition edited/deleted mid-run | no effect (plan compiled + revision pinned); covered by TEST M |
| Admission not granted (Scheduler authority) | agent stays READY, cancelled, Run FAILED; zero syscalls |
| Trigger plan executes after binding deleted/disabled | plan `skipped` (sanitized reason); no Run, no snapshot |
| Trigger plan executes against un-pinnable repository / non-executable definition | plan `failed` with sanitized reason; no Run record |
| Trigger executor interrupted by API restart | plan honestly `failed("trigger execution interrupted by API restart")`; dedupe key blocks silent re-execution |
| Same repository event replanned | second plan insert is a no-op (UNIQUE repository+definition+dedupe) |
| Capability revoked after Fiber ACTIVE | next syscall DENIED (handler count 0), audit denial recorded |
| Analyzer produced no evidence | verifier never runs; no pass claim |
| Verifier fingerprint/provenance mismatch | MiniReport `failed`; never silently "verified" |
| Context materialization failure | fail-closed before any agent; zero syscalls |
| Unknown repository / un-pinnable snapshot | 404 / 503 sanitized before any Run record |

## Relationship to the legacy engine DAG

The engine-legacy `WorkflowSpec` (`engine.*` kinds, executed by the Python
engine via `run_workflow` over JSON-stdio) remains the deterministic parity
provider for review grounding and stays frozen (zero-touch, zero-migration).
The Cordis-native contract is deliberately separate: conflating the two
would create a second analyzer execution world, which the Master Spec
forbids. See "Dual-schema positioning" above.
