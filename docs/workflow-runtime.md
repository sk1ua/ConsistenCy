# Workflow Runtime（CKPT3 — Verified Workflow Runtime）

Status: Phase 1 vertical slice + Phase 1.1 canonical snapshot remediation
ACCEPTED (2026-08-23); CKPT6 Phase 1 runtime-native built-in library
(2026-08-27); Phase 2 productization increment (persisted
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

The compatibility seed `verified-mini-review` (immutable; revision 1 seeded at
server startup) plus five immutable runtime-native built-ins and USER
definitions execute this chain. The five CKPT6 built-ins are `pr-review`,
`pr-sanity-verification`, `security-hardening`, `architectural-drift`, and
`vibe-safety`. Their definitions live in `apps/api/src/workflow-runtime/definition.ts`,
use only the real `analyzer.deterministic-evidence` and
`verifier.persisted-evidence` services. Profiles are contracts, not labels:
style-only, secret-only, combined style+secret, and an explicit fan-out graph
are represented in the definitions. The five runtime signatures are: `pr-review`
combined analyzer → verifier; `pr-sanity-verification` style analyzer →
verifier; `security-hardening` secret analyzer → verifier;
`architectural-drift` independent style/secret fan-out → verifier fan-in; and
`vibe-safety` sequential style → secret → verifier, with the second analyzer
appending to the same run-scoped `EvidenceStore`. No legacy YAML is converted
or executed by this library.

```
Pinned repository HEAD snapshot
  → deterministic Analyzer Fiber
  → Evidence (fingerprint + provenance, persisted via Kernel)
  → deterministic Verifier Fiber (consumes persisted Evidence only)
  → Findings / MiniReport
```

Every stage runs on the same Kernel/Harness primitives as the authoritative
review runtime (see the execution-chain reference below — unchanged since
Phase 1). No LLM anywhere in this workflow.

### CKPT6 verification matrix

Each of the five names has an independent test row in
`apps/api/src/workflow-runtime/builtins.test.ts`. The rows assert schema parse,
DAG compilation and registry/coeffect/capability feasibility, then run against
a temporary pinned Git snapshot and assert persisted Evidence fingerprints,
pinned SHA provenance, verifier-backed findings and deterministic output. The
host/SQLite matrix is seed → revision/checksum pin → validated dry-load →
pinned snapshot run → persisted terminal run/evidence/verifier result; each
built-in also has a deterministic failure path. Catalog `verificationStatus` is
`unverified` on a fresh install and becomes `verified` only from a matching
successful persisted run with evidence and verified findings. The
`verified-mini-review` seed remains an immutable compatibility seed.

## Definition lifecycle (Phase 2)

- Definitions persist in SQLite (migration `0017`) as **append-only
  revisions**; runs pin `definitionId + revisionId` and history stays
  traceable forever.
- “Strict config” applies to workflow node configuration: node objects and
  analyzer/verifier parameters are fail-closed and reject unknown fields,
  unknown analyzer names, and wrong types. Process environment input remains
  tolerant by design because real OS environments contain keys such as `PATH`
  and `HOME`; those unknown keys are ignored and never enter `AppConfig`.
- Saving is a Validate → Save gate: schema, graph, registry, serviceRef, and
  descriptor parameter validation must all pass. Any invalid definition is
  rejected with 400 `WORKFLOW_DEFINITION_INVALID` (stable issue code/path,
  sanitized message) before a definition or revision row is created; invalid
  drafts are not persisted in this phase.
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
- `GET /catalog/engine-allowlist` — legacy `engineLegacyBuiltins` (and
  compatibility `builtinWorkflows`) comes only from the frozen WorkflowStore;
  `runtimeVerifiedBuiltins` is a separate workflow-runtime projection carrying
  id, namespace, revision, checksum, real node types, purpose, verification
  contract/matrix version, availability, and evidence-derived verification status. The API never joins the two worlds by matching names.
- `POST /workflow-runtime/validate` — validate + compile a definition body
  (creates nothing). A successful response is `{ ok: true, errors: [], plan }`,
  where `plan` is the strict shared `WorkflowRuntimeExecutablePlan` DTO. Failed
  responses contain only `{ ok: false, errors }`; unknown response fields fail
  closed in the API client.
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
Phase 2 loop: persisted definitions list (builtin + validated user
revisions), JSON editor, validate (both outcome states), save-revision,
dry-load panel (✓/✗
+ disclaimer), revision-pinned trigger bound to a registered repository
(opaque ids; honest EMPTY ≠ UNAVAILABLE), live run detail (pinned revision,
snapshot identity, evidence, findings, audit counts), and persisted run
history with refresh. Registry node types come from the API — the UI never
invents executable node types. The legacy workflow builder is frozen; the runtime-native graph Studio is a separate Phase 2 surface and does not redesign that builder.

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
| Graph-invalid draft | 400 `WORKFLOW_DEFINITION_INVALID`; no definition/revision persisted |
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

## Appendix: audit execution bridge (executor slice, 2026-08-27)

Decision-record addendum for the slice that lifted `auditExecution` from a
hard-coded capability lie into computed truth.

**Incremental mapping, not convergence.** The bridge changes nothing on the
frozen engine-legacy side and nothing in the runtime freeze surface
(registry, node types, builtin definitions untouched). Automatic audit
execution does NOT execute legacy WorkflowSpecs; it drains durable audit-run
drafts whose automation carries an explicit `runtimeDefinitionId` mapping and
launches them through `WorkflowRuntimeHost.launchDefinitionRun` — a new
internal entry shared with `triggerBinding`, containing everything AFTER the
binding gate (definition exists → latest VALIDATED revision → canonical
pinned-snapshot trigger path). No second execution world exists. The full
legacy-surface convergence/retirement decision remains deferred exactly as
recorded above; this slice does not reopen it.

**Scope: locally monitored repositories only.** Drafts for non-local
repositories are permanently excluded: they terminate as `failed` with the
honest reason "Audit execution is limited to locally monitored repositories"
— never silently skipped, never executed remotely.

**Single-flight discipline (same as CKPT5 triggers).** One executor instance
per process claims each draft by the fenced `created→queued` store transition
(a transition conflict simply means another worker won), attempts one launch
per run (no retry), mirrors the linked `workflow_runtime_run` terminal
outcome (`run_succeeded` / `run_failed` + reason) onto the audit run, and can
never throw into the process. On startup (after the host recovered ITS
interrupted runs) legacy queued/running rows are reconciled honestly:
terminal-linked rows mirror their real outcome; linkless or unresolvable-link
rows fail with "audit run interrupted by API restart…" reasons while keeping
the immutable link written.

**Capabilities semantics.** `/audit/capabilities` now reports computed values:
`auditExecution` = persistence ∧ executor armed
(`CONSISTENCY_AUDIT_EXECUTION_ENABLED`, default true, kill-switch false);
`auditRunEvents` / `auditExport` reflect their now-real routes. Planning
results compute `execution.available` per subject: executor armed ∧
automation mapped to a runtime definition ∧ repository local. Unavailable
results always carry the specific reason (disabled / no runtime definition
mapping / non-local).

**Kill switch:** `CONSISTENCY_AUDIT_EXECUTION_ENABLED=false` stops the loop,
skips restart reconciliation, and flips the capability + planning reasons to
"disabled". Poll interval: `CONSISTENCY_AUDIT_EXECUTION_POLL_INTERVAL_MS`.
The durable draft inventory remains fully intact across disable/enable.


## CKPT6 Phase 2 Runtime Studio

Runtime Studio is the runtime-native execution graph workbench at `/workflows?tab=studio`; it is distinct from the frozen legacy builder, Pipeline Inspector (流水线检查器), and review wizard surfaces. The node palette and inspector are driven exclusively by `/workflow-runtime/overview` registry DTOs, including service references, capabilities, coeffects, and strict parameter descriptors.

Studio drafts keep an immutable persisted baseline separate from a dirty draft. Nodes and edges are serialized deterministically and checked for unique ids, existing endpoints, no self-edges, registered node types, matching service references, and registry-approved parameters. Builtin seeds are fork-only; user saves append a revision.

The human gate is explicit: Validate draft (client graph checks plus server canonical validation) → Save revision → Dry-load persisted revision → Run. Dry-load is compile-time feasibility only and never grants syscall authorization. Run is restricted to a registered local repository; no public repository is treated as an executable normal path.

## CKPT6 Phase 3 — Workflow Copilot (conversational graph editing)

The Studio's right column carries a conversational Workflow Copilot (SPEC
§18.2/§18.3). It talks to `POST /workflow-runtime/copilot/chat` (see
docs/api.md §11): the client sends the bounded message history plus the
definition under discussion, and the assistant answers with a natural-language
reply plus an OPTIONAL patch — an empty patch is a purely conversational turn
(answers or clarifying questions). The single-shot
`POST /workflow-runtime/copilot/proposal` endpoint remains available for API
compatibility.

Safety contract (SPEC §36):

- The endpoint is a pure advisor — zero persistence, zero session state
  server-side, zero run/dry-load side effects, zero authorization. The client
  owns the conversation history (bounded at 24 messages); the server holds no
  conversation state. It never publishes, patches, or executes code.
- The generation prompt's node-type whitelist is built server-side from the
  runtime Node Registry (`listWorkflowNodeTypes()`); client-supplied
  registries are never trusted. Post-generation, the server fail-closed
  validates the whole patch IN ORDER against the current definition:
  `ADD_NODE` serviceRefs are checked against the registry, `ADD_EDGE` /
  `REMOVE_EDGE` endpoints and duplication are checked against the simulated
  edge set (an edge that already exists, or appears twice in one patch, is
  rejected — the reducer would otherwise silently skip it at Apply time), and
  `REMOVE_NODE` / `UPDATE_PARAMS` must reference nodes that exist at their
  position. Finally the server compiles "current definition + patch applied in
  order" with zero side effects, including registry-descriptor parameter
  validation. Violations return the sanitized 400 `WORKFLOW_PATCH_INVALID`;
  generation failures return the sanitized 502
  `WORKFLOW_PATCH_GENERATION_FAILED` (the raw LLM output is never echoed or
  logged).
- The patch vocabulary mirrors the Studio reducer: `ADD_NODE`, `ADD_EDGE`,
  `REMOVE_NODE`, `REMOVE_EDGE`, `UPDATE_PARAMS`. `ADD_EDGE`/`REMOVE_EDGE` have
  no `condition` field — the current `workflowRuntimeEdgeSchema` supports
  `{ from, to }` only and the contract does not invent capability the graph
  schema cannot represent. Conditions can be enabled once the edge schema
  grows them.
- Each assistant patch turn is preview-only: the Studio renders the simulated
  result in a dashed `.is-proposed` highlight over a preview graph computed
  from "draft + patch in order" without touching draft state, and lists the
  operations under the reply.
- Apply is human and explicit, per turn. The Studio translates the patch into
  existing reducer actions (`add-node`, `remove-node`, `connect`,
  `disconnect`, `update-params`) dispatched one by one — never a direct
  draft-JSON write — so the result flows through the canonical validate →
  save-revision gate chain like any manual edit (fingerprint invalidation
  included).
- Every applied reducer step is recorded on the Studio history stack; the
  panel's Undo pops one step at a time and re-opens the downstream gates
  exactly like a manual edit.
- Staleness is honest: each assistant patch turn records the definition
  fingerprint it was computed against. Any draft change (manual edit, another
  Apply, Undo) makes older unapplied turns stale — their Apply is disabled
  with an explicit "regenerate" hint while the conversation stays visible as
  history.
- Builtin seeds stay fork-only: an `ADD_NODE` patch against an unforked
  builtin seed disables Apply with an explicit fork hint (mirroring the
  reducer's add-node guard); edge-only patches follow the same rules as the
  manual connect control.


The Studio's right column carries a Workflow Copilot panel (SPEC §18.2: it is
NOT a chat; it produces a structured `WorkflowPatch`). The panel submits one
natural-language instruction to `POST /workflow-runtime/copilot/proposal`
(see docs/api.md §11) and renders the returned proposal as an operation list
(`ADD_NODE serviceRef`, `ADD_EDGE from → to`) plus the model's rationale.

Safety contract (SPEC §36):

- The endpoint is a pure advisor — zero persistence, zero run/dry-load side
  effects, zero authorization. It never publishes, patches, or executes code.
- The generation prompt's node-type whitelist is built server-side from the
  runtime Node Registry (`listWorkflowNodeTypes()`); client-supplied
  registries are never trusted. Post-generation, the server fail-closed
  validates every `serviceRef` against the registry, checks that every
  `ADD_EDGE` endpoint exists once the patch is applied and that no `ADD_EDGE`
  duplicates an edge already in the definition or added earlier in the same
  patch (a duplicate would otherwise be silently skipped by the reducer at
  Apply time), and compiles "current definition + patch" with zero side
  effects. Violations return the sanitized 400 `WORKFLOW_PATCH_INVALID`;
  generation failures return the sanitized 502
  `WORKFLOW_PATCH_GENERATION_FAILED` (the raw LLM output is never echoed or
  logged).
- The v1 patch vocabulary is `ADD_NODE` / `ADD_EDGE` only, and `ADD_EDGE` has
  no `condition` field — the current `workflowRuntimeEdgeSchema` supports
  `{ from, to }` only and the contract does not invent capability the graph
  schema cannot represent. Conditions can be enabled once the edge schema
  grows them.
- The proposal is preview-only: the Studio renders proposed nodes/edges in a
  dashed `.is-proposed` highlight over a preview graph computed from
  "draft + patch" without touching draft state, and lists the operations with
  the rationale.
- Apply is human and explicit. The Studio translates the patch into existing
  reducer actions (`add-node`, `update-params` when the proposal carries
  parameters, `connect`) dispatched one by one — never a direct draft-JSON
  write — so the result flows through the canonical validate → save-revision
  gate chain like any manual edit (fingerprint invalidation included). Reject
  clears the preview. Any manual draft edit during preview immediately
  invalidates it (`studioDefinitionFingerprint` comparison), and a proposal
  whose base draft changed while the request was in flight is discarded.
- Builtin seeds stay fork-only: an `ADD_NODE` proposal against an unforked
  builtin seed disables Apply with an explicit fork hint (mirroring the
  reducer's add-node guard); edge-only patches follow the same rules as the
  manual connect control.
