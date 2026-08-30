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
 */

import { Context } from "cordis";
import {
  CapabilityBroker,
  CapabilityChangeBus,
  ContextManager,
  EvidenceStore,
  KernelScheduler,
  MemoryJournal,
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
  type EvidenceSnapshot,
  type Principal,
  type RunId,
} from "@consistency/kernel";
import { SchedulerAgentBridge } from "@consistency/harness-core";
import type { Action } from "@consistency/kernel";
import {
  CapabilityBoundEvidenceFacade,
  CapabilityBoundRepoFacade,
  DeterministicEvidenceRunner,
} from "@consistency/workload-review";
import type {
  EvidenceInput,
  EvidenceResource,
  RepositoryResource,
} from "@consistency/kernel";
import type {
  WorkflowRuntimeAgentSummary,
  WorkflowRuntimeExecutablePlan,
  WorkflowRuntimeFinding,
  WorkflowRuntimeMiniReport,
} from "@consistency/schema";

/** SHA-pinned read surface the executor is allowed to hand to facades. */
export interface WorkflowPinnedSnapshot {
  readFile(path: string): { readonly path: string; readonly content: string; readonly contentHash: string };
}

export interface WorkflowSnapshotInput {
  readonly repository: string;
  readonly headSha: string;
  readonly paths: readonly string[];
  readonly snapshot: WorkflowPinnedSnapshot;
}

/** What an agent body receives: facades ONLY — never raw store/snapshot/gateway. */
export interface WorkflowAgentFacades {
  readonly repo?: CapabilityBoundRepoFacade;
  readonly evidence: CapabilityBoundEvidenceFacade;
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
}

export interface WorkflowExecutorHooks {
  readonly onRunCreated?: (info: WorkflowRunCreatedInfo) => void | Promise<void>;
  readonly onAgentAdmitted?: (info: WorkflowAgentAdmittedInfo) => void | Promise<void>;
}

export interface WorkflowExecutionResult {
  readonly runKey: string;
  readonly runId: RunId;
  readonly status: "succeeded" | "failed";
  readonly error?: string;
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

export async function executeWorkflowPlan(
  plan: WorkflowRuntimeExecutablePlan,
  input: WorkflowSnapshotInput,
  hooks: WorkflowExecutorHooks = {},
): Promise<WorkflowExecutionResult> {
  const runKey = plan.definitionId;
  const startedAt = new Date().toISOString();

  // -------------------------------------------------------------------------
  // 1. Kernel foundations — identical wiring to the authoritative runtime.
  // -------------------------------------------------------------------------
  const journal = new MemoryJournal();
  const bus = new CapabilityChangeBus();
  const broker = new CapabilityBroker(journal, Date.now, bus);
  const gateway = new SyscallGateway(broker);
  const scheduler = new KernelScheduler({ maxRunningAgents: 1 });
  const contextManager = new ContextManager();
  const evidenceStore = new EvidenceStore();
  const bridge = new SchedulerAgentBridge(new Context(), scheduler);
  const runner = new DeterministicEvidenceRunner();
  const analyzeSnapshot = runner.run.bind(runner);
  const forkContextImage = contextManager.fork.bind(contextManager);

  const runId = asRunId("run_wf_" + runKey + "_" + Date.now());
  scheduler.registerRun({ id: runId });
  scheduler.activateRun(runId);

  const agentSummaries: WorkflowRuntimeAgentSummary[] = [];
  const agentContextImages = new Map<string, ContextImageId>();
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
      verifiedEvidenceCount: status === "succeeded" ? evidenceStore.list().length : 0,
      findings,
      agents: agentSummaries,
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
  });

  let findings: WorkflowRuntimeFinding[] = [];

  try {
    // -----------------------------------------------------------------------
    // 3. Agents in compiled topological order: capability issue → facades →
    //    COW context fork → ACB → admission → fiber → body.
    // -----------------------------------------------------------------------
    for (const spec of [...plan.agentSpecs].sort((a, b) => a.order - b.order)) {
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
      });

      scheduler.ready(runtime.acbId);
      const admitted = scheduler.admit();
      if (!admitted || admitted.id !== runtime.acbId) {
        // Canonical admission-denied semantics: the agent stays READY (the
        // Scheduler has no DENIED state). No protected execution began.
        cleanupOnFailure(scheduler, runtime.acbId);
        agentSummaries.push(agentSummary(runtime, scheduler));
        const state = scheduler.getAgent(runtime.acbId)?.state ?? "unknown";
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

      try {
        const runOnFiber = runtime.fiber.execute;
        const outcome = await runOnFiber(() =>
          executeAgentBody({
            runtime,
            scheduler,
            input,
            analyzer: { analyze: analyzeSnapshot },
          }),
        );
        if (spec.serviceRef === "persisted-evidence.verifier") {
          findings = outcome.findings;
        }
        scheduler.succeedAgent(runtime.acbId);
        agentSummaries.push(agentSummary(runtime, scheduler));
      } catch (error) {
        cleanupOnFailure(scheduler, runtime.acbId);
        agentSummaries.push(agentSummary(runtime, scheduler));
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(spec.nodeId + ": " + message);
      }
    }

    scheduler.succeedRun(runId);
    return {
      runKey,
      runId,
      status: "succeeded",
      miniReport: buildReport("succeeded", findings),
      evidence: evidenceStore.list(),
      scheduler,
      contextManager,
      baseContextImage: baseImage,
      agentContextImages,
    };
  } catch (error) {
    return failRun(error);
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

  for (const action of input.capabilityRequirements) {
    const resource = action.startsWith("evidence.") ? evidenceResource : repositoryResource;
    const handle = input.broker.issue({
      subject: principal,
      action: action as Action,
      resource,
    });
    handles.set(action, handle);
    refs.push({
      handleFingerprint: auditFingerprint(handle),
      action: action as Action,
      resourceKind: resource.kind,
    });
  }

  if (!handles.has("evidence.read") && !handles.has("evidence.write")) {
    throw new Error("node '" + input.nodeId + "' declares no evidence capability — cannot construct facade");
  }

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
  const facades: WorkflowAgentFacades = {
    evidence: new CapabilityBoundEvidenceFacade({
      principal,
      readHandle: handles.get("evidence.read")!,
      writeHandle: handles.get("evidence.write"),
      resource: evidenceResource,
      gateway: input.gateway,
      store: input.evidenceStore,
    }),
    ...(repoFacade === undefined ? {} : { repo: repoFacade }),
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

// ---------------------------------------------------------------------------
// Agent bodies — facades only; every protected op is a Kernel syscall.
// ---------------------------------------------------------------------------

/** Minimal deterministic-analyzer surface handed to agent bodies. */
interface AnalyzerService {
  readonly analyze: DeterministicEvidenceRunner["run"];
}

interface AgentBodyInput {
  readonly runtime: AgentRuntime;
  readonly scheduler: KernelScheduler;
  readonly input: WorkflowSnapshotInput;
  readonly analyzer: AnalyzerService;
}

async function executeAgentBody(body: AgentBodyInput): Promise<{ findings: WorkflowRuntimeFinding[] }> {
  if (body.runtime.serviceRef === "deterministic-evidence.analyzer") {
    await analyzeAgentBody(body);
    return { findings: [] };
  }
  if (body.runtime.serviceRef === "persisted-evidence.verifier") {
    if (Object.keys(body.runtime.parameters).length !== 0) throw new Error("verifier parameters must be an empty object");
    return verifyAgentBody(body);
  }
  throw new Error("no executor service registered for serviceRef '" + body.runtime.serviceRef + "'");
}

/** Analyzer: repo.read → deterministic analysis (WAIT_TOOL) → evidence.write. */
async function analyzeAgentBody(body: AgentBodyInput): Promise<void> {
  const { runtime, scheduler, input, analyzer } = body;
  if (!runtime.facades.repo) {
    throw new Error("analyzer agent was not granted a repo facade (repo.read missing)");
  }

  // Protected reads from the pinned snapshot — one syscall per file.
  const files: { path: string; content: string }[] = [];
  for (const path of input.paths) {
    const file = await runtime.facades.repo.readFile(path);
    files.push({ path: file.path, content: file.content });
  }

  // Deterministic analysis under cooperative WAIT_TOOL (canonical pattern).
  scheduler.wait(runtime.acbId, { kind: "tool", toolName: "deterministic.analyze" });
  let evidenceInputs: EvidenceInput[];
  try {
    evidenceInputs = await analyzer.analyze({
      repository: input.repository,
      headSha: input.headSha,
      files,
      analyzers: normalizeAnalyzerProfile(body.runtime.parameters),
    });
  } finally {
    scheduler.wake(runtime.acbId);
  }
  const readmitted = scheduler.admit();
  if (!readmitted || readmitted.id !== runtime.acbId) {
    throw new Error("analyzer lost Scheduler admission after analysis");
  }

  if (evidenceInputs.length === 0) {
    // Fail-closed: no evidence ⇒ verifier must not run, no pass claim.
    throw new Error("deterministic analyzers produced no evidence — refusing to proceed without evidence");
  }

  for (const evidenceInput of evidenceInputs) {
    await runtime.facades.evidence.write(evidenceInput);
  }
}

/** Verifier: consumes ONLY persisted Evidence (evidence.read); re-derives fingerprints. */
async function verifyAgentBody(body: AgentBodyInput): Promise<{ findings: WorkflowRuntimeFinding[] }> {
  const { runtime, input } = body;
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
  return { findings };
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
