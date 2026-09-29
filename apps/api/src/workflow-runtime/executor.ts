/**
 * Workflow Runtime executor — runs a compiled ExecutablePlan on the SAME
 * Kernel/Harness primitives the authoritative review runtime uses
 * (ReviewWorkload). The workflow layer only TRIGGERS and DESCRIBES; all
 * execution authority stays where it belongs:
 *
 *   - Run/ACB creation: KernelScheduler.registerRun/registerAgent (Kernel API)
 *   - admission/concurrency/priority: KernelScheduler ONLY
 *   - per-syscall authorization: CapabilityBroker via SyscallGateway (DENY
 *     before handler; revoked capability ⇒ next syscall denied)
 *   - Fiber lifecycle: Cordis via SchedulerAgentBridge (agent-scoped isolate)
 *   - context: ContextManager images with per-agent copy-on-write forks
 *     (context images, NOT processes — see ContextManager.fork)
 *
 * Failure policy is fail-closed everywhere: invalid/failed nodes never fake
 * success, evidence is never invented, and a verifier never runs without
 * persisted evidence.
 *
 * H17: node dispatch is REGISTRY-DRIVEN. Each plan agent resolves its
 * registered descriptor (Node Registry) and dispatches on the descriptor's
 * `kind` — there is no per-serviceRef hardcoding left, so a newly registered
 * node kind executes without touching the dispatch loop. The two H17 kinds:
 *
 *   - readonly-tool (`pinned-file-context.tool`): bounded read-only excerpts
 *     from the pinned snapshot via repo.read syscalls.
 *   - llm-structured-verifier (`model-structured.verifier`): ONE strict-schema
 *     model invocation through the unified LLM entry (H08 provider behind the
 *     Kernel llm.invoke facade — a node NEVER constructs a provider). Model
 *     output is validated against `workflowModelVerificationSchema` and every
 *     verdict must reference a persisted evidence FINGERPRINT; bad JSON,
 *     provider failure, or ungrounded verdicts yield an explainable DEGRADED
 *     outcome (deterministic findings survive untouched) — never a fabricated
 *     verification.
 *
 * H14: completed READ-ONLY steps may be restored from the checkpoint store
 * (`input.resume.restoredSteps`) so a restarted successor run reuses them —
 * a completed model call is never billed twice. The run-scoped AbortSignal is
 * wired to the scheduler's H13 cancellation (one causal id rides the abort
 * reason), so cancelRun reaches the provider transport mid-call.
 */

import { Context } from "cordis";
import {
  CapabilityBroker,
  CapabilityChangeBus,
  ContextManager,
  EvidenceStore,
  KernelScheduler,
  MemoryJournal,
  SchedulerEventBus,
  SyscallGateway,
  asAgentId,
  asRunId,
  auditFingerprint,
  computeEvidenceFingerprint,
  makePrincipalId,
  type AgentState,
  type AuditEvent,
  type CapabilityHandle,
  type CapabilityRef,
  type ContextImageId,
  type EvidenceInput,
  type EvidenceResource,
  type EvidenceSnapshot,
  type LLMResource,
  type Principal,
  type RepositoryResource,
  type RunId,
} from "@consistency/kernel";
import { SchedulerAgentBridge } from "@consistency/harness-core";
import type { Action } from "@consistency/kernel";
import {
  CapabilityBoundEvidenceFacade,
  CapabilityBoundLLMFacade,
  CapabilityBoundRepoFacade,
  DeterministicEvidenceRunner,
  redactModelVisibleText,
  type TrustedLLMBackend,
} from "@consistency/workload-review";
import type { TokenUsage } from "@consistency/schema";
import {
  workflowModelVerificationSchema,
  type WorkflowModelVerification,
  type WorkflowNodeKind,
  type WorkflowRuntimeFinding,
  type WorkflowRuntimeMiniReport,
} from "@consistency/schema";
import type {
  WorkflowRuntimeAgentSummary,
  WorkflowRuntimeExecutablePlan,
} from "@consistency/schema";
import { getWorkflowServiceByRef } from "./registry";

/** SHA-pinned read surface the executor is allowed to hand to facades. */
export interface WorkflowPinnedSnapshot {
  readFile(path: string): { readonly path: string; readonly content: string; readonly contentHash: string };
}

/** H14: a checkpointed READ-ONLY step result a successor run restores. */
export interface WorkflowRestoredStepResult {
  readonly outcome: "succeeded";
  /** Analyzer kind: the evidence inputs the step produced (re-written, never re-analyzed). */
  readonly evidenceInputs?: readonly EvidenceInput[];
  /** Model-verify kind: the fingerprint-keyed verdict (re-applied, never re-billed). */
  readonly modelVerdict?: unknown;
}

export interface WorkflowSnapshotInput {
  readonly repository: string;
  readonly headSha: string;
  readonly paths: readonly string[];
  readonly snapshot: WorkflowPinnedSnapshot;
  /** H17: explicit deterministic batch size (default: one batch — unchanged). */
  readonly analysisBatchSize?: number;
  /** H14: restore completed read-only step results (continue recovery). */
  readonly resume?: { readonly restoredSteps: ReadonlyMap<string, WorkflowRestoredStepResult> };
}

/** What an agent body receives: facades ONLY — never raw store/snapshot/gateway. */
export interface WorkflowAgentFacades {
  readonly repo?: CapabilityBoundRepoFacade;
  /** Present when the node's descriptor grants an evidence.read/write capability. */
  readonly evidence?: CapabilityBoundEvidenceFacade;
  /** Present only when the node requires llm.invoke AND the host wired the unified entry. */
  readonly llm?: CapabilityBoundLLMFacade;
}

export interface WorkflowAgentAdmittedInfo {
  readonly nodeId: string;
  readonly serviceRef: string;
  readonly agentId: string;
  readonly fiberState: number;
  readonly facades: WorkflowAgentFacades;
  /** Kernel revocation of one of this agent's capabilities (tests/diagnostics). */
  readonly revoke: (action: string) => void;
}

export interface WorkflowRunCreatedInfo {
  readonly runKey: string;
  readonly runId: RunId;
  readonly scheduler: KernelScheduler;
  readonly contextManager: ContextManager;
  readonly broker: CapabilityBroker;
  readonly evidenceStore: EvidenceStore;
  readonly journal: MemoryJournal;
  /** H13/H17: run-scoped cancellation signal (aborts with the H13 cancelId). */
  readonly signal: AbortSignal;
}

/**
 * H11 step-level lifecycle fact emitted by the executor. H18 bounded retries
 * may produce multiple attempts for eligible deterministic/read-only nodes;
 * paid model dispatch is limited to one attempt after an ambiguous outcome.
 * Run-level facts (run_started / run_succeeded / run_failed) are NOT emitted
 * here — they are recorded by the host transactionally with the run-state
 * updates they belong to.
 */
export interface WorkflowExecutorStepEvent {
  readonly eventType: "step_started" | "step_succeeded" | "step_failed";
  readonly stepId: string;
  readonly attemptNumber: number;
  readonly error?: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * H14 checkpoint fact: the reusable result of a COMPLETED read-only step.
 * Fired after the step_succeeded event; the host persists it through the
 * checkpoint store (idempotent UPSERT keyed by run + step).
 */
export interface WorkflowExecutorStepCheckpointFact {
  readonly stepId: string;
  readonly serviceRef: string;
  readonly nodeKind: WorkflowNodeKind;
  readonly evidenceInputs?: readonly EvidenceInput[];
  readonly modelVerdict?: unknown;
}

/** H17 unified LLM entry — the ONLY way a workflow node reaches a model. */
export interface WorkflowExecutorLlmEntry {
  /** Provider identity from the unified entry (H08) — resource label only. */
  readonly provider: string;
  /** Model the entry actually pins (observability; absent = runtime-picked). */
  readonly model?: string;
  /** Trusted backend below the Kernel gateway (never exposed to agents raw). */
  readonly backend: TrustedLLMBackend;
}

export interface WorkflowExecutorHooks {
  readonly onRunCreated?: (info: WorkflowRunCreatedInfo) => void | Promise<void>;
  readonly onAgentAdmitted?: (info: WorkflowAgentAdmittedInfo) => void | Promise<void>;
  /**
   * H11 REQUIRED step-fact channel (Wave 3 / R1) — fired synchronously at step
   * lifecycle boundaries and AWAITED by the executor before anything protected
   * happens. `step_started` is the dispatch INTENT, `step_succeeded` /
   * `step_failed` are the OUTCOME: recovery folds exactly these facts, so a
   * failed write is NOT observability noise and must propagate:
   *   - an intent write that throws ⇒ the node body is never dispatched (zero
   *     provider/tool calls) and the step fails deterministically;
   *   - an outcome write that throws ⇒ the run fails closed instead of
   *     claiming a durable outcome it does not have.
   */
  readonly onStepEvent?: (event: WorkflowExecutorStepEvent) => void | Promise<void>;
  /**
   * H14 REQUIRED reusable-result channel — fired after step_succeeded for a
   * step that produced a reusable result, and AWAITED. A throwing write means
   * the result is not durably reusable: the paid model call happened, so the
   * run degrades with `degradedCause: "result_not_persisted"` (never reported
   * as safely continuable) while free deterministic steps simply stay
   * non-reusable.
   */
  readonly onStepCheckpoint?: (fact: WorkflowExecutorStepCheckpointFact) => void | Promise<void>;
  /** H17 unified model entry (H08 provider behind the Kernel facade). */
  readonly llm?: WorkflowExecutorLlmEntry;
  /**
   * H18: bounded dispatch width for DEPENDENCY-READY execution. `1` (default)
   * keeps the historical strictly-serial order. A larger value starts an agent
   * as soon as every node it depends on has SETTLED, up to this many agents in
   * flight at once; fan-in stays deterministic because findings, agent
   * summaries and evidence are folded back in TOPOLOGICAL order, never in
   * completion order. The KernelScheduler's `maxRunningAgents` is set from the
   * same bound, so admission (not the loop) remains the concurrency authority.
   */
  readonly maxConcurrency?: number;
  /** H18: persist-then-decide gate. `wait` must not admit or dispatch. */
  readonly gateApproval?: (spec: {
    readonly nodeId: string;
    readonly approval: { readonly ttlSeconds: number };
  }) => Promise<"proceed" | "wait" | "rejected">;
}

export interface WorkflowExecutionResult {
  readonly runKey: string;
  readonly runId: RunId;
  /**
   * `degraded` (H17): the run completed and every reported finding is
   * evidence-grounded, but part of the planned verification did not fulfill
   * its contract (reason in `error` + miniReport). Honest middle ground —
   * never silently presented as a full success.
   */
  readonly status: "succeeded" | "failed" | "degraded" | "awaiting_input";
  readonly error?: string;
  /**
   * Wave 3 / R1(d): WHY the run degraded. `step_contract` = a step did not
   * fulfil its contract (the H17 coverage degradation); `result_not_persisted`
   * = a step succeeded but its reusable result is not durable (the host maps
   * that to the explicit `result_unavailable` terminal reason instead of
   * pretending the run can safely continue).
   */
  readonly degradedCause?: "step_contract" | "result_not_persisted";
  /** Set when a node is waiting for a human decision. The run is not terminal. */
  readonly awaitingStepId?: string;
  readonly miniReport: WorkflowRuntimeMiniReport;
  readonly evidence: readonly EvidenceSnapshot[];
  /** @internal diagnostics — the run's scheduler (tests / Task Manager). */
  readonly scheduler: KernelScheduler;
  readonly contextManager: ContextManager;
  readonly baseContextImage: ContextImageId;
  readonly agentContextImages: ReadonlyMap<string, ContextImageId>;
}

interface AgentRuntime {
  readonly nodeId: string;
  readonly serviceRef: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly acbId: ReturnType<typeof asAgentId>;
  readonly facades: WorkflowAgentFacades;
  readonly handles: Map<string, CapabilityHandle>;
  readonly fiber: ReturnType<SchedulerAgentBridge["attach"]>;
}

const KERNEL_PRINCIPAL = makePrincipalId("kernel", "workflow-runtime");

/** llm.invoke budget mirrors the review pipeline's per-agent bounded ledger. */
const WORKFLOW_LLM_TOKEN_BUDGET = 200_000;
const WORKFLOW_LLM_MAX_CALLS = 8;

/** H18: bounded rounds for a cooperative re-admission under a full slot budget. */
const MAX_RE_ADMIT_ROUNDS = 10_000;

/**
 * H18: cooperative re-admission after a node body yields (WAIT_* → READY).
 *
 * The Kernel Scheduler admits the highest-priority READY agent FIFO, so with a
 * dispatch width above 1 our own re-admission can come after a peer's. This
 * helper admits whatever the bound allows, yields once when the bound is
 * saturated by peers (their fibers progress on their own microtasks), and
 * returns false when the agent left the admissible states — the callers keep
 * their original "lost Scheduler admission" failure messages.
 */
async function reAdmitSelf(
  scheduler: KernelScheduler,
  acbId: AgentRuntime["acbId"],
  signal: AbortSignal,
): Promise<boolean> {
  for (let round = 0; round < MAX_RE_ADMIT_ROUNDS; round += 1) {
    const state = scheduler.getAgent(acbId)?.state;
    if (state === "RUNNING") return true;
    if (state !== "READY") return false;
    const admitted = scheduler.admit();
    if (admitted?.id === acbId) return true;
    if (signal.aborted) return false;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  return scheduler.getAgent(acbId)?.state === "RUNNING";
}

/**
 * H18: deterministic evidence order. A bounded-concurrency run writes evidence
 * in completion order; the report must still list it in TOPOLOGICAL order
 * (exactly what the serial run produced). Attributed records sort by their
 * producing node's plan order and their position within that node; anything
 * unattributed keeps its store order behind them.
 */
function orderEvidence(
  evidence: readonly EvidenceSnapshot[],
  order: ReadonlyMap<string, { readonly nodeOrder: number; readonly index: number }>,
): EvidenceSnapshot[] {
  return [...evidence].sort((left, right) => {
    const leftKey = order.get(left.fingerprint);
    const rightKey = order.get(right.fingerprint);
    if (leftKey === undefined && rightKey === undefined) return 0;
    if (leftKey === undefined) return 1;
    if (rightKey === undefined) return -1;
    return leftKey.nodeOrder - rightKey.nodeOrder || leftKey.index - rightKey.index;
  });
}

export async function executeWorkflowPlan(
  plan: WorkflowRuntimeExecutablePlan,
  input: WorkflowSnapshotInput,
  hooks: WorkflowExecutorHooks = {},
): Promise<WorkflowExecutionResult> {
  const runKey = plan.definitionId;
  const startedAt = new Date().toISOString();
  /** H18: deterministic topological plan order (never completion order). */
  const specs = [...plan.agentSpecs].sort((a, b) => a.order - b.order);
  /** H18: bounded dispatch width; 1 = the historical serial execution. */
  // Until a durable multi-branch pause/resume cursor exists, a human gate
  // cannot coexist with dispatched peers whose outcomes may still be unknown.
  const concurrency = specs.some((spec) => spec.approval !== undefined) ? 1 : Math.max(1, Math.min(
    Number.isFinite(hooks.maxConcurrency ?? 1) ? Math.floor(hooks.maxConcurrency ?? 1) : 1,
    Math.max(1, specs.length),
  ));

  // -------------------------------------------------------------------------
  // 1. Kernel foundations — identical wiring to the authoritative runtime.
  // -------------------------------------------------------------------------
  const journal = new MemoryJournal();
  const bus = new CapabilityChangeBus();
  const broker = new CapabilityBroker(journal, Date.now, bus);
  const gateway = new SyscallGateway(broker);
  const schedulerBus = new SchedulerEventBus();
  // H18: the Scheduler stays the concurrency AUTHORITY — its bound is the same
  // dispatch width, so a node can never be admitted beyond it.
  const scheduler = new KernelScheduler({ maxRunningAgents: concurrency }, { bus: schedulerBus });
  const contextManager = new ContextManager();
  const evidenceStore = new EvidenceStore();
  const bridge = new SchedulerAgentBridge(new Context(), scheduler);
  const runner = new DeterministicEvidenceRunner();
  const analyzeSnapshot = runner.run.bind(runner);
  const forkContextImage = contextManager.fork.bind(contextManager);

  const runId = asRunId("run_wf_" + runKey + "_" + Date.now());
  scheduler.registerRun({ id: runId });
  scheduler.activateRun(runId);

  // H13/H17: run-scoped cancellation. Any scheduler cancellation of THIS run
  // (run.cancelled / agent.cancelled — the scheduler is private to this run)
  // aborts the signal with the single causal id, so an in-flight model call
  // stops charging work immediately.
  const abortController = new AbortController();
  const unsubscribeSchedulerEvents = schedulerBus.subscribe((event) => {
    if ((event.type === "run.cancelled" || event.type === "agent.cancelled") && event.cancelId) {
      abortController.abort(new Error("run-cancelled (" + event.cancelId + ")"));
    }
  });

  const agentSummariesByNode = new Map<string, WorkflowRuntimeAgentSummary>();
  const agentContextImages = new Map<string, ContextImageId>();
  /** H17: primary output of completed steps, keyed by nodeId (in-memory, per run). */
  const stepOutputs = new Map<string, { readonly outputSchema: string; readonly output: unknown }>();
  /** H18: findings per node, folded in topological order AFTER the run. */
  const nodeFindings = new Map<string, readonly WorkflowRuntimeFinding[]>();
  /** H18: which node produced each evidence fingerprint (deterministic order). */
  const evidenceOrder = new Map<string, { readonly nodeOrder: number; readonly index: number }>();
  const orderedAgentSummaries = (): WorkflowRuntimeAgentSummary[] =>
    specs.map((spec) => agentSummariesByNode.get(spec.nodeId)).filter((entry): entry is WorkflowRuntimeAgentSummary => entry !== undefined);
  let baseImage: ContextImageId;

  const buildReport = (
    status: WorkflowRuntimeMiniReport["status"],
    findings: WorkflowRuntimeFinding[],
    error?: string,
  ): WorkflowRuntimeMiniReport => {
    const syscalls = journal
      .entries()
      .filter((event): event is Extract<AuditEvent, { type: "syscall.authorised" }> => event.type === "syscall.authorised");
    return {
      definitionId: plan.definitionId,
      runId: String(runId),
      status,
      repository: input.repository,
      headSha: input.headSha,
      startedAt,
      finishedAt: new Date().toISOString(),
      evidenceCount: evidenceStore.list().length,
      verifiedEvidenceCount: status === "failed" ? 0 : findings.length,
      findings,
      agents: orderedAgentSummaries(),
      audit: {
        allowed: syscalls.filter((event) => event.decision === "allow").length,
        denied: syscalls.filter((event) => event.decision === "deny").length,
      },
      ...(error === undefined ? {} : { error }),
    };
  };

  const failRun = (error: unknown): WorkflowExecutionResult => {
    const current = scheduler.getRun(runId);
    if (current && current.state !== "CANCELLED") {
      try {
        scheduler.failRun(runId);
      } catch {
        // Already terminal.
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      runKey,
      runId,
      status: "failed",
      error: message,
      miniReport: buildReport("failed", [], message),
      evidence: evidenceStore.list(),
      scheduler,
      contextManager,
      baseContextImage: baseImage!,
      agentContextImages,
    };
  };

  try {
    // -----------------------------------------------------------------------
    // 2. Base ContextImage (pinned policy/task pages) — materialize BEFORE
    //    any agent executes; failure here fails closed with zero syscalls.
    // -----------------------------------------------------------------------
    baseImage = contextManager.createImage();
    const policyPage = contextManager.createPage({
      kind: "policy",
      text: "Workflow " + plan.definitionId + ": read-only deterministic analysis. No repo write, no GitHub publish, no external mutation.",
      provenance: { producer: "workflow-runtime", producerVersion: "1.0.0" },
    });
    const taskPage = contextManager.createPage({
      kind: "task",
      text: "Pinned snapshot " + input.repository + " at " + input.headSha + "; files: " + input.paths.join(", "),
      provenance: { producer: "workflow-runtime", producerVersion: "1.0.0" },
    });
    contextManager.attach(baseImage, policyPage, "pinned");
    contextManager.attach(baseImage, taskPage, "pinned");
  } catch (error) {
    unsubscribeSchedulerEvents();
    const detail = error instanceof Error ? error.message : String(error);
    return failRun(new Error("context materialization failed: " + detail));
  }

  await hooks.onRunCreated?.({
    runKey,
    runId,
    scheduler,
    contextManager,
    broker,
    evidenceStore,
    journal,
    signal: abortController.signal,
  });

  // H17: findings accumulate from every node whose registered descriptor
  // declares the finding output contract; a later finding for the SAME
  // primary evidence refines (replaces) the earlier one — the topologically
  // later model verification refines deterministic verification for evidence
  // it confirmed, while refuted/unverified evidence keeps its deterministic
  // finding (a model verdict never silently suppresses deterministic work).
  const findingsByPrimaryEvidence = new Map<string, WorkflowRuntimeFinding>();
  const findingOrder: string[] = [];
  let degradedReason: string | undefined;
  /** Sticky binding cause: a non-durable reusable result outranks coverage. */
  let degradedCause: WorkflowExecutionResult["degradedCause"];

  try {
    // -----------------------------------------------------------------------
    // 3. H18 bounded, DEPENDENCY-READY dispatch. One agent per node: capability
    //    issue → facades → COW context fork → ACB → admission → fiber → body.
    //    An agent starts as soon as every node it depends on has SETTLED and a
    //    dispatch slot is free (at most `concurrency` agents in flight). All
    //    fan-in state (findings, agent summaries, evidence order) is folded in
    //    TOPOLOGICAL order after the loop, so a concurrent run is
    //    byte-identical to the serial one for the same facts.
    // -----------------------------------------------------------------------
    const settledNodes = new Set<string>();
    const inFlight = new Map<string, Promise<void>>();
    let failure: { readonly error: unknown } | undefined;

    const recordEvidenceOrder = (nodeOrder: number, inputs: readonly EvidenceInput[]): void => {
      inputs.forEach((evidenceInput, index) => {
        const fingerprint = computeEvidenceFingerprint(evidenceInput);
        if (!evidenceOrder.has(fingerprint)) evidenceOrder.set(fingerprint, { nodeOrder, index });
      });
    };

    let awaitingStepId: string | undefined;
    const runNode = async (spec: WorkflowRuntimeExecutablePlan["agentSpecs"][number]): Promise<void> => {
      // H13: a run cancelled while agents are still queued reports THAT
      // deterministically (with its single causal id) instead of surfacing
      // as a generic registration/admission failure.
      const pendingCancel = scheduler.getRunCancelCause(runId);
      if (pendingCancel) {
        throw new Error("run-cancelled (" + pendingCancel.cancelId + "): Scheduler cancelled the run before agent '" + spec.nodeId + "'");
      }
      // H18: skip a conditionally excluded node before requesting approval.
      // An absent field is an error (not an implicit skip).
      if (spec.when && !conditionMatches(stepOutputs.get(spec.when.source)?.output, spec.when)) {
        await hooks.onStepEvent?.({
          eventType: "step_succeeded",
          stepId: spec.nodeId,
          attemptNumber: 1,
          payload: { skipped: true, reason: "condition_not_matched" },
        });
        return;
      }
      if (spec.approval) {
        if (!hooks.gateApproval) {
          throw new Error("step '" + spec.nodeId + "' requires an approval gate before dispatch");
        }
        const gate = await hooks.gateApproval({ nodeId: spec.nodeId, approval: spec.approval });
        if (gate === "wait") {
          awaitingStepId = spec.nodeId;
          return;
        }
        if (gate !== "proceed") {
          throw new Error("step '" + spec.nodeId + "' approval was rejected; no side effect was executed");
        }
      }
      // H17: dispatch truth comes from the registry descriptor, not the
      // serviceRef string. An unregistered serviceRef can never dispatch.
      const descriptor = getWorkflowServiceByRef(spec.serviceRef);
      if (!descriptor) {
        throw new Error("no registered node descriptor for serviceRef '" + spec.serviceRef + "' (registry-driven dispatch)");
      }
      // Copy-on-write context fork per agent: private overlay over the pinned
      // base image (ContextManager image fork, not a process fork).
      const agentImage = forkContextImage(baseImage);
      agentContextImages.set(spec.nodeId, agentImage);

      const runtime = registerWorkflowAgent({
        scheduler,
        bridge,
        broker,
        gateway,
        runId,
        runKey,
        nodeId: spec.nodeId,
        serviceRef: spec.serviceRef,
        capabilityRequirements: spec.capabilityRequirements,
        repository: input.repository,
        snapshot: input.snapshot,
        evidenceStore,
        contextImage: agentImage,
        parameters: spec.parameters,
        llm: hooks.llm,
        signal: abortController.signal,
      });

      scheduler.ready(runtime.acbId);
      const admitted = scheduler.admit();
      if (!admitted || admitted.id !== runtime.acbId) {
        // Canonical admission-denied semantics: the agent stays READY (the
        // Scheduler has no DENIED state). No protected execution began.
        cleanupOnFailure(scheduler, runtime.acbId);
        agentSummariesByNode.set(spec.nodeId, agentSummary(runtime, scheduler));
        const state = scheduler.getAgent(runtime.acbId)?.state ?? "unknown";
        // H13: a run that was cancelled (single causal id) reports THAT
        // deterministically instead of a generic admission denial.
        const cancelCause = scheduler.getRunCancelCause(runId);
        if (cancelCause) {
          throw new Error("run-cancelled (" + cancelCause.cancelId + "): Scheduler cancelled the run before agent '" + spec.nodeId + "' admission");
        }
        throw new Error("admission-denied: Scheduler did not admit agent '" + spec.nodeId + "' (state " + state + ")");
      }
      await bridge.flush();

      await hooks.onAgentAdmitted?.({
        nodeId: spec.nodeId,
        serviceRef: spec.serviceRef,
        agentId: String(runtime.acbId),
        fiberState: runtime.fiber.fiber.state,
        facades: runtime.facades,
        revoke: (action) => {
          const handle = runtime.handles.get(action);
          if (handle) broker.revoke(handle, KERNEL_PRINCIPAL);
        },
      });

      const restored = input.resume?.restoredSteps.get(spec.nodeId);
      // A restored step already has a durable result. Never retry it.
      // A provider rejection does not establish whether the provider accepted
      // or billed the request. Never turn an ambiguous model outcome into an
      // automatic second paid dispatch, even if a bounded retry was configured.
      const maxAttempts = restored || descriptor.kind === "llm-structured-verifier"
        ? 1 : Math.min(3, Math.max(1, spec.retry?.maxAttempts ?? 1));
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // ---------------------------------------------------------------------
      // Wave 3 / R1: FLUSH-BEFORE-DISPATCH. The dispatch intent is a REQUIRED
      // durable fact: it is awaited BEFORE the node body runs, so a crash after
      // this point leaves a durable "sent" record and recovery folds the step
      // to outcome_unknown (blocked, never re-sent). A failed intent write
      // stops the step here — nothing protected is dispatched. A failed intent
      // is not retried: retrying would dispatch without a durable attempt.
      // ---------------------------------------------------------------------
      if (attempt > 1) {
        const current = scheduler.getAgent(runtime.acbId)?.state;
        if (current && current !== "RUNNING" && current !== "READY" && current !== "FAILED" && current !== "CANCELLED") {
          scheduler.wake(runtime.acbId);
        }
        if (scheduler.getAgent(runtime.acbId)?.state === "READY") {
          scheduler.admit();
        }
        await bridge.flush();
      }
      try {
        await hooks.onStepEvent?.({
          eventType: "step_started",
          stepId: spec.nodeId,
          attemptNumber: attempt,
          payload: {
            serviceRef: spec.serviceRef,
            agentId: String(runtime.acbId),
            ...(restored === undefined ? {} : { resumed: true }),
          },
        });
      } catch (error) {
        cleanupOnFailure(scheduler, runtime.acbId);
        agentSummariesByNode.set(spec.nodeId, agentSummary(runtime, scheduler));
        const detail = error instanceof Error ? error.message : String(error);
        const message = "step '" + spec.nodeId + "' dispatch intent could not be durably recorded ("
          + detail + "); nothing was dispatched and the run stops (zero provider/tool calls)";
        // The outcome is deterministic: the step failed without dispatching.
        // Best effort only — the same store may still be down, and the run-row
        // failure below is what must survive.
        try {
          await hooks.onStepEvent?.({ eventType: "step_failed", stepId: spec.nodeId, attemptNumber: attempt, error: message });
        } catch {
          // No durable outcome is possible; the run row still records the failure.
        }
        throw new Error(spec.nodeId + ": " + message);
      }

      try {
        const runOnFiber = runtime.fiber.execute;
        const result = await runOnFiber(() => dispatchNodeBody({
          runtime,
          scheduler,
          input,
          analyzer: { analyze: analyzeSnapshot },
          descriptor,
          priorOutputs: stepOutputs,
          signal: abortController.signal,
          ...(hooks.llm?.model === undefined ? {} : { llmModel: hooks.llm.model }),
          ...(restored === undefined ? {} : { restored }),
        }));
        if (result.degraded) {
          // H17 degraded step: the step did NOT fulfill its contract (honest
          // step_failed fact), but the run continues — deterministic work is
          // never discarded because an add-on verification failed.
          // The outcome fact is written FIRST and awaited: if it cannot be
          // persisted, the catch below fails the run closed instead of
          // continuing on an unrecorded step state.
          const retryableInvocation = result.degraded.reason.includes("invocation failed") && attempt < maxAttempts;
          await hooks.onStepEvent?.({
            eventType: "step_failed",
            stepId: spec.nodeId,
            attemptNumber: attempt,
            error: result.degraded.reason,
          });
          if (retryableInvocation) {
            continue;
          }
          cleanupOnFailure(scheduler, runtime.acbId);
          agentSummariesByNode.set(spec.nodeId, agentSummary(runtime, scheduler));
          degradedReason = result.degraded.reason;
          if (degradedCause === undefined) degradedCause = "step_contract";
          return;
        }
        if (result.findings && result.findings.length > 0) {
          // Buffered per node; folded into the report in TOPOLOGICAL order
          // after the loop (completion order must never leak into the report).
          nodeFindings.set(spec.nodeId, result.findings);
        }
        if (result.output !== undefined) {
          stepOutputs.set(spec.nodeId, { outputSchema: descriptor.outputSchema.name, output: result.output });
        }
        if (result.evidenceInputs !== undefined) {
          recordEvidenceOrder(spec.order, result.evidenceInputs);
        }
        scheduler.succeedAgent(runtime.acbId);
        agentSummariesByNode.set(spec.nodeId, agentSummary(runtime, scheduler));
        // REQUIRED outcome fact: awaited, and a failure FAILS THE RUN — an
        // unrecorded outcome would leave a started-without-terminal step that
        // no reader could distinguish from a healthy one.
        await hooks.onStepEvent?.({
          eventType: "step_succeeded",
          stepId: spec.nodeId,
          attemptNumber: attempt,
          payload: {
            ...(restored === undefined ? {} : { resumed: true }),
            ...(result.model === undefined ? {} : { model: result.model }),
            // Key deliberately named `usage`: the persistence sanitizer drops
            // credential-shaped keys (`token*`) before the ledger row lands.
            ...(result.usage === undefined ? {} : { usage: result.usage }),
            ...(result.evidenceInputs === undefined ? {} : { evidenceCount: result.evidenceInputs.length }),
          },
        });
        if (result.evidenceInputs !== undefined || result.modelVerdict !== undefined) {
          // REQUIRED reusable-result fact: awaited. A failed write must not be
          // mistaken for "no reuse needed" — see the degradation below.
          try {
            await hooks.onStepCheckpoint?.({
              stepId: spec.nodeId,
              serviceRef: spec.serviceRef,
              nodeKind: descriptor.kind,
              ...(result.evidenceInputs === undefined ? {} : { evidenceInputs: result.evidenceInputs }),
              ...(result.modelVerdict === undefined ? {} : { modelVerdict: result.modelVerdict }),
            });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const message = "step '" + spec.nodeId + "' completed but its reusable result could not be durably checkpointed ("
              + detail + "); the run is degraded and is NOT safely resumable";
            degradedReason = message;
            degradedCause = "result_not_persisted";
          }
        }
        // Settled. A later attempt would dispatch again and settle twice.
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = message.includes("run-cancelled") || message.includes("was cancelled");
        let outcomePersisted = false;
        try {
          await hooks.onStepEvent?.({
            eventType: "step_failed",
            stepId: spec.nodeId,
            attemptNumber: attempt,
            error: message,
          });
          outcomePersisted = true;
        } catch {
          // Started without a terminal fact. Do not retry: the result is unknown.
        }
        if (outcomePersisted && !cancelled && attempt < maxAttempts) {
          continue;
        }
        cleanupOnFailure(scheduler, runtime.acbId);
        agentSummariesByNode.set(spec.nodeId, agentSummary(runtime, scheduler));
        throw new Error(spec.nodeId + ": " + message);
      }
      }
    };

    while (settledNodes.size < specs.length && failure === undefined && awaitingStepId === undefined) {
      let startedAny = false;
      for (const spec of specs) {
        if (failure !== undefined) break;
        if (settledNodes.has(spec.nodeId) || inFlight.has(spec.nodeId)) continue;
        if (!(spec.dependsOn ?? []).every((dependency) => settledNodes.has(dependency))) continue;
        if (inFlight.size >= concurrency) break;
        const running = runNode(spec)
          .catch((error: unknown) => {
            // First failure wins; the driver stops starting new work.
            failure ??= { error };
          })
          .finally(() => {
            inFlight.delete(spec.nodeId);
            settledNodes.add(spec.nodeId);
          });
        inFlight.set(spec.nodeId, running);
        startedAny = true;
      }
      if (inFlight.size > 0) {
        await Promise.race([...inFlight.values()]);
        continue;
      }
      if (!startedAny) {
        throw new Error("workflow plan cannot make progress: unsatisfiable dependencies (cycle or dangling dependsOn)");
      }
    }
    // Drain independently admitted peers first: a failure must outrank a
    // pending approval, and a wait is never a successful terminal run.
    if (failure !== undefined || awaitingStepId !== undefined) {
      await Promise.allSettled([...inFlight.values()]);
    }
    if (failure !== undefined) {
      // Failure propagation: stop dispatching, DRAIN what is already in flight
      // (a dispatched paid call is never abandoned mid-flight and never
      // re-issued), then fail the run with the first cause.
      throw failure.error;
    }

    // Deterministic fan-in: fold each node's findings in TOPOLOGICAL order, so
    // a bounded-concurrency run reports exactly what the serial run reports.
    for (const spec of specs) {
      for (const finding of nodeFindings.get(spec.nodeId) ?? []) {
        const primary = finding.evidenceIds[0]!;
        if (!findingsByPrimaryEvidence.has(primary)) findingOrder.push(primary);
        findingsByPrimaryEvidence.set(primary, finding);
      }
    }

    const findings = findingOrder.map((primary) => findingsByPrimaryEvidence.get(primary)!);
    const status: WorkflowExecutionResult["status"] = awaitingStepId !== undefined
      ? "awaiting_input"
      : degradedReason === undefined ? "succeeded" : "degraded";
    if (awaitingStepId === undefined) scheduler.succeedRun(runId);
    return {
      runKey,
      runId,
      status,
      ...(degradedReason === undefined ? {} : { error: degradedReason }),
      ...(degradedCause === undefined ? {} : { degradedCause }),
      ...(awaitingStepId === undefined ? {} : { awaitingStepId }),
      // Internal provisional snapshot only: the host never persists this as
      // a terminal mini-report while status is awaiting_input.
      miniReport: buildReport(status === "awaiting_input" ? "degraded" : status, findings, degradedReason),
      evidence: orderEvidence(evidenceStore.list(), evidenceOrder),
      scheduler,
      contextManager,
      baseContextImage: baseImage,
      agentContextImages,
    };
  } catch (error) {
    return failRun(error);
  } finally {
    unsubscribeSchedulerEvents();
  }
}

// ---------------------------------------------------------------------------
// Agent registration (Kernel API reuse — mirrors ReviewWorkload#registerAgent)
// ---------------------------------------------------------------------------

function registerWorkflowAgent(input: {
  readonly scheduler: KernelScheduler;
  readonly bridge: SchedulerAgentBridge;
  readonly broker: CapabilityBroker;
  readonly gateway: SyscallGateway;
  readonly runId: RunId;
  readonly runKey: string;
  readonly nodeId: string;
  readonly serviceRef: string;
  readonly capabilityRequirements: readonly string[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly repository: string;
  readonly snapshot: WorkflowPinnedSnapshot;
  readonly evidenceStore: EvidenceStore;
  readonly contextImage: ContextImageId;
  readonly llm?: WorkflowExecutorLlmEntry;
  /** Run-scoped H13 cancellation signal (injected into every backend call). */
  readonly signal: AbortSignal;
}): AgentRuntime {
  const acbId = asAgentId(input.nodeId + ":" + input.runKey);
  const principal: Principal = {
    id: makePrincipalId("agent", input.serviceRef, String(input.runId)),
    kind: "agent",
    runId: String(input.runId),
  };

  const handles = new Map<string, CapabilityHandle>();
  const refs: CapabilityRef[] = [];
  const repositoryResource: RepositoryResource = { kind: "repository", id: input.repository };
  const evidenceResource: EvidenceResource = { kind: "evidence", runId: input.runKey };
  const llmResource: LLMResource | undefined = input.llm === undefined ? undefined : { kind: "llm", provider: input.llm.provider };

  for (const action of input.capabilityRequirements) {
    const resource: RepositoryResource | EvidenceResource | LLMResource =
      action.startsWith("evidence.") ? evidenceResource
        : action === "llm.invoke" && llmResource ? llmResource
          : repositoryResource;
    const handle = input.broker.issue({
      subject: principal,
      action: action as Action,
      resource,
      ...(action !== "llm.invoke" ? {} : { budget: { maxTokens: WORKFLOW_LLM_TOKEN_BUDGET, maxCalls: WORKFLOW_LLM_MAX_CALLS } }),
    });
    handles.set(action, handle);
    refs.push({
      handleFingerprint: auditFingerprint(handle),
      action: action as Action,
      resourceKind: resource.kind,
    });
  }

  // Read-only tool nodes legitimately hold no evidence capability — their
  // facades simply omit the evidence surface; nothing is faked.

  const repoHandle = handles.get("repo.read");
  const repoFacade = repoHandle
    ? new CapabilityBoundRepoFacade({
        principal,
        handle: repoHandle,
        resource: repositoryResource,
        gateway: input.gateway,
        snapshot: input.snapshot,
      })
    : undefined;
  const evidenceReadHandle = handles.get("evidence.read");
  const evidenceWriteHandle = handles.get("evidence.write");
  // The facade requires one primary handle; a write-only agent (the
  // deterministic analyzer) passes its evidence.write handle as primary —
  // a list() through it would be per-call DENIED by the Kernel (action
  // mismatch), so the misdirection is honest fail-closed, never a grant.
  const evidenceFacade = (evidenceReadHandle ?? evidenceWriteHandle)
    ? new CapabilityBoundEvidenceFacade({
        principal,
        readHandle: (evidenceReadHandle ?? evidenceWriteHandle)!,
        writeHandle: evidenceWriteHandle,
        resource: evidenceResource,
        gateway: input.gateway,
        store: input.evidenceStore,
      })
    : undefined;
  const llmHandle = handles.get("llm.invoke");
  const llmFacade = llmHandle && input.llm && llmResource
    ? new CapabilityBoundLLMFacade({
        principal,
        handle: llmHandle,
        resource: llmResource,
        gateway: input.gateway,
        // Trusted backend wrapped so every invocation carries the run-scoped
        // H13 cancellation signal — nodes never set signals themselves.
        backend: signalInjectedBackend(input.llm.backend, input.signal),
      })
    : undefined;
  const facades: WorkflowAgentFacades = {
    ...(evidenceFacade === undefined ? {} : { evidence: evidenceFacade }),
    ...(repoFacade === undefined ? {} : { repo: repoFacade }),
    ...(llmFacade === undefined ? {} : { llm: llmFacade }),
  };

  input.scheduler.registerAgent({
    id: acbId,
    runId: input.runId,
    priority: 5,
    executionDomain: "in-process",
    logicalRing: 3,
    capabilities: refs,
    contextImage: input.contextImage,
  });

  const fiber = input.bridge.attach(principal, acbId);
  return { nodeId: input.nodeId, serviceRef: input.serviceRef, parameters: input.parameters, acbId, facades, handles, fiber };
}

/** Injects the run-scoped signal into every backend call (H13 cancellation). */
function signalInjectedBackend(backend: TrustedLLMBackend, signal: AbortSignal): TrustedLLMBackend {
  return {
    invokeStructured: (request) => backend.invokeStructured({ ...request, signal }),
    invokeAgentFindings: (request) => backend.invokeAgentFindings({ ...request, signal }),
    invokeText: (request) => backend.invokeText({ ...request, signal }),
  };
}

// ---------------------------------------------------------------------------
// H17 registry-driven dispatch — one dispatcher per registered node KIND.
// ---------------------------------------------------------------------------

interface AnalyzerService {
  readonly analyze: DeterministicEvidenceRunner["run"];
}

interface WorkflowNodeBodyResult {
  readonly findings?: readonly WorkflowRuntimeFinding[];
  readonly evidenceInputs?: readonly EvidenceInput[];
  readonly modelVerdict?: unknown;
  /** Primary output handed to downstream nodes (contract-named). */
  readonly output?: unknown;
  /** H17 observability: the model actually invoked + its reported usage. */
  readonly model?: string;
  readonly usage?: TokenUsage;
  /** H17: the step did not fulfill its contract — honest degrade, run continues. */
  readonly degraded?: { readonly reason: string };
}

interface WorkflowNodeBodyContext {
  readonly runtime: AgentRuntime;
  readonly scheduler: KernelScheduler;
  readonly input: WorkflowSnapshotInput;
  readonly analyzer: AnalyzerService;
  readonly descriptor: { readonly kind: WorkflowNodeKind };
  readonly priorOutputs: ReadonlyMap<string, { readonly outputSchema: string; readonly output: unknown }>;
  readonly signal: AbortSignal;
  /** Model actually pinned by the unified entry (observability on step events). */
  readonly llmModel?: string;
  readonly restored?: WorkflowRestoredStepResult;
}

type WorkflowNodeBodyDispatcher = (context: WorkflowNodeBodyContext) => Promise<WorkflowNodeBodyResult>;

const WORKFLOW_NODE_DISPATCHERS: Readonly<Record<WorkflowNodeKind, WorkflowNodeBodyDispatcher>> = Object.freeze({
  "deterministic-analyzer": analyzeNodeBody,
  "persisted-evidence-verifier": verifyNodeBody,
  "readonly-tool": fileContextNodeBody,
  "llm-structured-verifier": modelVerifyNodeBody,
  "subflow": () => Promise.reject(new Error("subflow nodes are expanded before execution and cannot be dispatched")),
});

function dispatchNodeBody(context: WorkflowNodeBodyContext): Promise<WorkflowNodeBodyResult> {
  const dispatcher = WORKFLOW_NODE_DISPATCHERS[context.descriptor.kind];
  if (!dispatcher) {
    return Promise.reject(new Error("no executor dispatcher registered for node kind '" + context.descriptor.kind + "'"));
  }
  return dispatcher(context);
}

/** Last prior step output written under the given named contract, if any. */
function priorOutputBySchema(
  priorOutputs: WorkflowNodeBodyContext["priorOutputs"],
  schemaName: string,
): unknown {
  for (const entry of priorOutputs.values()) {
    if (entry.outputSchema === schemaName) return entry.output;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Node bodies — facades only; every protected op is a Kernel syscall.
// ---------------------------------------------------------------------------

/** Analyzer: repo.read → deterministic analysis (WAIT_TOOL) → evidence.write. */
async function analyzeNodeBody(context: WorkflowNodeBodyContext): Promise<WorkflowNodeBodyResult> {
  const { runtime, scheduler, input, analyzer } = context;
  if (!runtime.facades.repo) {
    throw new Error("analyzer agent was not granted a repo facade (repo.read missing)");
  }
  if (!runtime.facades.evidence) {
    throw new Error("analyzer agent was not granted an evidence facade (evidence.write missing)");
  }
  const evidence = runtime.facades.evidence;

  // H14 restore path: reuse the checkpointed analysis instead of re-executing
  // it. The evidence inputs are re-written through the Kernel-authorized
  // facade (fingerprints are content-derived, so restored evidence verifies
  // identically); no repo re-read and no re-analysis happens.
  if (context.restored) {
    const restoredInputs = context.restored.evidenceInputs ?? [];
    if (restoredInputs.length === 0) {
      throw new Error("restored analyzer checkpoint carries no evidence inputs (fail-closed)");
    }
    for (const evidenceInput of restoredInputs) {
      await evidence.write(evidenceInput);
    }
    return { evidenceInputs: restoredInputs, output: restoredInputs };
  }

  // Protected reads from the pinned snapshot — one syscall per file.
  const files: { path: string; content: string }[] = [];
  for (const path of input.paths) {
    const file = await runtime.facades.repo.readFile(path);
    files.push({ path: file.path, content: file.content });
  }

  // Deterministic analysis under cooperative WAIT_TOOL (canonical pattern),
  // over the EXPLICIT batch plan (H17) — one runner call per batch.
  scheduler.wait(runtime.acbId, { kind: "tool", toolName: "deterministic.analyze" });
  const evidenceInputs: EvidenceInput[] = [];
  try {
    for (const batch of chunkFiles(files, normalizeBatchSize(input.analysisBatchSize))) {
      const batchInputs = await analyzer.analyze({
        repository: input.repository,
        headSha: input.headSha,
        files: batch,
        analyzers: normalizeAnalyzerProfile(runtime.parameters),
      });
      evidenceInputs.push(...batchInputs);
    }
  } finally {
    scheduler.wake(runtime.acbId);
  }
  const readmitted = await reAdmitSelf(scheduler, runtime.acbId, context.signal);
  if (!readmitted) {
    throw new Error("analyzer lost Scheduler admission after analysis");
  }

  if (evidenceInputs.length === 0) {
    // Fail-closed: no evidence ⇒ verifier must not run, no pass claim.
    throw new Error("deterministic analyzers produced no evidence — refusing to proceed without evidence");
  }

  for (const evidenceInput of evidenceInputs) {
    await evidence.write(evidenceInput);
  }
  return { evidenceInputs, output: evidenceInputs };
}

/** Verifier: consumes ONLY persisted Evidence (evidence.read); re-derives fingerprints. */
async function verifyNodeBody(context: WorkflowNodeBodyContext): Promise<WorkflowNodeBodyResult> {
  const { runtime, input } = context;
  if (Object.keys(runtime.parameters).length !== 0) throw new Error("verifier parameters must be an empty object");
  if (!runtime.facades.evidence) {
    throw new Error("verifier agent was not granted an evidence facade (evidence.read missing)");
  }
  const persisted = await runtime.facades.evidence.list();
  if (persisted.length === 0) {
    throw new Error("verifier found no persisted evidence — cannot verify (fail-closed)");
  }

  for (const record of persisted) {
    const recomputed = computeEvidenceFingerprint(record);
    if (recomputed !== record.fingerprint) {
      throw new Error("evidence '" + record.id + "' fingerprint mismatch: stored " + record.fingerprint + " != recomputed " + recomputed);
    }
    if (record.provenance.sha !== input.headSha) {
      throw new Error("evidence '" + record.id + "' provenance sha does not match pinned snapshot " + input.headSha);
    }
    if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
      throw new Error("evidence '" + record.id + "' has invalid confidence " + String(record.confidence));
    }
  }

  const findings: WorkflowRuntimeFinding[] = persisted.map((record, index) => {
    const line = record.location.startLine === undefined ? "" : ":" + record.location.startLine;
    const rule = record.ruleId ?? record.source;
    return {
      id: "finding-" + String(index + 1).padStart(3, "0"),
      nodeId: runtime.nodeId,
      file: record.location.path,
      title: record.provenance.analyzer + " · " + rule + " at " + record.location.path + line + " — fingerprint verified against pinned snapshot",
      confidence: record.confidence,
      evidenceIds: [record.id],
      verified: true,
    };
  });
  return { findings, output: findings };
}

/** H17 read-only tool: bounded pinned-file excerpts via repo.read ONLY. */
async function fileContextNodeBody(context: WorkflowNodeBodyContext): Promise<WorkflowNodeBodyResult> {
  const { runtime, input } = context;
  if (!runtime.facades.repo) {
    throw new Error("tool agent was not granted a repo facade (repo.read missing)");
  }
  // A restored run re-executes this cheap deterministic read (the pinned
  // snapshot re-validates it); restore is deliberately a no-op for this kind.
  const options = normalizeToolParameters(runtime.parameters);
  const files: { path: string; contentHash: string; excerpt: string; truncated: boolean }[] = [];
  for (const path of input.paths.slice(0, options.maxFiles)) {
    const file = await runtime.facades.repo.readFile(path);
    files.push({
      path: file.path,
      contentHash: file.contentHash,
      excerpt: file.content.slice(0, options.maxCharsPerFile),
      truncated: file.content.length > options.maxCharsPerFile,
    });
  }
  return { output: { files } };
}

// ---------------------------------------------------------------------------
// H17 model verification node — ONE strict-schema call through the unified
// LLM entry, verdicts keyed on persisted evidence FINGERPRINTS.
// ---------------------------------------------------------------------------

const MODEL_VERIFY_SYSTEM_PROMPT = [
  "You are a code-review verification assistant inside ConsistenCy's workflow runtime.",
  "You receive deterministic evidence records (each with a fingerprint, path, line range, analyzer, and payload excerpt)",
  "and must return ONLY a JSON object matching the schema: { findings: [{ evidenceFingerprint, verdict, note }], summary }.",
  "verdict is exactly one of 'confirmed', 'refuted', 'uncertain'. Judge each record on the given evidence only.",
  "Every findings entry MUST reuse an evidenceFingerprint EXACTLY as provided in the input. Never invent fingerprints.",
].join(" ");

function truncateJson(value: unknown, maxChars: number): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return "";
    return text.length <= maxChars ? text : text.slice(0, maxChars) + "…(truncated)";
  } catch {
    return "";
  }
}

function buildModelVerificationPrompt(
  persisted: readonly EvidenceSnapshot[],
  deterministicFindings: unknown,
  fileContext: unknown,
): string {
  const digest = persisted.slice(0, 40).map((record) => ({
    fingerprint: record.fingerprint,
    path: record.location.path,
    startLine: record.location.startLine,
    endLine: record.location.endLine,
    ruleId: record.ruleId ?? undefined,
    source: record.source,
    analyzer: record.provenance.analyzer,
    confidence: record.confidence,
    payloadExcerpt: truncateJson(record.payload, 400),
  }));
  const parts = [
    "Evidence records to verify (JSON):",
    truncateJson(digest, 24_000),
    deterministicFindings === undefined ? undefined : "Deterministic findings (JSON): " + truncateJson(deterministicFindings, 8_000),
    fileContext === undefined ? undefined : "Pinned file context (JSON): " + truncateJson(fileContext, 8_000),
    "Return the verification JSON now.",
  ];
  return redactModelVisibleText(parts.filter((part) => part !== undefined).join("\n\n"));
}

/**
 * Build the model-verified findings: one finding per CONFIRMED evidence
 * record. Verdicts key on fingerprints (restart-stable); findings reference
 * the CURRENT evidence record ids (this run's store).
 */
async function buildModelVerifiedFindings(
  runtime: AgentRuntime,
  verdict: WorkflowModelVerification,
): Promise<WorkflowRuntimeFinding[]> {
  if (!runtime.facades.evidence) {
    throw new Error("model verifier agent was not granted an evidence facade (evidence.read missing)");
  }
  const persisted = await runtime.facades.evidence.list();
  const byFingerprint = new Map<string, EvidenceSnapshot>();
  for (const record of persisted) byFingerprint.set(record.fingerprint, record);
  const findings: WorkflowRuntimeFinding[] = [];
  let index = 0;
  for (const entry of verdict.findings) {
    if (entry.verdict !== "confirmed") continue;
    const record = byFingerprint.get(entry.evidenceFingerprint);
    if (!record) continue; // defensive: grounding already validated upstream
    index += 1;
    const line = record.location.startLine === undefined ? "" : ":" + record.location.startLine;
    const rule = record.ruleId ?? record.source;
    findings.push({
      id: "model-finding-" + String(index).padStart(3, "0"),
      nodeId: runtime.nodeId,
      file: record.location.path,
      title: "model-confirmed · " + record.provenance.analyzer + " · " + rule + " at " + record.location.path + line,
      confidence: record.confidence,
      evidenceIds: [record.id],
      verified: true,
    });
  }
  return findings;
}

async function modelVerifyNodeBody(context: WorkflowNodeBodyContext): Promise<WorkflowNodeBodyResult> {
  const { runtime, scheduler } = context;
  if (Object.keys(runtime.parameters).length !== 0) throw new Error("verifier parameters must be an empty object");

  // H14 restore path: re-apply the checkpointed fingerprint-keyed verdict —
  // the completed model call is NEVER billed twice.
  if (context.restored) {
    const parsed = workflowModelVerificationSchema.safeParse(context.restored.modelVerdict);
    if (!parsed.success) {
      throw new Error("restored model verification checkpoint is not a valid verdict (fail-closed)");
    }
    const findings = await buildModelVerifiedFindings(runtime, parsed.data);
    return { findings, modelVerdict: parsed.data, output: modelVerificationOutput(parsed.data) };
  }

  if (!runtime.facades.llm) {
    return {
      degraded: {
        reason: "model verification unavailable: no model backend is wired through the unified LLM entry (llm.invoke facade absent)",
      },
    };
  }
  if (!runtime.facades.evidence) {
    throw new Error("model verifier agent was not granted an evidence facade (evidence.read missing)");
  }
  if (context.signal.aborted) {
    throw context.signal.reason ?? new Error("run was cancelled before the model verification started");
  }

  const persisted = await runtime.facades.evidence.list();
  if (persisted.length === 0) {
    throw new Error("model verifier found no persisted evidence — cannot verify (fail-closed)");
  }
  const deterministicFindings = priorOutputBySchema(context.priorOutputs, "workflow-runtime.finding");
  const fileContext = priorOutputBySchema(context.priorOutputs, "workflow-runtime.pinned-file-context");

  scheduler.wait(runtime.acbId, { kind: "llm" });
  let invocation: { data: WorkflowModelVerification; tokenUsage?: TokenUsage };
  try {
    const raw = await runtime.facades.llm.invokeStructured({
      schema: workflowModelVerificationSchema,
      schemaName: "workflow-model-verification",
      systemPrompt: MODEL_VERIFY_SYSTEM_PROMPT,
      userPrompt: buildModelVerificationPrompt(persisted, deterministicFindings, fileContext),
    });
    invocation = { data: raw.data as WorkflowModelVerification, ...(raw.tokenUsage === undefined ? {} : { tokenUsage: raw.tokenUsage }) };
  } catch (error) {
    // H13: cancellation is NOT degradation — it propagates as the run's
    // single causal failure. Quality failures (bad JSON, provider error,
    // Kernel denial) degrade honestly instead.
    if (context.signal.aborted) {
      throw context.signal.reason ?? error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { degraded: { reason: "model verification failed strict schema validation or the invocation failed: " + detail.slice(0, 500) } };
  } finally {
    // A cancelled agent is CANCELLED (terminal): waking it would throw an
    // invalid-transition error and swallow the real cancellation cause.
    if (!context.signal.aborted) scheduler.wake(runtime.acbId);
  }
  const readmitted = await reAdmitSelf(scheduler, runtime.acbId, context.signal);
  if (!readmitted) {
    throw new Error("model verifier lost Scheduler admission after the model invocation");
  }

  // Strict validation is TWO-layered: the provider already parsed the output
  // against the schema; here the verdict is additionally grounded — every
  // referenced fingerprint must exist among the persisted evidence records.
  const verdict = workflowModelVerificationSchema.safeParse(invocation.data);
  if (!verdict.success) {
    return { degraded: { reason: "model verification output failed schema validation (fail-closed): " + verdict.error.issues[0]?.message } };
  }
  const fingerprints = new Set(persisted.map((record) => record.fingerprint));
  const ungrounded = verdict.data.findings.filter((entry) => !fingerprints.has(entry.evidenceFingerprint));
  if (ungrounded.length > 0) {
    return {
      degraded: {
        reason: "model verification referenced " + ungrounded.length + " evidence fingerprint(s) that do not exist in the persisted evidence — refusing to apply ungrounded verdicts",
      },
    };
  }

  const findings = await buildModelVerifiedFindings(runtime, verdict.data);
  return {
    findings,
    modelVerdict: verdict.data,
    output: modelVerificationOutput(verdict.data),
    ...(context.llmModel === undefined ? {} : { model: context.llmModel }),
    ...(invocation.tokenUsage === undefined ? {} : { usage: invocation.tokenUsage }),
  };
}

function modelVerificationOutput(verdict: WorkflowModelVerification): unknown {
  return {
    summary: verdict.summary,
    verdictCount: verdict.findings.length,
    confirmed: verdict.findings.filter((entry) => entry.verdict === "confirmed").length,
    refuted: verdict.findings.filter((entry) => entry.verdict === "refuted").length,
    uncertain: verdict.findings.filter((entry) => entry.verdict === "uncertain").length,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeAnalyzerProfile(parameters: Readonly<Record<string, unknown>>): readonly ("style" | "secret")[] {
  const keys = Object.keys(parameters);
  if (keys.some(key => key !== "analyzers")) throw new Error("analyzer parameters contain unknown fields");
  const value = parameters.analyzers;
  if (value === undefined) return ["style", "secret"];
  if (!Array.isArray(value) || value.length === 0 || value.some(item => item !== "style" && item !== "secret") || new Set(value).size !== value.length) {
    throw new Error("analyzer parameters contain an invalid analyzers profile");
  }
  return value as readonly ("style" | "secret")[];
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER; // single batch (unchanged behavior)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("analysisBatchSize must be an integer between 1 and 50");
  }
  return value;
}

function chunkFiles<T>(files: readonly T[], size: number): T[][] {
  if (size >= files.length) return [files as T[]];
  const batches: T[][] = [];
  for (let offset = 0; offset < files.length; offset += size) {
    batches.push(files.slice(offset, offset + size));
  }
  return batches;
}

function normalizeToolParameters(parameters: Readonly<Record<string, unknown>>): { maxFiles: number; maxCharsPerFile: number } {
  const keys = Object.keys(parameters);
  if (keys.some(key => key !== "maxFiles" && key !== "maxCharsPerFile")) {
    throw new Error("tool parameters contain unknown fields");
  }
  const readInt = (key: string, fallback: number): number => {
    const value = parameters[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 64) {
      throw new Error("tool parameter '" + key + "' must be an integer between 1 and 64");
    }
    return value;
  };
  return { maxFiles: readInt("maxFiles", 4), maxCharsPerFile: readInt("maxCharsPerFile", 1200) };
}

function conditionMatches(
  output: unknown,
  when: { readonly path: readonly string[]; readonly equals: string | number | boolean },
): boolean {
  if (output === null || typeof output !== "object") {
    throw new Error("workflow condition source has no structured output");
  }
  let current: unknown = output;
  for (const key of when.path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)
      || !Object.hasOwn(current, key)) {
      throw new Error("workflow condition reads a missing output field");
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current === when.equals;
}

function cleanupOnFailure(scheduler: KernelScheduler, acbId: AgentRuntime["acbId"]): void {
  const current = scheduler.getAgent(acbId);
  if (!current) return;
  if (current.state === "RUNNING") {
    scheduler.failAgent(acbId);
  } else if (current.state !== "SUCCEEDED" && current.state !== "FAILED" && current.state !== "CANCELLED") {
    scheduler.cancelAgent(acbId);
  }
}

function agentSummary(runtime: AgentRuntime, scheduler: KernelScheduler): WorkflowRuntimeAgentSummary {
  const state: AgentState | undefined = scheduler.getAgent(runtime.acbId)?.state;
  return {
    nodeId: runtime.nodeId,
    agentId: String(runtime.acbId),
    state: state ?? "UNKNOWN",
    fiberApplied: runtime.fiber.instrumentation.applied,
  };
}
