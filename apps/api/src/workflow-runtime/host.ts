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
 * Invariants carried over unchanged:
 *   - capability set repo.read / evidence.read / evidence.write;
 *   - per-syscall Kernel authorization (compile/dry-load grant nothing);
 *   - snapshot = canonical RepositorySnapshot only (no third representation);
 *   - definitions and plans are DATA, never execution authority.
 */

import { randomUUID } from "node:crypto";
import {
  type WorkflowRuntimeDefinition,
  type WorkflowRuntimeDefinitionRevision,
  type WorkflowRuntimeDefinitionSummary,
  type WorkflowRuntimeDryLoadResult,
  type WorkflowRuntimeNodeFeasibility,
  type WorkflowRuntimeNodeType,
  type WorkflowRuntimeRun,
  type WorkflowRuntimeRunSummary,
  type WorkflowRuntimeRunV2,
  type WorkflowRuntimeTriggerRequestV2,
  type WorkflowRuntimeValidationIssue,
} from "@consistency/schema";
import type { EvidenceSnapshot } from "@consistency/kernel";
import { RepositorySnapshot } from "@consistency/repository";
import { LocalGitAdapter } from "@consistency/vcs-core";
import { detectLanguage } from "@consistency/plugins-builtin";
import {
  VERIFIED_MINI_REVIEW_DEFINITION,
  WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS,
  WORKFLOW_RUNTIME_BUILTIN_METADATA,
  runtimeBuiltinChecksum,
} from "./definition";
import { compileWorkflowRuntimeDefinition } from "./compile";
import { listWorkflowNodeTypes, getWorkflowNodeService, isRegisteredSyscallAction, AVAILABLE_WORKFLOW_SERVICES } from "./registry";
import { executeWorkflowPlan } from "./executor";
import { sanitizeExecutionError } from "../security/redact";
import { WorkflowRuntimeStore, WorkflowRuntimeStoreError } from "./store";

/** Deterministic, bounded file selection for the mini-review slice. */
const MAX_ANALYSIS_FILES = 10;
export const BUILTIN_DEFINITION_ID = VERIFIED_MINI_REVIEW_DEFINITION.id;

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
  return files
    .filter((path) => detectLanguage(path) !== undefined)
    .sort()
    .slice(0, MAX_ANALYSIS_FILES);
}

/**
 * Dry-load per-node feasibility derived PURELY from compile-equivalent
 * registry lookups (single source of truth — same functions compile.ts uses).
 */
function nodeFeasibility(definition: WorkflowRuntimeDefinition): {
  result: WorkflowRuntimeDryLoadResult;
  executable: boolean;
} {
  // Compile exactly once. Canonical validation issues are then attributed to
  // their node, while dry-load adds only the feasibility-specific flags/issues.
  const compilation = compileWorkflowRuntimeDefinition(definition);
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

  constructor(options: {
    readonly resolveRepository?: WorkflowRepositoryResolver;
    readonly store?: WorkflowRuntimeStore | null;
    readonly maxCompletedRuns?: number;
  } = {}) {
    this.#resolveRepository = options.resolveRepository ?? (() => undefined);
    this.#store = options.store ?? null;
  }

  #persist(): WorkflowRuntimeStore {
    if (!this.#store) throw new WorkflowRuntimePersistenceError();
    return this.#store;
  }

  /**
   * Idempotently seed the immutable builtin definition (revision 1) and
   * honestly recover runs + trigger plans interrupted by a previous shutdown.
   * Called once at server startup; safe to call again.
   */
  initialize(): { seeded: boolean; interruptedRunsRecovered: number; interruptedTriggerPlansRecovered: number } {
    if (!this.#store) return { seeded: false, interruptedRunsRecovered: 0, interruptedTriggerPlansRecovered: 0 };
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
      const validation = compileWorkflowRuntimeDefinition(definition);
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
    const interruptedRunsRecovered = this.#store.recoverInterruptedRuns();
    const interruptedTriggerPlansRecovered = this.#store.recoverInterruptedTriggerPlans();
    return { seeded, interruptedRunsRecovered, interruptedTriggerPlansRecovered };
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
    const compilation = compileWorkflowRuntimeDefinition(input.definition);
    if (!compilation.ok) throw new WorkflowDefinitionInvalidError(compilation.errors);
    return this.#persist().appendRevision({
      definitionId: targetId,
      definition: input.definition,
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

  dryLoad(definitionId: string, revisionId: string): WorkflowRuntimeDryLoadResult {
    const revision = this.getDefinitionRevision(definitionId, revisionId);
    const { result } = nodeFeasibility(revision.definition);
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
    const compilation = compileWorkflowRuntimeDefinition(definition);
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
    try {
      snapshot = RepositorySnapshot.create({ repositoryPath: binding.localPath, repository, headSha });
      paths = selectAnalysisPaths(snapshot.listFiles());
    } catch {
      throw new WorkflowSnapshotUnavailableError("repository snapshot is unavailable (git objects for HEAD are not readable)");
    }
    if (paths.length === 0) {
      throw new WorkflowSnapshotUnavailableError("repository HEAD contains no analyzable source files");
    }

    // 3. Persist the run record FIRST (status running), then execute.
    const runId = "wfrun_" + randomUUID();
    const createdAt = new Date().toISOString();
    this.#persist().insertRun({
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
      trigger: input.trigger ?? { source: "manual" },
    });

    void executeWorkflowPlan(compilation.plan, {
      repository,
      headSha,
      paths,
      snapshot,
    })
      .then((result) => {
        this.#persist().updateRunTerminal({
          runId,
          status: result.status,
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
          this.#persist().updateRunTerminal({
            runId,
            status: "failed",
            finishedAt: new Date().toISOString(),
            evidence: [],
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Persistence unavailable during failure handling: nothing more we
          // can honestly do in-process (the durable row stays `running` and
          // is recovered at next startup).
        }
      });

    return { runId, status: "running", revisionId };
  }

  #requireDefinition(definitionId: string): void {
    if (!this.#persist().definitionExists(definitionId)) {
      throw new WorkflowDefinitionNotFoundError(definitionId);
    }
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
