/**
 * WorkflowRuntimeHost — the apps/api host boundary for the CKPT3 workflow
 * runtime.
 *
 * Phase 1.1: canonical snapshot wiring (trigger binds an opaque repositoryId;
 * RepositorySnapshot.create at the real HEAD; fail-closed sanitized
 * 404/503 before any Run record).
 *
 * Phase 2: persisted definition lifecycle (append-only revisions; the
 * built-in seed is immutable), persisted run history (survives restart;
 * interrupted runs are honestly marked failed), and dry-load feasibility
 * derived from the SAME compile output used for execution (never a second
 * judgment logic, never an authorization).
 *
 * H11: when an event ledger is attached, every run-state mutation
 * (insertRun / updateRunTerminal) is recorded transactionally together with
 * its run lifecycle event (run_started / run_succeeded / run_failed), and the
 * executor emits best-effort step events (see WorkflowRuntimeEventStore).
 *
 * Invariants carried over unchanged:
 *   - capability set repo.read / evidence.read / evidence.write;
 *   - per-syscall Kernel authorization (compile/dry-load grant nothing);
 *   - snapshot = canonical RepositorySnapshot only (no third representation);
 *   - definitions and plans are DATA, never execution authority.
 */

import { randomUUID } from "node:crypto";
import {
  computeEvidenceFingerprint,
  type EvidenceInput,
  type EvidenceSnapshot,
} from "@consistency/kernel";
import {
  isTerminalExecutionLifecycleState,
  isTerminalReason,
  projectRunTerminal,
  tryToExecutionLifecycleState,
  workflowModelVerificationSchema,
  type ExecutionLifecycleState,
  type TerminalReason,
  type WorkflowRuntimeDefinition,
  type WorkflowRuntimeDefinitionRevision,
  type WorkflowRuntimeDefinitionSummary,
  type WorkflowRuntimeDryLoadResult,
  type WorkflowRuntimeNodeFeasibility,
  type WorkflowRuntimeNodeType,
  type WorkflowRuntimePlanRevisionRequest,
  type WorkflowRuntimePlanRevisionResponse,
  type WorkflowRuntimeRecoveryAction,
  type WorkflowRuntimeRecoveryBlocker,
  type WorkflowRuntimeRecoveryPlan,
  type WorkflowRuntimeRecoveryStep,
  type WorkflowRuntimeRun,
  type WorkflowRuntimeRunCoverage,
  type WorkflowRuntimeRunEventState,
  type WorkflowRuntimeRunSummary,
  type WorkflowRuntimeRunV2,
  type WorkflowRuntimeTriggerRequestV2,
  type WorkflowRuntimeValidationIssue,
} from "@consistency/schema";
import { RepositorySnapshot } from "@consistency/repository";
import { LocalGitAdapter } from "@consistency/vcs-core";
import {
  VERIFIED_MINI_REVIEW_DEFINITION,
  WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS,
  WORKFLOW_RUNTIME_BUILTIN_METADATA,
  runtimeBuiltinChecksum,
} from "./definition";
import { compileWorkflowRuntimeDefinition, type WorkflowCompilation } from "./compile";
import type { SubflowResolver } from "./subflow";
import { listWorkflowNodeTypes, getWorkflowNodeService, getWorkflowServiceByRef, isRegisteredSyscallAction, AVAILABLE_WORKFLOW_SERVICES } from "./registry";
import { executeWorkflowPlan, type WorkflowExecutionResult, type WorkflowExecutorHooks, type WorkflowExecutorLlmEntry, type WorkflowExecutorStepCheckpointFact, type WorkflowRestoredStepResult, type WorkflowSnapshotInput } from "./executor";
import { sanitizeExecutionError } from "../security/redact";
import { WorkflowRuntimeStore, WorkflowRuntimeStoreError, type PersistedRunInput } from "./store";
import { WorkflowRuntimeEventStore, type PersistedWorkflowRuntimeEvent } from "./eventStore";
import { WorkflowRuntimeCheckpointStore, type CheckpointHeader, type CheckpointRecord } from "./checkpointStore";
import { validateCheckpointResult } from "./checkpointValidation";
import { ANALYSIS_BATCH_SIZE, ANALYSIS_FILE_QUOTA, computeAnalysisFingerprint, planAnalysisSelection } from "./selection";
import type { TrustedLLMBackend } from "@consistency/workload-review";

/** Deterministic, bounded file selection for the mini-review slice. */
const MAX_ANALYSIS_FILES = 10;
export const BUILTIN_DEFINITION_ID = VERIFIED_MINI_REVIEW_DEFINITION.id;

/**
 * H14: node kinds whose steps are READ-ONLY (re-executable or reuse-safe:
 * no external side effects beyond the revertible in-run evidence store, and
 * the one paid kind is reuse-gated by its checkpoint). A run containing any
 * other kind can never be resumed — unknown side effects stay blocked.
 */
const READONLY_STEP_KINDS: ReadonlySet<string> = new Set([
  "deterministic-analyzer",
  "persisted-evidence-verifier",
  "readonly-tool",
  "llm-structured-verifier",
]);

/** Unknown repository id — maps to the canonical 404 semantics. */
export class WorkflowRepositoryNotFoundError extends Error {
  constructor(repositoryId: string) {
    super(`Repository not found: ${repositoryId}`);
    this.name = "WorkflowRepositoryNotFoundError";
  }
}

/** Known repository that cannot produce a pinned snapshot — sanitized 503. */
export class WorkflowSnapshotUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkflowSnapshotUnavailableError";
  }
}

/** Unknown definitionId / revisionId — sanitized 404. */
export class WorkflowDefinitionNotFoundError extends Error {
  constructor(subject: string) {
    super(`Workflow definition not found: ${subject}`);
    this.name = "WorkflowDefinitionNotFoundError";
  }
}

/** Definition exists but is not executable (draft with issues) — 409. */
export class WorkflowDefinitionNotExecutableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkflowDefinitionNotExecutableError";
  }
}

/** User definitions are persisted only after the complete runtime compiler passes. */
export class WorkflowDefinitionInvalidError extends Error {
  readonly issues: WorkflowRuntimeValidationIssue[];
  constructor(issues: WorkflowRuntimeValidationIssue[]) {
    super("Workflow definition failed canonical runtime validation");
    this.name = "WorkflowDefinitionInvalidError";
    this.issues = issues;
  }
}

/** Sanitized 503 wrapper for store failures (never leak DB internals). */
export class WorkflowRuntimePersistenceError extends Error {
  constructor() {
    super("Workflow runtime persistence is unavailable");
    this.name = "WorkflowRuntimePersistenceError";
  }
}

/** A resolvable local Git repository binding (server-side truth). */
export interface WorkflowRepositoryBinding {
  readonly repositoryId: string;
  readonly displayName: string;
  readonly remoteFullName?: string;
  readonly localPath: string;
}

export type WorkflowRepositoryResolution =
  | { readonly status: "ok"; readonly binding: WorkflowRepositoryBinding }
  | { readonly status: "unavailable"; readonly reason: string };

export type WorkflowRepositoryResolver = (repositoryId: string) => WorkflowRepositoryResolution | undefined;

/** H14: fail-closed refusal for a recovery action (typed 409 with blockers). */
function refuseRecovery(blockers: readonly WorkflowRuntimeRecoveryBlocker[]): never {
  throw new WorkflowRuntimeStoreError(
    "continue is blocked: " + blockers.map((blocker) => `${blocker.code} (${blocker.message})`).join("; "),
    "WORKFLOW_RECOVERY_BLOCKED",
    409,
  );
}

/** Restart-stable references of a model verdict (its judged fingerprints). */
function parseModelVerdictFingerprints(modelVerdict: unknown): string[] {
  const parsed = workflowModelVerificationSchema.safeParse(modelVerdict);
  return parsed.success ? [...new Set(parsed.data.findings.map((entry) => entry.evidenceFingerprint))] : [];
}

/**
 * Wave 3 / R2: a checkpoint header must describe THIS run's inputs. The
 * comparison is fail-closed and never mutates anything; an empty stored value
 * means "not captured yet" (markInterrupted / pre-H14 rows) and is not a
 * mismatch.
 */
function checkpointHeaderMismatch(
  header: CheckpointHeader,
  record: { readonly definitionId: string; readonly revisionId: string; readonly repository: string; readonly headSha: string },
): string | undefined {
  const fields: readonly (readonly [string, string, string])[] = [
    ["definitionId", header.definitionId, record.definitionId],
    ["revisionId", header.revisionId, record.revisionId],
    ["repository", header.repository, record.repository],
    ["headSha", header.headSha, record.headSha],
  ];
  for (const [field, stored, expected] of fields) {
    if (stored !== "" && stored !== expected) {
      return `checkpoint ${field} '${stored}' does not match the run record '${expected}'`;
    }
  }
  return undefined;
}

/**
 * H14/R2: the checkpoint envelope is chosen by node KIND — never by whichever
 * payload happened to be present — so the persisted `result.kind` always
 * matches what the read-side validator expects for that kind. A model step
 * without a verdict is refused at write time (the executor turns that into an
 * honest `result_not_persisted` degradation).
 */
function checkpointEnvelopeFor(fact: WorkflowExecutorStepCheckpointFact): unknown {
  if (fact.nodeKind === "llm-structured-verifier") {
    if (fact.modelVerdict === undefined) {
      throw new Error("model-verdict checkpoint requested without a verdict (fail-closed)");
    }
    return { kind: "model-verdict", modelVerdict: fact.modelVerdict };
  }
  return { kind: "evidence-inputs", evidenceInputs: fact.evidenceInputs ?? [] };
}

/**
 * Wave 3 / R1(d): the executor's honest outcome → the run's terminal facts.
 * A degradation caused by a NON-DURABLE reusable result is not a coverage
 * problem — it is `result_unavailable`, and it never claims the run is safely
 * continuable.
 */
function terminalFactsForExecutionResult(
  result: WorkflowExecutionResult,
): { lifecycleState: ExecutionLifecycleState; terminalReason?: TerminalReason } {
  if (result.status === "succeeded") return { lifecycleState: "succeeded", terminalReason: "completed" };
  if (result.status === "degraded") {
    return result.degradedCause === "result_not_persisted"
      ? { lifecycleState: "degraded", terminalReason: "result_unavailable" }
      : { lifecycleState: "degraded", terminalReason: "degraded_coverage" };
  }
  return { lifecycleState: "failed", terminalReason: "fatal_error" };
}

function evidenceSummaries(records: readonly EvidenceSnapshot[]): WorkflowRuntimeRun["evidence"] {
  return records.map((record) => ({
    id: record.id,
    source: record.source,
    ruleId: record.ruleId ?? null,
    path: record.location.path,
    startLine: record.location.startLine ?? null,
    endLine: record.location.endLine ?? null,
    confidence: record.confidence,
    fingerprint: record.fingerprint,
    analyzer: record.provenance.analyzer,
    analyzerVersion: record.provenance.analyzerVersion,
    repository: record.provenance.repository,
    sha: record.provenance.sha,
  }));
}

/** Sorted, language-supported snapshot files at the pinned HEAD (bounded). */
function selectAnalysisPaths(files: readonly string[]): string[] {
  // H17: the explicit selection planner replaced the silent first-10 slice;
  // this helper stays for the run-level "no analyzable files" check and the
  // legacy bounded shape — selection/coverage itself is disclosed per run.
  return [...planAnalysisSelection(files, { quota: MAX_ANALYSIS_FILES }).selectedPaths];
}

/**
 * Dry-load per-node feasibility derived PURELY from compile-equivalent
 * registry lookups (single source of truth — same functions compile.ts uses).
 */
function nodeFeasibility(definition: WorkflowRuntimeDefinition, resolveSubflow?: SubflowResolver): {
  result: WorkflowRuntimeDryLoadResult;
  executable: boolean;
} {
  // Compile exactly once. Canonical validation issues are then attributed to
  // their node, while dry-load adds only the feasibility-specific flags/issues.
  const compilation = compileWorkflowRuntimeDefinition(definition, resolveSubflow);
  const canonicalIssues = compilation.errors.filter(
    (issue) => issue.code !== "capability_requirement_unsatisfiable" && issue.code !== "coeffect_unavailable",
  );
  const issueKey = (issue: WorkflowRuntimeValidationIssue) => `${issue.code}|${JSON.stringify(issue.path)}|${issue.message}`;
  const uniqueIssues = (issues: readonly WorkflowRuntimeValidationIssue[]) =>
    [...new Map(issues.map((issue) => [issueKey(issue), issue])).values()];

  const nodes: WorkflowRuntimeNodeFeasibility[] = definition.nodes.map((node, index) => {
    const service = getWorkflowNodeService(node.type);
    const serviceRef = service?.serviceRef ?? null;
    const serviceRefMatches = service?.serviceRef === node.serviceRef;
    const coeffects = (service?.coeffects ?? []).map((name) => ({
      name,
      available: AVAILABLE_WORKFLOW_SERVICES.has(name),
    }));
    const capabilityRequirements = (service?.capabilityRequirements ?? []).map((action) => ({
      action,
      satisfiable: isRegisteredSyscallAction(action),
    }));
    const dryLoadIssues: WorkflowRuntimeValidationIssue[] = [
      ...coeffects.filter((coeffect) => !coeffect.available).map((coeffect) => ({
        code: "coeffect_unavailable" as const,
        path: ["nodes", index, "type"] as (string | number)[],
        message: `Required coeffect service '${coeffect.name}' is unavailable in this runtime`,
      })),
      ...capabilityRequirements.filter((requirement) => !requirement.satisfiable).map((requirement) => ({
        code: "capability_requirement_unsatisfiable" as const,
        path: ["nodes", index, "type"] as (string | number)[],
        message: `Capability requirement '${requirement.action}' is not a registered Kernel syscall`,
      })),
    ];
    const attributedCanonical = canonicalIssues.filter(
      (issue) => issue.path[0] === "nodes" && issue.path[1] === index,
    );
    return {
      nodeId: node.id,
      nodeType: node.type,
      serviceRef,
      nodeTypeRegistered: service !== undefined,
      serviceRefMatches,
      coeffects,
      capabilityRequirements,
      issues: uniqueIssues([...attributedCanonical, ...dryLoadIssues]),
    };
  });

  // Graph-level canonical errors have no node path. Keep them once by
  // attributing them to the first node; persisted revisions normally cannot
  // reach this branch because save-time compilation rejects them.
  const graphIssues = canonicalIssues.filter((issue) => issue.path[0] !== "nodes");
  if (graphIssues.length > 0 && nodes[0]) {
    nodes[0].issues = uniqueIssues([...nodes[0].issues, ...graphIssues]);
  }
  const allIssues = uniqueIssues([
    ...canonicalIssues,
    ...nodes.flatMap((node) => node.issues.filter((issue) => issue.code === "capability_requirement_unsatisfiable" || issue.code === "coeffect_unavailable")),
  ]);
  const feasible = nodes.length > 0 && allIssues.length === 0 && compilation.ok && nodes.every(
    (node) => node.nodeTypeRegistered && node.serviceRefMatches &&
      node.coeffects.every((coeffect) => coeffect.available) &&
      node.capabilityRequirements.every((requirement) => requirement.satisfiable),
  );

  return {
    result: {
      definitionId: definition.id,
      revisionId: "", // filled by caller
      overall: feasible ? "feasible" : "not-feasible",
      nodes,
      disclaimer: "feasibility-check-only: a successful dry-load does not authorize any syscall; every protected operation is authorized per-call by the Kernel at execution time",
    },
    executable: feasible,
  };
}

export class WorkflowRuntimeHost {
  readonly #resolveRepository: WorkflowRepositoryResolver;
  readonly #store: WorkflowRuntimeStore | null;
  readonly #eventStore: WorkflowRuntimeEventStore | null;
  readonly #checkpointStore: WorkflowRuntimeCheckpointStore | null;
  readonly #modelBackendFactory: (() => Promise<WorkflowExecutorLlmEntry>) | null;
  /** H18 bounded dispatch width (1 = the historical serial order). */
  readonly #maxConcurrency: number;
  readonly #onRunTerminal: ((input: {
    readonly runId: string;
    readonly status: "succeeded" | "failed";
    /**
     * Wave 3 / R3 (task-10): the AUTHORITATIVE refined terminal facts the run
     * row and its ledger event were written with. A consumer (the H15
     * completion notice, an operator channel) must read THESE instead of
     * re-deriving a reason from the coarse `status` — a cancelled /
     * interrupted / degraded run can never be reported as `fatal_error`.
     * Optional so the record stays backward compatible.
     */
    readonly lifecycleState?: ExecutionLifecycleState;
    readonly terminalReason?: TerminalReason;
    readonly finishedAt: string;
    readonly evidence: unknown[];
    readonly miniReport?: unknown;
    readonly error?: string;
  }) => void) | null;

  constructor(options: {
    readonly resolveRepository?: WorkflowRepositoryResolver;
    readonly store?: WorkflowRuntimeStore | null;
    /** H11 append-only execution-event ledger (optional; absent ⇒ no events). */
    readonly eventStore?: WorkflowRuntimeEventStore | null;
    /** H14 durable checkpoint storage (optional; absent ⇒ no recovery plans). */
    readonly checkpointStore?: WorkflowRuntimeCheckpointStore | null;
    /**
     * H17 unified model entry factory (optional; absent ⇒ model nodes always
     * refuse with the accurate reason). Runs that need a model call the
     * factory ONCE at trigger time — a run that cannot resolve a configured
     * provider is refused BEFORE any run record exists (无 key 时拒绝并给准确原因).
     */
    readonly modelBackend?: () => Promise<WorkflowExecutorLlmEntry>;
    readonly maxCompletedRuns?: number;
    /**
     * H18: bounded dispatch width for dependency-ready execution (default 1 =
     * the historical serial order). The executor still folds findings, agent
     * summaries and evidence in topological order, so a wider bound never
     * changes what a run reports — only how soon independent nodes start.
     */
    readonly maxConcurrency?: number;
    /**
     * H15 terminal completion notification (optional; absent ⇒ no reporting).
     * Fired AFTER the terminal run-state + ledger event are durably persisted,
     * for EVERY terminal transition of this host — including the startup scan
     * that marks an interrupted run failed. The authoritative
     * `lifecycleState`/`terminalReason` ride along (see the field docs). The
     * callee is expected to be failure-contained (the completion sink never
     * throws); the host still defends — notification must never break run
     * finalization.
     */
    readonly onRunTerminal?: (input: {
      readonly runId: string;
      readonly status: "succeeded" | "failed";
      readonly lifecycleState?: ExecutionLifecycleState;
      readonly terminalReason?: TerminalReason;
      readonly finishedAt: string;
      readonly evidence: unknown[];
      readonly miniReport?: unknown;
      readonly error?: string;
    }) => void;
  } = {}) {
    this.#resolveRepository = options.resolveRepository ?? (() => undefined);
    this.#store = options.store ?? null;
    this.#eventStore = options.eventStore ?? null;
    this.#checkpointStore = options.checkpointStore ?? null;
    this.#modelBackendFactory = options.modelBackend ?? null;
    // H18: fail-closed normalization — a non-finite / sub-1 bound degrades to
    // the serial default instead of an unbounded dispatch.
    const requested = options.maxConcurrency ?? 1;
    this.#maxConcurrency = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 1;
    this.#onRunTerminal = options.onRunTerminal ?? null;
  }

  #subflowResolver(): SubflowResolver {
    return (definitionId, revisionId) => {
      const persist = this.#persist();
      const revision = revisionId ? persist.getRevision(revisionId) : persist.getLatestValidatedRevision(definitionId);
      if (!revision || revision.definitionId !== definitionId || revision.status !== "validated") return undefined;
      return { definition: revision.definition, revisionId: revision.revisionId };
    };
  }

  #compile(definition: unknown) {
    return compileWorkflowRuntimeDefinition(definition, this.#subflowResolver());
  }

  #persist(): WorkflowRuntimeStore {
    if (!this.#store) throw new WorkflowRuntimePersistenceError();
    return this.#store;
  }

  /**
   * Idempotently seed the immutable builtin definitions (revision 1 each) and
   * honestly recover runs + trigger plans interrupted by a previous shutdown.
   *
   * H14 upgrade: with the event ledger AND checkpoint store attached, the
   * interrupted-run scan is checkpoint-aware — each still-`running` run is
   * (a) marked failed transactionally WITH its run_failed ledger event, and
   * (b) marked `interrupted` in the checkpoint store so an explicit recovery
   * plan (continue / retry / rerun / readonly_view) becomes available. Success
   * is never fabricated and nothing is auto-replayed.
   */
  initialize(): {
    seeded: boolean;
    interruptedRunsRecovered: number;
    interruptedTriggerPlansRecovered: number;
    /** Runs that received an H14 recovery marker (checkpoint store present). */
    interruptedRunsWithRecovery: number;
  } {
    if (!this.#store) {
      return { seeded: false, interruptedRunsRecovered: 0, interruptedTriggerPlansRecovered: 0, interruptedRunsWithRecovery: 0 };
    }
    let seeded = false;
    for (const definition of Object.values(WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS)) {
      const expected = WORKFLOW_RUNTIME_BUILTIN_METADATA[definition.id]!;
      const existing = this.#store.getLatestRevision(definition.id);
      if (existing) {
        if (existing.revisionId !== expected.revisionId || existing.revision !== expected.revision || runtimeBuiltinChecksum(existing.definition) !== expected.checksum || JSON.stringify(existing.definition) !== JSON.stringify(definition) || existing.status !== "validated") {
          throw new WorkflowRuntimePersistenceError();
        }
        continue;
      }
      if (this.#store.definitionExists(definition.id)) throw new WorkflowRuntimePersistenceError();
      const validation = this.#compile(definition);
      if (!validation.ok) throw new WorkflowRuntimePersistenceError();
      this.#store.appendBuiltinRevision({
        definitionId: definition.id,
        definition,
        status: "validated",
        validationIssues: [],
        revisionId: expected.revisionId,
      });
      seeded = true;
    }
    let interruptedRunsRecovered = 0;
    let interruptedRunsWithRecovery = 0;
    if (this.#eventStore && this.#checkpointStore) {
      for (const runId of this.#store.listRunningRunIds()) {
        const record = this.#store.getRun(runId);
        if (!record || record.lifecycleState === "awaiting_input") continue;
        const finishedAt = new Date().toISOString();
        // ONE transaction, through the SAME terminal-write path every other
        // terminal transition uses: the honest failure and its ledger event are
        // both produced by the shared mapping. Wave 3 / R3: the reason is
        // `interrupted` (never `fatal_error` — nothing failed, the process
        // died) and it rides in `terminal_detail` because the 0027 CHECK
        // vocabulary cannot express it. Because this IS a terminal transition,
        // the H15 completion notification fires with that same authoritative
        // reason (task-10). If the write fails, the run row rolls back and
        // stays `running` — the next startup scan retries; no half state is
        // ever persisted.
        this.#recordRunTerminal({
          runId,
          lifecycleState: "failed",
          terminalReason: "interrupted",
          finishedAt,
          evidence: [],
          error: "run interrupted by API restart",
          payload: { reason: "interrupted", recoverable: true },
        });
        this.#checkpointStore.markInterrupted({
          runId,
          definitionId: record.definitionId,
          revisionId: record.revisionId,
          repository: record.repository,
          headSha: record.headSha,
        });
        interruptedRunsRecovered += 1;
        interruptedRunsWithRecovery += 1;
      }
    } else {
      interruptedRunsRecovered = this.#store.recoverInterruptedRuns();
    }
    const interruptedTriggerPlansRecovered = this.#store.recoverInterruptedTriggerPlans();
    return { seeded, interruptedRunsRecovered, interruptedTriggerPlansRecovered, interruptedRunsWithRecovery };
  }

  /** The fixed built-in definition + runtime registry truth (GET endpoint). */
  overview(): { definition: typeof VERIFIED_MINI_REVIEW_DEFINITION; nodeTypes: WorkflowRuntimeNodeType[] } {
    return { definition: VERIFIED_MINI_REVIEW_DEFINITION, nodeTypes: listWorkflowNodeTypes() };
  }

  // -------------------------------------------------------------------------
  // Definition lifecycle
  // -------------------------------------------------------------------------

  listDefinitions(): WorkflowRuntimeDefinitionSummary[] {
    return this.#persist().listDefinitions();
  }

  hasVerificationReceipt(definitionId: string, revisionId: string, checksum: string): boolean {
    const revision = this.#persist().getRevision(revisionId);
    return revision?.definitionId === definitionId && runtimeBuiltinChecksum(revision.definition) === checksum && this.#persist().getLatestVerificationReceipt(definitionId, revisionId, checksum) !== undefined;
  }

  getDefinitionRevision(definitionId: string, revisionId: string): WorkflowRuntimeDefinitionRevision {
    if (definitionId !== BUILTIN_DEFINITION_ID) {
      this.#requireDefinition(definitionId);
    }
    const revision = this.#persist().getRevision(revisionId);
    if (!revision || revision.definitionId !== definitionId) {
      throw new WorkflowDefinitionNotFoundError(`${definitionId}@${revisionId}`);
    }
    return revision;
  }

  /**
   * Append a new revision only after the complete runtime compiler passes.
   * Invalid schema, graph, registry, serviceRef, and parameter definitions are
   * rejected before any definition or revision row is created.
   */
  saveDefinition(input: {
    definitionId?: string;
    definition: WorkflowRuntimeDefinition;
  }): WorkflowRuntimeDefinitionRevision {
    const targetId = input.definitionId ?? input.definition.id;
    if (targetId === BUILTIN_DEFINITION_ID) {
      throw new WorkflowRuntimeStoreError("The built-in definition is immutable", "WORKFLOW_DEFINITION_IMMUTABLE", 409);
    }
    const compilation = this.#compile(input.definition);
    if (!compilation.ok || !compilation.definition) throw new WorkflowDefinitionInvalidError(compilation.errors);
    return this.#persist().appendRevision({
      definitionId: targetId,
      definition: compilation.definition,
      status: "validated",
      validationIssues: [],
    });
  }

  deleteDefinition(definitionId: string): { deleted: boolean } {
    if (definitionId === BUILTIN_DEFINITION_ID) {
      throw new WorkflowRuntimeStoreError("The built-in definition cannot be deleted", "WORKFLOW_DEFINITION_IMMUTABLE", 409);
    }
    return this.#persist().deleteDefinition(definitionId);
  }

  // -------------------------------------------------------------------------
  // Dry-load feasibility
  // -------------------------------------------------------------------------

  validate(definition: unknown): WorkflowCompilation {
    return this.#compile(definition);
  }

  dryLoad(definitionId: string, revisionId: string): WorkflowRuntimeDryLoadResult {
    const revision = this.getDefinitionRevision(definitionId, revisionId);
    const { result } = nodeFeasibility(revision.definition, this.#subflowResolver());
    return { ...result, revisionId: revision.revisionId };
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  listRuns(limit?: number): WorkflowRuntimeRunSummary[] {
    return this.#persist().listRuns(limit).map((run) => ({
      ...run,
      ...(run.error === undefined ? {} : { error: sanitizeExecutionError(run.error) }),
    }));
  }

  getRun(runId: string): WorkflowRuntimeRunV2 | undefined {
    const record = this.#persist().getRun(runId);
    if (!record) return undefined;
    // Wave 3 / R3: both API faces project a run through the SAME mapping. A
    // pre-0027 row has no refined lifecycle persisted, so the coarse status is
    // mapped through `projectRunTerminal` exactly like the events page does —
    // the two DTOs can never disagree about a terminal run.
    const lifecycleState = record.lifecycleState === undefined
      ? tryToExecutionLifecycleState(record.status)
      : tryToExecutionLifecycleState(record.lifecycleState);
    const terminalReason = record.terminalReason !== undefined && isTerminalReason(record.terminalReason)
      ? record.terminalReason
      : lifecycleState !== undefined && isTerminalExecutionLifecycleState(lifecycleState)
        ? projectRunTerminal({ lifecycleState }).terminalReason
        : undefined;
    return {
      runId: record.runId,
      definitionId: record.definitionId,
      revisionId: record.revisionId,
      origin: record.origin,
      status: record.status,
      createdAt: record.createdAt,
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      snapshot: { repository: record.repository, headSha: record.headSha },
      evidence: record.evidence as WorkflowRuntimeRunV2["evidence"],
      ...(record.miniReport === undefined ? {} : { miniReport: record.miniReport as WorkflowRuntimeRunV2["miniReport"] }),
      ...(record.error === undefined ? {} : { error: sanitizeExecutionError(record.error) }),
      ...(record.trigger === undefined ? {} : { trigger: record.trigger }),
      ...(lifecycleState === undefined ? {} : { lifecycleState: lifecycleState as WorkflowRuntimeRunV2["lifecycleState"] }),
      ...(terminalReason === undefined ? {} : { terminalReason: terminalReason as WorkflowRuntimeRunV2["terminalReason"] }),
      ...(record.coverage === undefined ? {} : { coverage: record.coverage as WorkflowRuntimeRunCoverage }),
      ...(lifecycleState === "awaiting_input"
        ? (() => {
            const stepId = this.#persist().pendingApprovalStepId(record.runId);
            return stepId === undefined ? {} : { awaitingApprovalStepId: stepId };
          })()
        : {}),
    };
  }

  /**
   * H12: whether the durable execution-event ledger is attached. False ⇒ the
   * events endpoints answer 503 (an absent ledger is an availability fact,
   * never an empty history).
   */
  runEventsAvailable(): boolean {
    return this.#eventStore !== null;
  }

  /**
   * H12: one authoritative, seq-ordered page of a run's persisted events
   * (snapshot + cursor resume). `after` (default 0) returns only events with
   * seq > after, capped at `limit` (bounded page); `total` counts the whole
   * ledger so clients can size follow-up pages; `terminal` reflects the RUN
   * row's persisted status — the only truthful source of "the run is over".
   * Unknown runs fail closed with the canonical 404; a known run with an
   * empty ledger is an explicit empty page (never an error).
   */
  getRunEventPage(
    runId: string,
    options: { readonly after?: number; readonly limit?: number } = {},
  ): {
    run: WorkflowRuntimeRunEventState;
    events: PersistedWorkflowRuntimeEvent[];
    nextSeq: number;
    hasMore: boolean;
    total: number;
    terminal: boolean;
  } {
    const record = this.#persist().getRun(runId);
    if (!record) {
      throw new WorkflowRuntimeStoreError("Workflow run not found", "WORKFLOW_RUN_NOT_FOUND", 404);
    }
    const eventStore = this.#eventStore;
    if (!eventStore) throw new WorkflowRuntimePersistenceError();

    const after = Math.max(0, Math.floor(options.after ?? 0));
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 200)), 500);
    const all = eventStore.listEvents(runId);
    const total = all.length;
    // The ledger is seq-ordered and seqs are dense (UNIQUE(run_id, seq),
    // max+1 allocation), so a slice preserves both order and continuity.
    const page = all.filter((event) => event.seq > after).slice(0, limit);
    const nextSeq = page.length > 0 ? page[page.length - 1]!.seq : after;

    const status = record.status;
    // H14/Wave 3 R3: prefer the persisted refined lifecycle (e.g. degraded,
    // cancelled, interrupted) when present; fall back to the coarse status
    // mapping for pre-0027 rows. Both branches go through the SAME shared
    // mapping the host wrote the row with (`projectRunTerminal`), so the event
    // page can never report a different terminal reason than the run row.
    const lifecycleState = record.lifecycleState === undefined
      ? tryToExecutionLifecycleState(status)
      : tryToExecutionLifecycleState(record.lifecycleState);
    const persistedReason = record.terminalReason;
    const terminalReason = persistedReason !== undefined && isTerminalReason(persistedReason)
      ? persistedReason
      : lifecycleState !== undefined && isTerminalExecutionLifecycleState(lifecycleState)
        ? projectRunTerminal({ lifecycleState }).terminalReason
        : undefined;
    const runLifecycleState = lifecycleState as WorkflowRuntimeRunEventState["lifecycleState"];
    return {
      run: {
        runId: record.runId,
        status,
        ...(runLifecycleState === undefined ? {} : { lifecycleState: runLifecycleState }),
        ...(terminalReason === undefined ? {} : { terminalReason }),
        ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      },
      events: page,
      nextSeq,
      hasMore: total > 0 && after + page.length < total,
      total,
      terminal: status === "succeeded" || status === "failed",
    };
  }

  /**
   * Trigger a run bound to a canonical repository, pinned to a specific
   * definition revision (built-in latest when omitted). Fails closed BEFORE
   * any Run record, snapshot, or authorization when anything is unresolvable.
   * The optional trigger context is observability provenance only — it never
   * widens what the run may do.
   */
  async trigger(
    input: WorkflowRuntimeTriggerRequestV2 & { trigger?: { source: "manual" | "repository_change"; eventId?: string } },
  ): Promise<{ runId: string; status: "running"; revisionId: string }> {
    // 1. Resolve + compile the definition revision (fail-closed first).
    let definition: WorkflowRuntimeDefinition;
    let revisionId: string;
    if (input.definitionId === undefined && input.revisionId === undefined) {
      definition = VERIFIED_MINI_REVIEW_DEFINITION;
      const latest = this.#store?.getLatestRevision(BUILTIN_DEFINITION_ID);
      if (!latest || latest.revisionId !== WORKFLOW_RUNTIME_BUILTIN_METADATA[BUILTIN_DEFINITION_ID]!.revisionId || runtimeBuiltinChecksum(latest.definition) !== WORKFLOW_RUNTIME_BUILTIN_METADATA[BUILTIN_DEFINITION_ID]!.checksum) {
        throw new WorkflowRuntimePersistenceError();
      }
      revisionId = latest.revisionId;
    } else {
      if (!input.definitionId || !input.revisionId) {
        throw new WorkflowDefinitionNotFoundError("definitionId and revisionId must be provided together");
      }
      const revision = this.getDefinitionRevision(input.definitionId, input.revisionId);
      if (revision.status !== "validated") {
        throw new WorkflowDefinitionNotExecutableError(
          "Workflow definition revision has validation issues and cannot execute (fail-closed)",
        );
      }
      definition = revision.definition;
      revisionId = revision.revisionId;
    }
    const compilation = this.#compile(definition);
    if (!compilation.ok || !compilation.plan) {
      throw new WorkflowDefinitionNotExecutableError(
        "Workflow definition failed to compile: " + compilation.errors.map((issue) => issue.code).join(", "),
      );
    }

    // 2. Resolve the repository (canonical snapshot wiring — unchanged).
    const resolution = this.#resolveRepository(input.repositoryId);
    if (resolution === undefined) {
      throw new WorkflowRepositoryNotFoundError(input.repositoryId);
    }
    if (resolution.status !== "ok") {
      throw new WorkflowSnapshotUnavailableError(resolution.reason);
    }
    const binding = resolution.binding;
    const repository = binding.remoteFullName ?? binding.displayName;

    let headSha: string | undefined;
    try {
      const adapter = new LocalGitAdapter({ root: binding.localPath });
      headSha = await adapter.getHeadSha();
    } catch {
      throw new WorkflowSnapshotUnavailableError("unable to read the repository HEAD");
    }
    if (headSha === undefined) {
      throw new WorkflowSnapshotUnavailableError("repository has no commits to pin");
    }

    let snapshot: RepositorySnapshot;
    let paths: string[];
    let coverage: WorkflowRuntimeRunCoverage;
    try {
      snapshot = RepositorySnapshot.create({ repositoryPath: binding.localPath, repository, headSha });
      // H17: the explicit, quota-bounded selection plan — omitted files are
      // DISCLOSED on the run (never silently dropped), and the selected files
      // are grouped into deterministic batches for the analyzer.
      const selection = planAnalysisSelection(snapshot.listFiles(), { quota: ANALYSIS_FILE_QUOTA, batchSize: ANALYSIS_BATCH_SIZE });
      paths = [...selection.selectedPaths];
      coverage = selection.coverage;
    } catch {
      throw new WorkflowSnapshotUnavailableError("repository snapshot is unavailable (git objects for HEAD are not readable)");
    }
    if (paths.length === 0) {
      throw new WorkflowSnapshotUnavailableError("repository HEAD contains no analyzable source files");
    }

    // H17 model gate: a plan whose registered nodes need the unified LLM
    // entry is refused BEFORE any run record exists when no configured
    // provider can be resolved — with the accurate reason, never a run that
    // fails later on a missing key.
    const needsModel = compilation.plan.agentSpecs.some(
      (spec) => getWorkflowServiceByRef(spec.serviceRef)?.kind === "llm-structured-verifier",
    );
    let llmEntry: WorkflowExecutorLlmEntry | undefined;
    if (needsModel) {
      llmEntry = await this.#requireModelBackend();
    }

    // 3. Persist the run record FIRST (status running), then execute. With an
    //    event ledger attached (H11) the insert and its run_started event are
    //    ONE transaction — a failed event write rolls the run row back.
    const runId = "wfrun_" + randomUUID();
    const createdAt = new Date().toISOString();
    const trigger = input.trigger ?? { source: "manual" };
    this.#recordRunStarted({
      runId,
      definitionId: definition.id,
      revisionId,
      origin: definition.id === BUILTIN_DEFINITION_ID ? "builtin" : "user",
      status: "running",
      repository,
      repositoryOpaqueId: input.repositoryId,
      headSha,
      createdAt,
      evidence: [],
      trigger,
      lifecycleState: "running",
      coverage,
    });

    const checkpointContext = {
      definitionId: definition.id,
      revisionId,
      repository,
      headSha,
      snapshotFingerprint: computeAnalysisFingerprint({ repository, headSha, paths }),
      definitionChecksum: runtimeBuiltinChecksum(definition),
    };

    void executeWorkflowPlan(
      compilation.plan,
      {
        repository,
        headSha,
        paths,
        snapshot,
        analysisBatchSize: coverage.batchSize,
      },
      this.#executionHooks(runId, checkpointContext, llmEntry),
    )
      .then((result) => {
        if (result.awaitingStepId) return; // gate already persisted the wait atomically
        this.#recordRunTerminal({
          runId,
          ...terminalFactsForExecutionResult(result),
          finishedAt: result.miniReport.finishedAt,
          evidence: evidenceSummaries(result.evidence),
          miniReport: result.miniReport,
          error: result.error,
        });
      })
      .catch((error: unknown) => {
        // Defensive: the executor returns failed results instead of throwing;
        // anything reaching here is a host-level defect and still fails closed.
        // Persistence itself may also be gone (e.g. shutdown) — never let the
        // fallback write throw unhandled.
        try {
          this.#recordRunTerminal({
            runId,
            lifecycleState: "failed",
            terminalReason: "fatal_error",
            finishedAt: new Date().toISOString(),
            evidence: [],
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Persistence unavailable during failure handling: nothing more we
          // can honestly do in-process (the durable row stays `running` and
          // is recovered at next startup; the transactional ledger likewise
          // never holds a terminal event without its run-state update).
        }
      });

    return { runId, status: "running", revisionId };
  }

  /** Restore only rows that still satisfy the node/envelope/schema contract. */
  #restoredSteps(checkpoint: CheckpointRecord | undefined): Map<string, WorkflowRestoredStepResult> {
    const restoredSteps = new Map<string, WorkflowRestoredStepResult>();
    for (const step of checkpoint?.steps ?? []) {
      if (step.corrupt) continue;
      const validation = validateCheckpointResult(step.nodeKind, step.serviceRef, step.result);
      if (!validation.ok) continue;
      restoredSteps.set(step.stepId, validation.envelope === "model-verdict"
        ? { outcome: "succeeded", modelVerdict: validation.modelVerdict }
        : { outcome: "succeeded", evidenceInputs: [...validation.evidenceInputs] });
    }
    return restoredSteps;
  }

  /**
   * H18: record one human decision and, only for a newly approved wait,
   * continue the SAME run. The store's lifecycle transition is the one-shot
   * dispatch claim. Rejection records the decision and fails closed without
   * dispatching; a repeat or restart cannot obtain another claim.
   */
  /** H19: an authenticated caller may append a bounded read-only verifier to an undispatched approval tail. */
  reviseWaitingPlan(input: WorkflowRuntimePlanRevisionRequest & { runId: string }): WorkflowRuntimePlanRevisionResponse {
    const revision = this.#persist().appendWaitingPlanRevision(input);
    return { runId: input.runId, revision: revision.revision, plan: revision.plan };
  }

  /** Revalidate stored graph against its pinned base before exposing it. */
  getWaitingPlanRevision(runId: string): WorkflowRuntimePlanRevisionResponse {
    const record = this.#persist().getRun(runId);
    if (!record) throw new WorkflowRuntimeStoreError("Workflow run not found", "WORKFLOW_RUN_NOT_FOUND", 404);
    const revision = this.#persist().getPlanRevision(runId);
    if (!revision) throw new WorkflowRuntimeStoreError("No runtime plan revision exists", "WORKFLOW_PLAN_REVISION_NOT_FOUND", 404);
    return { runId, revision: revision.revision, plan: revision.plan };
  }

  async decideApproval(input: {
    readonly runId: string;
    readonly stepId: string;
    readonly decision: "approved" | "rejected";
  }): Promise<{ readonly runId: string; readonly stepId: string; readonly decision: "approved" | "rejected"; readonly accepted: boolean }> {
    const persist = this.#persist();
    const record = persist.getRun(input.runId);
    if (!record) throw new WorkflowRuntimeStoreError("Workflow run not found", "WORKFLOW_RUN_NOT_FOUND", 404);
    const decided = persist.decideApproval(input);
    const revision = persist.getRevision(record.revisionId);
    if (!revision || revision.definitionId !== record.definitionId || revision.status !== "validated") {
      throw new WorkflowRuntimeStoreError("Approved workflow revision is no longer executable", "WORKFLOW_DEFINITION_NOT_EXECUTABLE", 409);
    }
    if (input.decision === "rejected") {
      this.#recordRunTerminal({
        runId: input.runId,
        lifecycleState: "failed",
        terminalReason: "user_cancelled",
        finishedAt: decided.decidedAt,
        evidence: [],
        error: `approval for step '${input.stepId}' was rejected; nothing was dispatched`,
      });
      return { runId: input.runId, stepId: input.stepId, decision: "rejected", accepted: true };
    }
    if (!persist.claimApprovedContinuation(input)) {
      return { runId: input.runId, stepId: input.stepId, decision: "approved", accepted: false };
    }
    await this.#resumeApprovedRun(record, input.stepId);
    return { runId: input.runId, stepId: input.stepId, decision: "approved", accepted: true };
  }

  /**
   * Continue an approved wait on its original run. Completed checkpoint rows
   * are restored; the approved step itself has no result yet and is dispatched
   * once. Repository, HEAD, definition, and checkpoint identity are rechecked
   * before any provider call.
   */
  async #resumeApprovedRun(record: NonNullable<ReturnType<WorkflowRuntimeStore["getRun"]>>, stepId: string): Promise<void> {
    const persist = this.#persist();
    const revision = persist.getRevision(record.revisionId)!;
    const compilation = this.#compile(revision.definition);
    if (!compilation.ok || !compilation.plan) {
      throw new WorkflowDefinitionNotExecutableError("Approved workflow revision no longer compiles");
    }
    const revised = persist.getPlanRevision(record.runId);
    const executionPlan = revised?.plan ?? compilation.plan;
    if (!executionPlan.agentSpecs.some((spec) => spec.nodeId === stepId && spec.approval !== undefined)) {
      throw new WorkflowRuntimeStoreError("Approved step is not an approval gate in the pinned revision", "WORKFLOW_APPROVAL_CONFLICT", 409);
    }
    const repositoryId = record.repositoryId;
    if (!repositoryId) throw new WorkflowRepositoryNotFoundError(record.runId);
    const resolution = this.#resolveRepository(repositoryId);
    if (resolution === undefined) throw new WorkflowRepositoryNotFoundError(repositoryId);
    if (resolution.status !== "ok") throw new WorkflowSnapshotUnavailableError(resolution.reason);
    const binding = resolution.binding;
    const repository = binding.remoteFullName ?? binding.displayName;
    if (repository !== record.repository) {
      throw new WorkflowSnapshotUnavailableError("repository identity changed while waiting for approval");
    }
    let headSha: string | undefined;
    try {
      headSha = await new LocalGitAdapter({ root: binding.localPath }).getHeadSha();
    } catch {
      throw new WorkflowSnapshotUnavailableError("unable to read the repository HEAD");
    }
    if (headSha !== record.headSha) {
      throw new WorkflowSnapshotUnavailableError("repository HEAD changed while waiting for approval");
    }
    const snapshot = RepositorySnapshot.create({ repositoryPath: binding.localPath, repository, headSha });
    const selection = planAnalysisSelection(snapshot.listFiles(), { quota: ANALYSIS_FILE_QUOTA, batchSize: ANALYSIS_BATCH_SIZE });
    const fingerprint = computeAnalysisFingerprint({ repository, headSha, paths: selection.selectedPaths });
    const checkpoint = this.#checkpointStore?.getCheckpoint(record.runId);
    if (checkpoint) {
      const mismatch = checkpointHeaderMismatch(checkpoint.header, record);
      if (mismatch !== undefined) throw new WorkflowRuntimeStoreError(`checkpoint identity is inconsistent: ${mismatch}`, "WORKFLOW_RECOVERY_BLOCKED", 409);
      if (checkpoint.header.snapshotFingerprint !== "" && checkpoint.header.snapshotFingerprint !== fingerprint) {
        throw new WorkflowRuntimeStoreError("analysis selection changed while waiting for approval", "WORKFLOW_RECOVERY_BLOCKED", 409);
      }
    }
    const needsModel = executionPlan.agentSpecs.some((spec) => getWorkflowServiceByRef(spec.serviceRef)?.kind === "llm-structured-verifier");
    const llmEntry = needsModel ? await this.#requireModelBackend() : undefined;
    const checkpointContext = {
      definitionId: record.definitionId,
      revisionId: record.revisionId,
      repository,
      headSha,
      snapshotFingerprint: fingerprint,
      definitionChecksum: runtimeBuiltinChecksum(revision.definition),
    };
    void executeWorkflowPlan(executionPlan, {
      repository, headSha, paths: selection.selectedPaths, snapshot,
      analysisBatchSize: selection.coverage.batchSize,
      resume: { restoredSteps: this.#restoredSteps(checkpoint) },
    }, this.#executionHooks(record.runId, checkpointContext, llmEntry))
      .then((result) => {
        if (result.awaitingStepId) return;
        this.#recordRunTerminal({
          runId: record.runId, ...terminalFactsForExecutionResult(result),
          finishedAt: result.miniReport.finishedAt, evidence: evidenceSummaries(result.evidence),
          miniReport: result.miniReport, error: result.error,
        });
      })
      .catch((error: unknown) => {
        try {
          this.#recordRunTerminal({
            runId: record.runId, lifecycleState: "failed", terminalReason: "fatal_error",
            finishedAt: new Date().toISOString(), evidence: [],
            error: error instanceof Error ? error.message : String(error),
          });
        } catch { /* durable row remains recoverable or terminal */ }
      });
  }

  /** Run insert + run_started event in ONE transaction (no ledger ⇒ insert only). */
  #recordRunStarted(input: PersistedRunInput & { repositoryOpaqueId?: string }): void {
    const persist = this.#persist();
    const eventStore = this.#eventStore;
    if (!eventStore) {
      persist.insertRun(input);
      return;
    }
    eventStore.recordEvent(
      {
        eventType: "run_started",
        runId: input.runId,
        correlationId: input.runId,
        payload: { trigger: input.trigger ?? { source: "manual" } },
      },
      { applyRunUpdate: () => persist.insertRun(input) },
    );
  }

  /**
   * H17: resolve the unified model entry ONCE per run — the accurate
   * no-key/no-provider reason surfaces HERE (before any run record), never
   * as a mid-run surprise.
   */
  async #requireModelBackend(): Promise<WorkflowExecutorLlmEntry> {
    if (!this.#modelBackendFactory) {
      throw new WorkflowRuntimeStoreError(
        "尚未配置大语言模型。该工作流包含结构化模型核验节点，需要先在设置页配置真实 LLM Provider 后才能执行。",
        "WORKFLOW_MODEL_NOT_CONFIGURED",
        409,
      );
    }
    try {
      return await this.#modelBackendFactory();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkflowRuntimeStoreError(message, "WORKFLOW_MODEL_NOT_CONFIGURED", 409);
    }
  }

  /**
   * THE terminal write (Wave 3 / R3): the run row and its terminal ledger
   * event are produced from ONE mapping — `projectRunTerminal` — inside ONE
   * transaction, so the persisted status/lifecycle/reason and the event's
   * toState/terminalReason can never disagree, and the coarse `status` column
   * is derived, never asserted separately.
   *
   * Replay semantics: repeating identical terminal facts is idempotent (no
   * second event, no rewritten row); a CONFLICTING verdict — e.g. a late
   * `succeeded` arriving after the startup scan already marked the run
   * interrupted — is refused with a typed 409, so a terminal state is never
   * reversed.
   */
  #recordRunTerminal(input: {
    runId: string;
    /** Authoritative refined lifecycle — drives both status and event type. */
    lifecycleState: ExecutionLifecycleState;
    /** Precise terminal reason; per-state default from the shared mapping. */
    terminalReason?: TerminalReason;
    finishedAt: string;
    evidence: unknown[];
    miniReport?: unknown;
    error?: string;
    /** Extra ledger payload for this terminal fact (e.g. the interruption
     * markers). Observability only — never execution authority. */
    payload?: Record<string, unknown>;
  }): void {
    const persist = this.#persist();
    const projection = projectRunTerminal({
      lifecycleState: input.lifecycleState,
      ...(input.terminalReason === undefined ? {} : { terminalReason: input.terminalReason }),
    });
    const terminal = {
      runId: input.runId,
      status: projection.status,
      finishedAt: input.finishedAt,
      evidence: input.evidence,
      lifecycleState: projection.lifecycleState,
      terminalReason: projection.terminalReason,
      ...(input.miniReport === undefined ? {} : { miniReport: input.miniReport }),
      ...(input.error === undefined ? {} : { error: input.error }),
    };
    const existing = persist.getRun(input.runId);
    if (!existing) {
      throw new WorkflowRuntimeStoreError("Workflow run not found for update", "WORKFLOW_RUN_NOT_FOUND", 404);
    }
    if (existing.status !== "running") {
      const sameFacts = existing.status === projection.status
        && existing.lifecycleState === projection.lifecycleState
        && existing.terminalReason === projection.terminalReason;
      if (sameFacts) return; // idempotent replay: the durable facts already say this
      throw new WorkflowRuntimeStoreError(
        `Workflow run already reached terminal state '${existing.status}'`
          + ` (lifecycle '${existing.lifecycleState ?? "unknown"}', reason '${existing.terminalReason ?? "unknown"}');`
          + ` a later '${projection.status}' verdict is refused — a terminal state is never reversed`,
        "WORKFLOW_RUN_TERMINAL_CONFLICT",
        409,
      );
    }
    const eventStore = this.#eventStore;
    if (!eventStore) {
      persist.updateRunTerminal(terminal);
    } else {
      const payload = {
        ...(input.payload ?? {}),
        // H17 honest degraded marker (kept from the pre-R3 payload contract).
        ...(projection.lifecycleState === "degraded" ? { degraded: true } : {}),
      };
      // The event carries the SAME authoritative triple as the row: an
      // interrupted/cancelled/degraded run reads back with its real reason
      // instead of a hardcoded failed/fatal_error.
      eventStore.recordEvent(
        {
          eventType: projection.eventType,
          runId: input.runId,
          correlationId: input.runId,
          fromState: "running",
          toState: projection.lifecycleState,
          terminalReason: projection.terminalReason,
          ...(input.error === undefined ? {} : { error: input.error }),
          ...(Object.keys(payload).length === 0 ? {} : { payload }),
        },
        { applyRunUpdate: () => persist.updateRunTerminal(terminal) },
      );
    }
    // H15: fired only AFTER the terminal state is durably persisted. The
    // completion sink is failure-contained by contract; the host defends
    // anyway — notification must never break run finalization.
    if (this.#onRunTerminal) {
      try {
        this.#onRunTerminal(terminal);
      } catch {
        // Reporting is observability, never execution authority.
      }
    }
  }

  /**
   * H11 + H14 execution hooks.
   *
   * Wave 3 / R1: these hooks are the REQUIRED-fact channel, not observability.
   * `step_started` (dispatch intent), `step_succeeded` / `step_failed`
   * (outcome) and a step's reusable-result checkpoint are facts recovery
   * depends on, so a failed persistence here is PROPAGATED to the executor —
   * which persists the intent before dispatch and fails closed when a required
   * write does not land. Nothing is silently swallowed any more: a hidden write
   * failure would let a paid call go out with no durable "sent" fact.
   */
  #executionHooks(
    runId: string,
    checkpointContext: {
      readonly definitionId: string;
      readonly revisionId: string;
      readonly repository: string;
      readonly headSha: string;
      readonly snapshotFingerprint: string;
      readonly definitionChecksum: string;
    },
    llmEntry?: WorkflowExecutorLlmEntry,
  ): WorkflowExecutorHooks {
    const eventStore = this.#eventStore;
    const checkpointStore = this.#checkpointStore;
    const stepSeqs = new Map<string, number>();
    const hooks: {
      onStepEvent?: WorkflowExecutorHooks["onStepEvent"];
      onStepCheckpoint?: WorkflowExecutorHooks["onStepCheckpoint"];
      llm?: WorkflowExecutorLlmEntry;
      maxConcurrency?: number;
      gateApproval?: WorkflowExecutorHooks["gateApproval"];
    } = {};
    if (eventStore) {
      hooks.onStepEvent = (event) => {
        // Deliberately uncaught: a failed required-fact write must reach the
        // executor (see WorkflowExecutorHooks.onStepEvent).
        const persisted = eventStore.recordEvent({
          eventType: event.eventType,
          runId,
          correlationId: runId,
          stepId: event.stepId,
          attemptNumber: event.attemptNumber,
          ...(event.error === undefined ? {} : { error: event.error }),
          ...(event.payload === undefined ? {} : { payload: event.payload }),
        });
        if (event.eventType === "step_succeeded") stepSeqs.set(event.stepId, persisted.seq);
      };
    }
    if (checkpointStore) {
      hooks.onStepCheckpoint = (fact) => {
        // Deliberately uncaught: the executor decides the failure policy by
        // node kind (a completed PAID call whose result is not durably
        // reusable degrades the run — it is never reported as safely
        // continuable). Swallowing here is what made that impossible to see.
        const evidenceFingerprints = (fact.evidenceInputs ?? []).map((input) => computeEvidenceFingerprint(input as EvidenceInput));
        const modelVerdictFingerprints = parseModelVerdictFingerprints(fact.modelVerdict);
        checkpointStore.recordStepResult({
          runId,
          definitionId: checkpointContext.definitionId,
          revisionId: checkpointContext.revisionId,
          repository: checkpointContext.repository,
          headSha: checkpointContext.headSha,
          snapshotFingerprint: checkpointContext.snapshotFingerprint,
          definitionChecksum: checkpointContext.definitionChecksum,
          step: {
            stepId: fact.stepId,
            serviceRef: fact.serviceRef,
            nodeKind: fact.nodeKind,
            ...(stepSeqs.get(fact.stepId) === undefined ? {} : { eventSeq: stepSeqs.get(fact.stepId) }),
            evidenceFingerprints: modelVerdictFingerprints.length > 0 ? modelVerdictFingerprints : evidenceFingerprints,
            result: checkpointEnvelopeFor(fact),
          },
        });
      };
    }
    if (llmEntry) hooks.llm = llmEntry;
    // H18: the operator-configured bounded dispatch width travels with the
    // hooks; the executor treats 1 as the unchanged serial order.
    hooks.maxConcurrency = this.#maxConcurrency;
    hooks.gateApproval = async (spec) => {
      const existing = this.#persist().getApproval(runId, spec.nodeId);
      if (existing) {
        // A stored approval is not itself a dispatch licence. Only the caller
        // that transactionally moved this run from awaiting_input back to
        // running may pass this gate, and it may do so exactly once.
        if (existing.decision === "rejected" || new Date().toISOString() > existing.expiresAt) return "rejected";
        return this.#persist().getRun(runId)?.lifecycleState === "running" ? "proceed" : "wait";
      }
      const expiresAt = new Date(Date.now() + spec.approval.ttlSeconds * 1000).toISOString();
      this.#persist().requestApprovalAndWait({ runId, stepId: spec.nodeId, expiresAt });
      return "wait";
    };
    return hooks;
  }

  #requireDefinition(definitionId: string): void {
    if (!this.#persist().definitionExists(definitionId)) {
      throw new WorkflowDefinitionNotFoundError(definitionId);
    }
  }

  // -------------------------------------------------------------------------
  // H14: checkpoint recovery — plan (pure read) + explicit actions
  // -------------------------------------------------------------------------

  /**
   * The honest recovery plan for one run, folded from DURABLE facts only:
   * the H11 execution-event ledger (step outcomes, including the critical
   * `outcome_unknown` for sent-but-unresulted tool calls) plus the checkpoint
   * store (reusable step results, or their corruption). Computing a plan
   * never executes anything.
   */
  getRunRecoveryPlan(runId: string): WorkflowRuntimeRecoveryPlan {
    const persist = this.#persist();
    const record = persist.getRun(runId);
    if (!record) {
      throw new WorkflowRuntimeStoreError("Workflow run not found", "WORKFLOW_RUN_NOT_FOUND", 404);
    }
    const checkpoint = this.#checkpointStore?.getCheckpoint(runId);
    const interrupted = checkpoint?.header.recoveryState === "interrupted";
    const folded = this.#foldRecoverySteps(runId, checkpoint);
    const steps = folded.steps;

    const blockers: WorkflowRuntimeRecoveryBlocker[] = [];
    // A revised in-run graph has no safe successor replay contract. Never
    // pretend the pinned base alone represents the executed graph.
    try {
      if (persist.getPlanRevision(runId)) {
        blockers.push({ code: "plan_revision_recovery_unsupported", message: "runtime-revised plan cannot be continued as a successor; inspect the ledger or explicitly rerun the pinned base" });
      }
    } catch {
      blockers.push({ code: "plan_revision_recovery_unsupported", message: "runtime plan revision is unreadable; no historical dispatch can be replayed" });
    }
    // Definition revision + checksum gates (config/plugin drift must name
    // itself instead of silently re-running on a different definition).
    const revision = persist.getRevision(record.revisionId);
    if (!revision || revision.definitionId !== record.definitionId) {
      blockers.push({
        code: "definition_revision_missing",
        message: `definition revision '${record.revisionId}' no longer exists; historical inputs cannot be re-validated`,
      });
    } else if (checkpoint && checkpoint.header.definitionChecksum !== "" && checkpoint.header.definitionChecksum !== runtimeBuiltinChecksum(revision.definition)) {
      blockers.push({
        code: "definition_checksum_changed",
        message: "the definition revision content changed since the run was recorded; reuse is refused",
      });
    }
    if (!checkpoint) {
      blockers.push({ code: "no_checkpoint", message: "no checkpoint was recorded for this run; there is nothing to resume from" });
    } else {
      // Wave 3 / R2: the checkpoint must belong to THIS run's inputs before any
      // reuse claim is offered (definition / revision / repository / head).
      const headerMismatch = checkpointHeaderMismatch(checkpoint.header, record);
      if (headerMismatch !== undefined) {
        blockers.push({ code: "checkpoint_corrupt", message: `checkpoint identity is inconsistent: ${headerMismatch}` });
      }
    }
    for (const step of steps) {
      if (step.corrupt) {
        blockers.push({
          code: "checkpoint_corrupt",
          message: `checkpoint result for step '${step.stepId}' is not reusable: ${folded.invalidReasons.get(step.stepId) ?? "unreadable or inconsistent with its ledger facts"}`,
          stepId: step.stepId,
        });
      }
      if (step.outcome === "outcome_unknown") {
        blockers.push({
          code: "step_outcome_unknown",
          message: `step '${step.stepId}' dispatched a tool call whose result never arrived; blind replay is forbidden`,
          stepId: step.stepId,
        });
      } else if (step.outcome === "failed") {
        blockers.push({ code: "step_failed", message: `step '${step.stepId}' failed before the interruption`, stepId: step.stepId });
      } else if (step.nodeKind !== undefined && !READONLY_STEP_KINDS.has(step.nodeKind)) {
        blockers.push({
          code: "non_readonly_step_present",
          message: `step '${step.stepId}' has node kind '${step.nodeKind}' whose side effects are unknown; recovery stays blocked`,
          stepId: step.stepId,
        });
      } else if (
        step.outcome === "succeeded" && step.nodeKind === "llm-structured-verifier" && !step.reusable
      ) {
        blockers.push({
          code: "step_without_reusable_result",
          message: `step '${step.stepId}' completed a PAID model call but has no reusable checkpoint result; resuming would bill the call again`,
          stepId: step.stepId,
        });
      }
    }

    const continueBlockers = blockers.filter((blocker) => blocker.code !== "no_checkpoint" || steps.length === 0);
    const canContinue = interrupted
      && continueBlockers.every((blocker) => blocker.code !== "definition_revision_missing" && blocker.code !== "definition_checksum_changed")
      && blockers.every((blocker) =>
        blocker.code !== "step_outcome_unknown"
        && blocker.code !== "step_failed"
        && blocker.code !== "non_readonly_step_present"
        && blocker.code !== "checkpoint_corrupt"
        && blocker.code !== "step_without_reusable_result"
        && blocker.code !== "plan_revision_recovery_unsupported");
    const repositoryResolvable = record.repositoryId !== undefined && record.repositoryId !== null && record.repositoryId !== "";
    const definitionResolvable = !blockers.some((blocker) => blocker.code === "definition_revision_missing" || blocker.code === "definition_checksum_changed");

    return {
      runId: record.runId,
      definitionId: record.definitionId,
      revisionId: record.revisionId,
      status: record.status,
      interrupted,
      repository: record.repository,
      headSha: record.headSha,
      steps,
      actions: [
        {
          action: "continue" as const,
          available: canContinue,
          ...(canContinue
            ? { reason: "resume as a successor run reusing every completed read-only step result (a completed model call is never billed twice)", blockers: [] }
            : { reason: interrupted ? "blocked by the run's recovery blockers" : "the run was not interrupted by a restart", blockers: canContinue ? [] : continueBlockers }),
        },
        {
          action: "retry" as const,
          available: false,
          reason: "framework only in this ticket: idempotent-write recovery is not executable; steps with sent-but-unresulted tool calls stay blocked (no blind replay)",
          blockers: blockers.filter((blocker) => blocker.code === "step_outcome_unknown" || blocker.code === "step_failed"),
        },
        {
          action: "rerun" as const,
          available: interrupted && definitionResolvable && repositoryResolvable,
          ...(interrupted && definitionResolvable && repositoryResolvable
            ? { reason: "launch a fresh run of the same definition revision (no reuse of historical step results)", blockers: [] }
            : { reason: !repositoryResolvable ? "the run has no canonical repository binding to re-trigger" : interrupted ? "the definition revision is no longer resolvable" : "the run was not interrupted by a restart", blockers: definitionResolvable ? [] : blockers }),
        },
        {
          action: "readonly_view" as const,
          available: true,
          reason: "inspect the checkpoint and ledger facts without executing anything",
          blockers: [],
        },
      ],
      blockers,
      ...(checkpoint?.header.resumedFromRunId === undefined ? {} : { resumedFromRunId: checkpoint.header.resumedFromRunId }),
    };
  }

  /**
   * Fold the durable step facts of one run: ledger events give the outcome
   * (succeeded / failed / outcome_unknown), the checkpoint store gives
   * reusability. Pure read.
   *
   * Wave 3 / R2: a checkpoint row is only reusable when it CORRESPONDS to the
   * ledger facts it cites — the referenced seq must exist, belong to the same
   * step and be a `step_succeeded` fact, and a step the ledger recorded as
   * failed can never be reused. Every rejection reason is returned so the
   * recovery plan can name it in an explicit blocker.
   */
  #foldRecoverySteps(
    runId: string,
    checkpoint: CheckpointRecord | undefined,
  ): { steps: WorkflowRuntimeRecoveryStep[]; invalidReasons: ReadonlyMap<string, string> } {
    const events = this.#eventStore?.listEvents(runId) ?? [];
    const eventsBySeq = new Map(events.map((event) => [event.seq, event]));
    const stepIds: string[] = [];
    const byStep = new Map<string, { serviceRef?: string; started?: PersistedWorkflowRuntimeEvent; terminal?: PersistedWorkflowRuntimeEvent }>();
    for (const event of events) {
      if (!event.stepId) continue;
      let entry = byStep.get(event.stepId);
      if (!entry) {
        entry = {};
        byStep.set(event.stepId, entry);
        stepIds.push(event.stepId);
      }
      if (typeof event.payload.serviceRef === "string" && event.payload.serviceRef !== "") entry.serviceRef = event.payload.serviceRef;
      if (event.eventType === "step_started") entry.started = event;
      if (event.eventType === "step_succeeded" || event.eventType === "step_failed") entry.terminal = event;
    }
    const checkpointSteps = new Map(checkpoint?.steps.map((step) => [step.stepId, step]) ?? []);
    const invalidReasons = new Map<string, string>();
    const allStepIds = [...new Set([...stepIds, ...checkpointSteps.keys()])];
    const steps = allStepIds.map((stepId) => {
      const folded = byStep.get(stepId);
      const checkpointStep = checkpointSteps.get(stepId);
      // A later dispatch intent overrides an earlier success: its result is
      // unknown, even if an older checkpoint still exists for this step.
      const laterUnsettledDispatch = folded?.started !== undefined &&
        (folded.terminal === undefined || folded.started.seq > folded.terminal.seq);
      const outcome: WorkflowRuntimeRecoveryStep["outcome"] = laterUnsettledDispatch ? "outcome_unknown"
        : folded?.terminal?.eventType === "step_succeeded" ? "succeeded"
          : folded?.terminal?.eventType === "step_failed" ? "failed"
            : checkpointStep ? "succeeded" // legacy read-only checkpoint without a ledger
              : "outcome_unknown";
      // Correspondence gates (only meaningful when the row itself is readable).
      let correspondenceIssue: string | undefined;
      if (checkpointStep !== undefined && !checkpointStep.corrupt) {
        const citedSeq = checkpointStep.eventSeq;
        // A paid checkpoint is not a reusable licence without a durable,
        // corresponding success fact. In particular, a missing eventSeq must
        // not let a fabricated result override a started-but-unsettled call.
        if (checkpointStep.nodeKind === "llm-structured-verifier" && (citedSeq === undefined || events.length === 0)) {
          correspondenceIssue = "paid checkpoint has no corresponding durable step_succeeded ledger fact";
        } else if (citedSeq !== undefined && events.length > 0) {
          const referenced = eventsBySeq.get(citedSeq);
          if (!referenced) {
            correspondenceIssue = `checkpoint cites ledger seq ${citedSeq}, which does not exist for this run`;
          } else if (referenced.stepId !== stepId) {
            correspondenceIssue = `checkpoint cites ledger seq ${citedSeq}, which belongs to step '${referenced.stepId ?? "run-level"}'`;
          } else if (referenced.eventType !== "step_succeeded") {
            correspondenceIssue = `checkpoint cites ledger seq ${citedSeq} (${referenced.eventType}), not a step_succeeded fact`;
          }
        }
        if (correspondenceIssue === undefined && checkpointStep.nodeKind === "llm-structured-verifier" &&
            folded?.terminal?.seq !== citedSeq) {
          correspondenceIssue = "paid checkpoint does not cite the latest durable success of this step";
        }
        if (correspondenceIssue === undefined && checkpointStep.nodeKind === "llm-structured-verifier" &&
            (folded?.started === undefined || citedSeq === undefined || folded.started.seq >= citedSeq)) {
          correspondenceIssue = "paid checkpoint success has no earlier durable dispatch intent";
        }
        if (correspondenceIssue === undefined && laterUnsettledDispatch) {
          correspondenceIssue = "a later dispatch intent has no durable terminal outcome; the older checkpoint cannot authorize replay";
        }
        if (correspondenceIssue === undefined && folded?.terminal?.eventType === "step_failed") {
          correspondenceIssue = "the ledger records this step as failed while a reusable checkpoint result exists";
        }
      }
      const invalidReason = checkpointStep?.invalidReason ?? correspondenceIssue;
      const corrupt = (checkpointStep?.corrupt ?? false) || correspondenceIssue !== undefined;
      if (corrupt && invalidReason !== undefined) invalidReasons.set(stepId, invalidReason);
      const reusable = checkpointStep !== undefined && !corrupt;
      return {
        stepId,
        ...(folded?.serviceRef === undefined && checkpointStep === undefined ? {} : { serviceRef: folded?.serviceRef ?? checkpointStep!.serviceRef }),
        ...(checkpointStep === undefined
          ? (folded?.serviceRef === undefined ? {} : { nodeKind: getWorkflowServiceByRef(folded.serviceRef)?.kind })
          : { nodeKind: checkpointStep.nodeKind }),
        outcome,
        ...(folded?.terminal === undefined && folded?.started === undefined ? {} : { eventSeq: (folded.terminal ?? folded.started)!.seq }),
        evidenceFingerprints: [...(checkpointStep?.evidenceFingerprints ?? [])],
        reusable,
        corrupt,
      };
    });
    return { steps, invalidReasons };
  }

  /**
   * Execute one explicit recovery action. Every action re-validates its own
   * gates and fails closed with structured blockers — nothing is ever
   * auto-replayed, and a refused action leaves the run exactly as it was.
   */
  async executeRecovery(input: { readonly runId: string; readonly action: WorkflowRuntimeRecoveryAction }): Promise<{
    readonly action: WorkflowRuntimeRecoveryAction;
    readonly executed: boolean;
    readonly runId?: string;
    readonly resumedFromRunId?: string;
    readonly status?: string;
    readonly revisionId?: string;
    readonly message?: string;
    readonly blockers: WorkflowRuntimeRecoveryBlocker[];
  }> {
    const plan = this.getRunRecoveryPlan(input.runId);
    const availability = plan.actions.find((entry) => entry.action === input.action)!;
    switch (input.action) {
      case "readonly_view":
        return {
          action: "readonly_view",
          executed: true,
          message: plan.interrupted
            ? "read-only view: the plan above is the interrupted run's durable fact set"
            : "read-only view: this run has no recovery checkpoint (it was not interrupted by a restart)",
          blockers: plan.blockers,
        };
      case "retry":
        // Framework only: the action is LISTED (the plan above), but executing
        // it is refused — idempotent-write recovery is future work and steps
        // with unknown side effects must stay blocked.
        return {
          action: "retry",
          executed: false,
          message: "retry is not executable in this ticket: idempotent-write recovery is framework-only, and outcome_unknown steps are never blindly replayed",
          blockers: availability.blockers.length > 0 ? availability.blockers : plan.blockers,
        };
      case "rerun": {
        if (!availability.available) {
          throw new WorkflowRuntimeStoreError(
            "rerun is blocked: " + (availability.blockers.length > 0
              ? availability.blockers.map((blocker) => `${blocker.code} (${blocker.message})`).join("; ")
              : availability.reason ?? "preconditions unmet"),
            "WORKFLOW_RECOVERY_BLOCKED",
            409,
          );
        }
        const record = this.#persist().getRun(input.runId);
        if (!record?.repositoryId) {
          return {
            action: "rerun",
            executed: false,
            message: "the run has no canonical repository binding; trigger a fresh run manually",
            blockers: [{ code: "repository_binding_unknown", message: "run row carries no repository_id" }],
          };
        }
        const launched = await this.launchDefinitionRun({
          repositoryId: record.repositoryId,
          definitionId: record.definitionId,
          trigger: { source: "manual" },
        });
        return {
          action: "rerun",
          executed: true,
          runId: launched.runId,
          resumedFromRunId: input.runId,
          status: launched.status,
          revisionId: launched.revisionId,
          message: "fresh run launched from the same definition revision (no reuse of historical step results)",
          blockers: [],
        };
      }
      case "continue": {
        if (!availability.available) {
          throw new WorkflowRuntimeStoreError(
            "continue is blocked: " + (availability.blockers.length > 0
              ? availability.blockers.map((blocker) => `${blocker.code} (${blocker.message})`).join("; ")
              : availability.reason ?? "preconditions unmet"),
            "WORKFLOW_RECOVERY_BLOCKED",
            409,
          );
        }
        return this.#executeContinue(input.runId);
      }
    }
  }

  /**
   * `continue`: launch a SUCCESSOR run that restores every reusable
   * read-only step result. Gates (all fail-closed, in order):
   * definition revision + checksum → repository binding → HEAD unchanged →
   * snapshot readable → analysis selection identical → model gate.
   * A changed HEAD refuses reuse with an explicit reason — historical inputs
   * are never silently re-based onto new history.
   */
  async #executeContinue(runId: string): Promise<{
    readonly action: "continue";
    readonly executed: boolean;
    readonly runId?: string;
    readonly resumedFromRunId?: string;
    readonly status?: string;
    readonly revisionId?: string;
    readonly message?: string;
    readonly blockers: WorkflowRuntimeRecoveryBlocker[];
  }> {
    const persist = this.#persist();
    const record = persist.getRun(runId);
    if (!record) throw new WorkflowRuntimeStoreError("Workflow run not found", "WORKFLOW_RUN_NOT_FOUND", 404);
    // Fail closed even when a caller races or bypasses the read-only plan.
    if (persist.getPlanRevision(runId)) {
      refuseRecovery([{ code: "plan_revision_recovery_unsupported", message: "a revised runtime graph cannot be replayed as the pinned base" }]);
    }
    const checkpoint = this.#checkpointStore?.getCheckpoint(runId);
    if (!checkpoint || checkpoint.header.recoveryState !== "interrupted") {
      refuseRecovery([{ code: "no_checkpoint", message: "no interrupted-run checkpoint exists for this run" }]);
    }
    // 0. Wave 3 / R2: the checkpoint header must describe THIS run's inputs
    //    (definition / revision / repository / head) before anything is reused.
    const headerMismatch = checkpointHeaderMismatch(checkpoint!.header, record);
    if (headerMismatch !== undefined) {
      refuseRecovery([{ code: "checkpoint_corrupt", message: `checkpoint identity is inconsistent: ${headerMismatch}` }]);
    }
    // 1. Definition revision + checksum.
    const revision = persist.getRevision(record.revisionId);
    if (!revision || revision.definitionId !== record.definitionId) {
      refuseRecovery([{ code: "definition_revision_missing", message: `definition revision '${record.revisionId}' no longer exists` }]);
    }
    const definition = revision!.definition;
    const checksum = runtimeBuiltinChecksum(definition);
    if (checkpoint!.header.definitionChecksum !== "" && checkpoint!.header.definitionChecksum !== checksum) {
      refuseRecovery([{ code: "definition_checksum_changed", message: "the definition revision content changed since the interruption" }]);
    }
    const compilation = this.#compile(definition);
    if (!compilation.ok || !compilation.plan) {
      refuseRecovery([{ code: "definition_checksum_changed", message: "the definition revision no longer compiles (fail-closed)" }]);
    }
    // 2. Repository binding.
    if (!record.repositoryId) {
      refuseRecovery([{ code: "repository_binding_unknown", message: "run row carries no canonical repository binding" }]);
    }
    const resolution = this.#resolveRepository(record.repositoryId);
    if (resolution === undefined) {
      refuseRecovery([{ code: "repository_binding_unavailable", message: `repository binding '${record.repositoryId}' is unknown` }]);
    }
    if (resolution!.status !== "ok") {
      refuseRecovery([{ code: "repository_binding_unavailable", message: resolution!.reason }]);
    }
    const binding = resolution!.binding;
    const repository = binding.remoteFullName ?? binding.displayName;
    if (repository !== record.repository) {
      refuseRecovery([{ code: "repository_binding_unavailable", message: "the bound repository identity changed since the interruption" }]);
    }
    // 3. HEAD must be UNCHANGED — reuse is refused on any drift.
    let headSha: string | undefined;
    try {
      const adapter = new LocalGitAdapter({ root: binding.localPath });
      headSha = await adapter.getHeadSha();
    } catch {
      refuseRecovery([{ code: "snapshot_unavailable", message: "unable to read the repository HEAD" }]);
    }
    if (headSha !== record.headSha) {
      refuseRecovery([{
        code: "head_changed",
        message: `repository HEAD moved (${record.headSha.slice(0, 12)}… → ${String(headSha).slice(0, 12)}…); historical inputs cannot be reused — use rerun for a fresh run`,
      }]);
    }
    // 4. Snapshot readable + the analysis selection is IDENTICAL.
    let snapshot: RepositorySnapshot;
    try {
      snapshot = RepositorySnapshot.create({ repositoryPath: binding.localPath, repository, headSha: headSha! });
    } catch {
      refuseRecovery([{ code: "snapshot_unavailable", message: "repository snapshot is unavailable (git objects for HEAD are not readable)" }]);
    }
    const selection = planAnalysisSelection(snapshot.listFiles(), { quota: ANALYSIS_FILE_QUOTA, batchSize: ANALYSIS_BATCH_SIZE });
    const fingerprint = computeAnalysisFingerprint({ repository, headSha: headSha!, paths: selection.selectedPaths });
    if (checkpoint!.header.snapshotFingerprint !== "" && checkpoint!.header.snapshotFingerprint !== fingerprint) {
      refuseRecovery([{ code: "analysis_selection_changed", message: "the analysis selection for the pinned snapshot changed; historical step results cannot be re-validated" }]);
    }
    // 5. Model gate (same accurate refusal as the trigger path).
    const needsModel = compilation.plan!.agentSpecs.some(
      (spec) => getWorkflowServiceByRef(spec.serviceRef)?.kind === "llm-structured-verifier",
    );
    const llmEntry = needsModel ? await this.#requireModelBackend() : undefined;

    // 6. Re-validate every durable row through the shared checkpoint validator.
    //    A corrupt row is a blocker above; it is never silently re-executed.
    const restoredSteps = this.#restoredSteps(checkpoint);

    // 7. Atomically consume the interrupted-run claim BEFORE a successor or
    //    provider dispatch exists. The read-only plan is not authorization:
    //    two callers may both have seen it as available. On a lost claim or a
    //    crash after claiming, fail closed rather than replay a paid step.
    const finalPlan = this.getRunRecoveryPlan(runId);
    if (!finalPlan.actions.find((action) => action.action === "continue")?.available) {
      refuseRecovery(finalPlan.blockers.length > 0 ? finalPlan.blockers : [
        { code: "run_not_interrupted", message: "the recovery claim is no longer available" },
      ]);
    }
    if (!this.#checkpointStore!.claimInterruptedContinue(runId)) {
      refuseRecovery([{ code: "run_not_interrupted", message: "another caller already consumed this recovery claim" }]);
    }
    // A successor run may now be created exactly once for this predecessor.
    const successorRunId = "wfrun_" + randomUUID();
    const createdAt = new Date().toISOString();
    this.#recordRunStarted({
      runId: successorRunId,
      definitionId: record.definitionId,
      revisionId: record.revisionId,
      origin: record.origin,
      status: "running",
      repository,
      repositoryOpaqueId: record.repositoryId,
      headSha: headSha!,
      createdAt,
      evidence: [],
      trigger: { source: "manual" },
      lifecycleState: "running",
      ...(record.coverage === undefined ? {} : { coverage: record.coverage }),
    });
    const checkpointContext = {
      definitionId: record.definitionId,
      revisionId: record.revisionId,
      repository,
      headSha: headSha!,
      snapshotFingerprint: fingerprint,
      definitionChecksum: checksum,
    };
    // Persist the successor lineage eagerly so even a successor that crashes
    // before its first step result is traceable to the run it resumed.
    this.#checkpointStore?.ensureHeader({
      runId: successorRunId,
      definitionId: checkpointContext.definitionId,
      revisionId: checkpointContext.revisionId,
      repository: checkpointContext.repository,
      headSha: checkpointContext.headSha,
      snapshotFingerprint: fingerprint,
      definitionChecksum: checksum,
      resumedFromRunId: runId,
    });

    void executeWorkflowPlan(
      compilation.plan!,
      {
        repository,
        headSha: headSha!,
        paths: selection.selectedPaths,
        snapshot,
        analysisBatchSize: selection.coverage.batchSize,
        resume: { restoredSteps },
      },
      this.#executionHooks(successorRunId, checkpointContext, llmEntry),
    )
      .then((result) => {
        if (result.awaitingStepId) return; // gate persisted a nonterminal successor wait
        this.#recordRunTerminal({
          runId: successorRunId,
          ...terminalFactsForExecutionResult(result),
          finishedAt: result.miniReport.finishedAt,
          evidence: evidenceSummaries(result.evidence),
          miniReport: result.miniReport,
          error: result.error,
        });
      })
      .catch((error: unknown) => {
        try {
          this.#recordRunTerminal({
            runId: successorRunId,
            lifecycleState: "failed",
            terminalReason: "fatal_error",
            finishedAt: new Date().toISOString(),
            evidence: [],
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Persistence unavailable during failure handling: nothing more we
          // can honestly do in-process (recovered at next startup scan).
        }
      });

    return {
      action: "continue",
      executed: true,
      runId: successorRunId,
      resumedFromRunId: runId,
      status: "running",
      revisionId: record.revisionId,
      message: `successor run launched; ${restoredSteps.size} completed read-only step(s) restored from the checkpoint`,
      blockers: [],
    };
  }

  // -------------------------------------------------------------------------
  // Repository bindings (Phase 3)
  // -------------------------------------------------------------------------

  /** Bindings for a repository, with honest unavailable for deleted definitions. */
  listBindings(repositoryId: string) {
    this.#requireKnownRepository(repositoryId);
    return this.#persist().listBindings(repositoryId);
  }

  /** Idempotent enable/disable toggle (mode optional; absent keeps current). */
  setBinding(input: { repositoryId: string; definitionId: string; enabled: boolean; triggerMode?: "manual" | "on_change" }) {
    this.#requireKnownRepository(input.repositoryId);
    if (!this.#persist().definitionExists(input.definitionId)) {
      throw new WorkflowDefinitionNotFoundError(input.definitionId);
    }
    this.#persist().setBinding(input);
    return this.#persist().listBindings(input.repositoryId).find(
      (binding) => binding.definitionId === input.definitionId,
    )!;
  }

  /**
   * Binding-gated trigger from a repository context. Enforces, in order,
   * BEFORE any Run record / snapshot / authorization:
   *   1. binding exists          → else 404 WORKFLOW_BINDING_NOT_FOUND;
   *   2. binding enabled         → else 409 WORKFLOW_BINDING_DISABLED;
   *   3. definition still exists → else 404 WORKFLOW_DEFINITION_NOT_FOUND;
   *   4. latest VALIDATED revision resolves → else 409 not-executable.
   * Then reuses the canonical trigger path (D2). The HTTP route calls this
   * with manual provenance; the automatic executor calls it with the
   * repository_change event identity — the SAME gates apply to both.
   */
  async triggerBinding(
    input: { repositoryId: string; definitionId: string } & {
      trigger?: { source: "manual" | "repository_change"; eventId?: string };
    },
  ): Promise<{ runId: string; status: "running"; revisionId: string }> {
    this.#requireKnownRepository(input.repositoryId);
    const binding = this.#persist().getBinding(input.repositoryId, input.definitionId);
    if (!binding) {
      throw new WorkflowRuntimeStoreError("Workflow is not bound to this repository", "WORKFLOW_BINDING_NOT_FOUND", 404);
    }
    if (!binding.enabled) {
      throw new WorkflowRuntimeStoreError("Workflow binding is disabled for this repository", "WORKFLOW_BINDING_DISABLED", 409);
    }
    return this.launchDefinitionRun({
      repositoryId: input.repositoryId,
      definitionId: input.definitionId,
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
    });
  }

  /**
   * Internal launch entry shared by every intent carrier that has ALREADY
   * cleared its own intent gate (an enabled binding for triggerBinding; a
   * runtime-mapped automation for the audit run executor). Resolves the
   * definition gates — definition still exists → latest VALIDATED revision —
   * then reuses the canonical pinned-snapshot trigger path byte-for-byte.
   * Deliberately NOT an HTTP route: callers must prove their own intent.
   */
  async launchDefinitionRun(
    input: { repositoryId: string; definitionId: string } & {
      trigger?: { source: "manual" | "repository_change"; eventId?: string };
    },
  ): Promise<{ runId: string; status: "running"; revisionId: string }> {
    const revision = this.#persist().getLatestValidatedRevision(input.definitionId);
    if (!revision) {
      // Definition deleted (no revisions at all) or nothing validated.
      if (!this.#persist().definitionExists(input.definitionId)) {
        throw new WorkflowDefinitionNotFoundError(input.definitionId);
      }
      throw new WorkflowDefinitionNotExecutableError(
        "Workflow definition has no validated revision and cannot execute (fail-closed)",
      );
    }
    return this.trigger({
      repositoryId: input.repositoryId,
      definitionId: input.definitionId,
      revisionId: revision.revisionId,
      trigger: input.trigger ?? { source: "manual" },
    });
  }

  /** Per-repository run history (canonical opaque-id join). */
  listRunsForRepository(repositoryId: string, limit?: number) {
    this.#requireKnownRepository(repositoryId);
    return this.#persist().listRunsForRepository(repositoryId, limit).map((run) => ({
      ...run,
      ...(run.error === undefined ? {} : { error: sanitizeExecutionError(run.error) }),
    }));
  }

  #requireKnownRepository(repositoryId: string): void {
    // Unknown id → canonical 404 semantics; known-but-unbindable repositories
    // may hold bindings (data) — triggering still fails closed at the snapshot.
    if (this.#resolveRepository(repositoryId) === undefined) {
      throw new WorkflowRepositoryNotFoundError(repositoryId);
    }
  }
}

export type { WorkflowRuntimeStore, WorkflowRuntimeStoreError };
export { WorkflowRuntimeEventStore };
