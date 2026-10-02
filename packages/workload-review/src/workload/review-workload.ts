/**
 * ReviewWorkload — the PR Review workload running on the Harness OS.
 *
 * Job (ReviewJob, owned by apps/api) → Kernel Run → ACB-backed agents →
 * Cordis fibers (via SchedulerAgentBridge) → Evidence-grounded Synthesizer →
 * ReviewReport → host persistence boundary.
 *
 * AUTHORITATIVE runtime model (PR-5A):
 *   - The KernelScheduler owns READY/RUNNING/WAIT_LLM/WAIT_TOOL/… transitions;
 *     agents execute ONLY through scheduler.admit().
 *   - The Supervisor chooses WHAT work should be done; the Scheduler decides
 *     WHAT MAY RUN. No direct function-call bypass exists.
 *   - Every protected operation (llm.invoke, evidence.read/write, repo.read)
 *     goes through a CapabilityBoundFacade → SyscallGateway →
 *     CapabilityBroker.authorise().
 *   - Deterministic grounding: PR-4 analyzers over the SHA-pinned
 *     RepositorySnapshot feed the Kernel EvidenceStore; findings carry
 *     evidenceIds and unknown ids are rejected.
 */

import { Context } from "cordis";
import { randomUUID } from "node:crypto";
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
  makePrincipalId,
  type AgentSnapshot,
  type CapabilityHandle,
  type CapabilityRef,
  type ContextImageId,
  type Evidence,
  type Principal,
  type RepositoryResource,
  type RunId,
} from "@consistency/kernel";
import { SchedulerAgentBridge, type AgentFiberHandle } from "@consistency/harness-core";
import type {
  AgentRun,
  DomainAnalyzeResponse,
  DomainAnalyzeSuccess,
  PRReviewContext,
  RelevantContext,
  ReviewCoverage,
  ReviewEvidenceRecord,
  ReviewFinding,
  ReviewReport,
} from "@consistency/schema";
import type { TrustedLLMBackend } from "../facades/llm-facade.js";
import { CapabilityBoundLLMFacade } from "../facades/llm-facade.js";
import { CapabilityBoundEvidenceFacade } from "../facades/evidence-facade.js";
import { CapabilityBoundRepoFacade } from "../facades/repo-facade.js";
import { DeterministicEvidenceRunner } from "../context/evidence-runner.js";
import { applyModelContentPolicy } from "../context/content-policy.js";
import { buildReviewBaseContext } from "../context/review-context.js";
import { scopeDeterministicFindings, scopeEvidenceInputs } from "../context/deterministic-scope.js";
import { changedLineRanges, type LineRange } from "../agents/grounding.js";
import { runSupervisorBody } from "../supervisor/supervisor.js";
import { runReviewAgentBody } from "../agents/review-agent.js";
import { numberedChangedLines } from "../synthesis/finding-score.js";
import { runSynthesizerBody } from "../synthesis/synthesizer.js";
import {
  AGENT_CAPABILITY_PROFILES,
  LEAN_AGENTS,
  REVIEW_AGENTS,
  type AgentCapabilityProfile,
  type AgentCapabilityRefs,
  type AgentFacadeSet,
  type ReviewAgentName,
  type ReviewWorkloadOptions,
  type ReviewWorkloadResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// H13 bounded budget policy — ONE source of truth shared by the capability
// ledger (P2-04) and the ACB descriptor. Every bound is finite:
//   - tokens/calls per agent: a runaway loop is denied, not billed unbounded;
//   - wall time: an agent queued past its budget is cancelled by admit()
//     (deadline enforcement), never started.
// ---------------------------------------------------------------------------

/** Per-agent token ceiling (mirrored on the llm.invoke capability budget). */
export const REVIEW_AGENT_TOKEN_BUDGET = 250_000;
/** Per-agent LLM call ceiling. */
export const REVIEW_AGENT_MAX_LLM_CALLS = 32;
/** Per-agent wall-time budget (also the ACB Scheduler deadline): 15 minutes. */
export const REVIEW_AGENT_WALL_TIME_BUDGET_MS = 15 * 60_000;

/**
 * Project a Kernel Evidence record onto its durable report form (audit
 * P1-04). Non-object payloads (none today; analyzers emit objects) are
 * omitted rather than failing the report — persistence must not hinge on
 * payload shape exoticism.
 */
function toDurableEvidenceRecord(record: Evidence): ReviewEvidenceRecord {
  return {
    id: record.id,
    source: record.source,
    ...(record.ruleId !== undefined ? { ruleId: record.ruleId } : {}),
    location: {
      path: record.location.path,
      ...(record.location.startLine !== undefined ? { startLine: record.location.startLine } : {}),
      ...(record.location.endLine !== undefined ? { endLine: record.location.endLine } : {}),
    },
    confidence: record.confidence,
    ...(isPlainObject(record.payload) ? { payload: record.payload } : {}),
    provenance: { ...record.provenance },
    fingerprint: record.fingerprint,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Audit P1-09: mixed workflow-step outcomes must degrade coverage, not fail the job. */
function workflowStepsIncomplete(result: DomainAnalyzeSuccess): boolean {
  const steps = result.consensus?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return false;
  return steps.some(step => {
    if (!step || typeof step !== "object") return false;
    const status = (step as { status?: unknown }).status;
    return status === "failed" || status === "skipped" || status === "error";
  });
}

/**
 * The run was cancelled (audit P1-07①). Distinct from a failure so the
 * worker can keep the job's `cancelled` status instead of marking it failed.
 */
export class ReviewCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewCancelledError";
  }
}

/** A recovery pass is for changed behavior, never docs-only or metadata-only diffs. */
function hasActualCodeChanges(context: PRReviewContext): boolean {
  return context.changedFiles.some(file => {
    if (/\.(?:md|mdx|txt|rst|lock)$/i.test(file.path)) return false;
    const section = context.diff.split(/(?=^diff --git )/m)
      .find(part => part.startsWith(`diff --git a/${file.path} b/${file.path}\n`));
    return `${file.patch ?? ""}\n${section ?? ""}`.split(/\r?\n/).some(line =>
      /^[+-](?![+-])\s*\S/.test(line) && !/^[+-]\s*(?:\/\/|#|\/\*|\*|<!--)/.test(line));
  });
}

interface AgentRuntime {
  readonly acbId: ReturnType<typeof asAgentId>;
  readonly name: string;
  readonly principal: Principal;
  readonly fiber: AgentFiberHandle;
  readonly facades: AgentFacadeSet;
  readonly handles: Record<string, CapabilityHandle>;
  readonly refs: CapabilityRef[];
}

interface RegisterAgentInput {
  readonly scheduler: KernelScheduler;
  readonly bridge: SchedulerAgentBridge;
  readonly broker: CapabilityBroker;
  readonly gateway: SyscallGateway;
  readonly runId: RunId;
  readonly jobId: string;
  readonly name: string;
  readonly profile: AgentCapabilityProfile;
  readonly repositoryFullName: string;
  readonly snapshot: ReviewWorkloadOptions["snapshot"];
  readonly evidenceStore: EvidenceStore;
  readonly backend: TrustedLLMBackend;
  readonly providerName: string;
  readonly parent?: ReturnType<typeof asAgentId>;
  readonly contextImage: ContextImageId;
}

export class ReviewWorkload {
  readonly #options: ReviewWorkloadOptions;
  #scheduler: KernelScheduler | null = null;
  #runId: RunId | null = null;
  #broker: CapabilityBroker | null = null;
  readonly #kernelPrincipalId = makePrincipalId("kernel", "workload");
  /** Run-scoped cancellation (audit P1-07①): aborts in-flight provider calls. */
  readonly #abort = new AbortController();
  /** Every capability handle issued for THIS run (audit P1-02: revoked at terminal state). */
  readonly #issuedHandles: CapabilityHandle[] = [];
  /** Total issued count — stable even when revocation removes handles from the list. */
  #issuedCount = 0;

  constructor(options: ReviewWorkloadOptions) {
    this.#options = options;
  }

  /**
   * Cancel the active Run: prevents any further Agent admission, aborts the
   * in-flight provider request (audit P1-07① — cancellation must reach the
   * external call, not only the scheduler), and settles the run's budget
   * ledger (H13): usage already committed stays counted, every uncommitted
   * reservation is released so the cancel never leaves phantom capacity
   * reserved.
   *
   * Honest boundary: the abort SIGNAL is delivered, but whether the provider
   * or child process actually stops is NOT knowable here — callers must not
   * claim the external operation has ended until the run() promise settles.
   */
  cancelRun(): void {
    if (this.#scheduler && this.#runId) {
      try {
        this.#scheduler.cancelRun(this.#runId);
      } catch {
        // Already terminal — the abort below is still meaningful for any
        // in-flight transport call.
      }
    }
    this.#settleBudgetsOnCancel();
    if (!this.#abort.signal.aborted) {
      this.#abort.abort(new Error("review run cancelled"));
    }
  }

  /**
   * H13 budget settlement at cancel: release every PENDING reservation on
   * every handle this run issued. Committed usage is untouched (the run still
   * answers for consumed tokens); future calls are already impossible because
   * cancelRun also revokes the handles at the terminal transition and the
   * run-scoped abort signal kills in-flight dispatches.
   */
  #settleBudgetsOnCancel(): number {
    const broker = this.#broker;
    if (!broker) return 0;
    let released = 0;
    for (const handle of this.#issuedHandles) {
      released += broker.releaseAllTokens(handle);
    }
    return released;
  }

  /** Revoke every capability issued for the run; returns the revoked count. */
  #revokeIssuedCapabilities(): number {
    const broker = this.#broker;
    if (!broker) return 0;
    let revoked = 0;
    for (const handle of this.#issuedHandles.splice(0)) {
      try {
        broker.revoke(handle, this.#kernelPrincipalId);
        revoked += 1;
      } catch {
        // Already revoked/expired — terminal-state revocation is idempotent.
      }
    }
    return revoked;
  }

  async run(): Promise<ReviewWorkloadResult> {
    const options = this.#options;
    const jobId = options.context.jobId;
    // Pre-run cancellation (audit P1-07①): a cancel that arrived before run()
    // must not degrade into an all-agents-failed "successful" report.
    if (this.#abort.signal.aborted) {
      throw new ReviewCancelledError(`review run ${jobId} was cancelled before it started`);
    }
    const errors: string[] = [];
    const agentRuns: AgentRun[] = [];
    // Telemetry collection wrapper: AgentRuns are compatibility telemetry,
    // never runtime authority (ACBs are).
    const persistence: ReviewWorkloadOptions["persistence"] = {
      saveAgentRun: (run) => {
        agentRuns.push(run);
        options.persistence.saveAgentRun(run);
      },
      persistReportAndEnqueuePublish: (id, report) =>
        options.persistence.persistReportAndEnqueuePublish(id, report),
    };

    // ---------------------------------------------------------------------
    // 1. Kernel foundations (run-scoped, in-memory).
    // ---------------------------------------------------------------------
    const journal = new MemoryJournal();
    const bus = new CapabilityChangeBus();
    const broker = new CapabilityBroker(journal, Date.now, bus);
    this.#broker = broker;
    const gateway = new SyscallGateway(broker);
    const scheduler = new KernelScheduler({ maxRunningAgents: options.schedulerConcurrency ?? 1 });
    this.#scheduler = scheduler;
    const contextManager = new ContextManager();
    const evidenceStore = new EvidenceStore();
    const bridge = new SchedulerAgentBridge(new Context(), scheduler);

    const run = scheduler.registerRun({ id: asRunId(`run_${jobId}`) });
    const runId = run.id;
    this.#runId = runId;
    scheduler.activateRun(runId);

    try {
      // -------------------------------------------------------------------
      // 2. SHA-pinned content. TWO views with one boundary (audit P0-01):
      //    - analysisContext: RAW snapshot contents for the trusted local
      //      deterministic stage (secret/style detection must see real bytes;
      //      evidence integrity requires unmodified inputs).
      //    - agentContext: the model-visible projection — raw snapshot text
      //      can NEVER overwrite it (applyModelContentPolicy drops secret
      //      paths and redacts credential material from every text surface).
      // -------------------------------------------------------------------
      const snapshotContents = new Map<string, string>();
      for (const changed of options.context.changedFiles) {
        if (changed.status === "removed") continue;
        let content = options.context.fileContents[changed.path] ?? "";
        try {
          content = options.snapshot.readFile(changed.path).content;
        } catch {
          // Path not in the snapshot (compatibility: pre-built context content).
        }
        snapshotContents.set(changed.path, content);
      }
      const analysisContext: PRReviewContext = {
        ...options.context,
        fileContents: { ...options.context.fileContents, ...Object.fromEntries(snapshotContents) },
      };
      const agentContext: PRReviewContext = applyModelContentPolicy(analysisContext);

      // -------------------------------------------------------------------
      // 3. Deterministic PR-4 evidence over the snapshot.
      // -------------------------------------------------------------------
      const scope = options.deterministicScope ?? "diff";
      const changedRangesByFile = new Map<string, readonly LineRange[]>(
        options.context.changedFiles.map((cf) => [cf.path, changedLineRanges(cf.patch)]),
      );
      const evidenceRunner = new DeterministicEvidenceRunner();
      const rawEvidenceInputs = await evidenceRunner.run({
        repository: options.context.repositoryFullName,
        headSha: options.context.headSha,
        files: [...snapshotContents.entries()].map(([path, content]) => ({ path, content })),
      });
      const evidenceInputs = scopeEvidenceInputs(rawEvidenceInputs, changedRangesByFile, scope);
      const evidence = evidenceInputs.map((input) => evidenceStore.add(input));

      // -------------------------------------------------------------------
      // 4. Base review ContextImage (pinned policy/task/diff; hot pages).
      // -------------------------------------------------------------------
      const { baseImage } = buildReviewBaseContext(contextManager, {
        jobId,
        repositoryFullName: options.context.repositoryFullName,
        pullRequestNumber: options.context.pullRequestNumber,
        baseSha: options.context.baseSha,
        headSha: options.context.headSha,
        context: options.context,
        snapshotContents,
        evidence,
        publicationPolicy: options.publicationPolicy,
      });

      if (options.onRunCreated) {
        await options.onRunCreated({
          runId,
          jobId,
          scheduler,
          contextManager,
          baseContextImage: baseImage,
          broker,
        });
      }

      // -------------------------------------------------------------------
      // 5. Legacy deterministic stage (WAIT_TOOL) — parity provider. Consumes
      //    the RAW analysis view: local analyzers must see real bytes.
      // -------------------------------------------------------------------
      const deterministicResult = await this.#runDeterministicStage({
        scheduler,
        bridge,
        jobId,
        runId,
        options,
        agentContext: analysisContext,
        persistence,
        providerName: options.modelDriver.provider,
      });

      // -------------------------------------------------------------------
      // 6. History enrichment (best effort — parity). Local analysis over the
      //    raw view.
      // -------------------------------------------------------------------
      let relevantContext: Record<string, RelevantContext> | undefined;
      if (options.knowledgeIndexPath && options.deterministic.relevantContext) {
        try {
          relevantContext = await options.deterministic.relevantContext(
            Object.entries(analysisContext.fileContents).map(([path, content]) => ({ path, content })),
            analysisContext.changedFiles.filter((f) => f.status !== "removed").map((f) => f.path),
            options.knowledgeIndexPath,
          );
        } catch {
          // Enrichment only.
        }
      }

      // -------------------------------------------------------------------
      // 7. Supervisor (planner) — chooses work; Scheduler admits.
      //    Lean mode selects Correctness + Consistency without a Planner call.
      // -------------------------------------------------------------------
      const leanPlan = options.lean === true ? {
        enabledAgents: [...LEAN_AGENTS],
        skippedAgents: REVIEW_AGENTS.filter(agent => agent !== "Correctness"),
        riskAreas: ["changed code"],
        reason: "Lean review runs only Correctness and Consistency.",
        focusAreas: [],
      } : undefined;
      const supervisor = leanPlan ? undefined : this.#registerAgent({
        scheduler,
        bridge,
        broker,
        gateway,
        runId,
        jobId,
        name: "review-supervisor",
        profile: "supervisor",
        repositoryFullName: options.context.repositoryFullName,
        snapshot: options.snapshot,
        evidenceStore,
        backend: this.#backend(),
        providerName: options.modelDriver.provider,
        contextImage: baseImage,
      });
      if (supervisor) {
        scheduler.ready(supervisor.acbId);
        const supervisorAdmitted = scheduler.admit();
        if (!supervisorAdmitted || supervisorAdmitted.id !== supervisor.acbId) {
          throw new Error("supervisor was never admitted");
        }
        await bridge.flush();
        await this.#fireHook(supervisor, options);
      }

      const supervisorResult = leanPlan ? { plan: leanPlan } : await runSupervisorBody({
        fiber: supervisor!.fiber,
        scheduler,
        agentId: supervisor.acbId,
        jobId,
        context: agentContext,
        deterministicResult,
        facades: supervisor.facades,
        persistence,
        providerName: options.modelDriver.provider,
        model: options.modelDriver.model,
      });
      if (supervisorResult.error) {
        errors.push(`Planner: ${supervisorResult.error}`);
      }
      const plan = supervisorResult.plan;

      // -------------------------------------------------------------------
      // 8. Specialized agents (ACBs + COW forks + capability profiles).
      // -------------------------------------------------------------------
      const findings: ReviewFinding[] = [];
      const preExistingIssues: ReviewFinding[] = [];
      let totalCappedBySpecialists = 0;
      const failedAgents: ReviewAgentName[] = [];
      const agentContextImages = new Map<string, ContextImageId>();
      const agentFacades = new Map<string, AgentFacadeSet>();
      const agentCapabilities = new Map<string, AgentCapabilityRefs>();

      let rawFindingsCount = 0;
      let completedSpecialists = 0;
      const enabledAgents = [...plan.enabledAgents];
      // One additional pass at most, with a fresh ACB/capability budget. It
      // cannot resurrect a terminal ACB or bypass Scheduler admission.
      const scheduledAgents = options.lean === true ? LEAN_AGENTS : REVIEW_AGENTS;
      for (const [index, agentName] of [...scheduledAgents, "Correctness" as const].entries()) {
        if (scheduler.getRun(runId)?.state !== "ACTIVE") break; // cancelled run
        const isRecovery = index === scheduledAgents.length;
        if (isRecovery) {
          if (rawFindingsCount !== 0 || completedSpecialists === 0 || failedAgents.length > 0
            || !hasActualCodeChanges(agentContext)) break;
          if (!enabledAgents.includes("Correctness")) enabledAgents.push("Correctness");
        }
        const acbKey = `review-${agentName.toLowerCase()}${isRecovery ? "-retry" : ""}`;
        const profile: AgentCapabilityProfile = agentName === "Security" ? "security" : "specialized";
        // Real COW fork per agent (AC-REV-3): private overlay over the base.
        const agentImage = contextManager.fork(baseImage);
        const runtime = this.#registerAgent({
          scheduler,
          bridge,
          broker,
          gateway,
          runId,
          jobId,
          name: acbKey,
          profile,
          repositoryFullName: options.context.repositoryFullName,
          snapshot: options.snapshot,
          evidenceStore,
          backend: this.#backend(),
          providerName: options.modelDriver.provider,
          parent: supervisor?.acbId,
          contextImage: agentImage,
        });
        agentContextImages.set(runtime.acbId, agentImage);
        agentFacades.set(runtime.acbId, runtime.facades);
        agentCapabilities.set(runtime.acbId, {
          llm: runtime.handles.llm ? { handle: runtime.handles.llm } : undefined,
          repo: runtime.handles.repo ? { handle: runtime.handles.repo } : undefined,
          evidenceRead: runtime.handles.evidenceRead ? { handle: runtime.handles.evidenceRead } : undefined,
          evidenceWrite: runtime.handles.evidenceWrite ? { handle: runtime.handles.evidenceWrite } : undefined,
        });

        if (!isRecovery && !plan.enabledAgents.includes(agentName)) {
          scheduler.cancelAgent(runtime.acbId); // skipped: never scheduled
          const skipped: AgentRun = {
            id: `agent_${randomUUID()}`,
            jobId,
            agentName,
            status: "skipped",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            inputSummary: "Skipped by the review plan",
            findings: [],
            provider: options.modelDriver.provider,
            model: options.modelDriver.model,
          };
          persistence.saveAgentRun(skipped);
          continue;
        }

        scheduler.ready(runtime.acbId);
        const admitted = scheduler.admit();
        if (!admitted || admitted.id !== runtime.acbId) {
          if (scheduler.getRun(runId)?.state === "CANCELLED") break;
          errors.push(`${agentName}: scheduler did not admit the agent`);
          failedAgents.push(agentName);
          continue;
        }
        await bridge.flush();
        await this.#fireHook(runtime, options);

        const result = await runReviewAgentBody({
          fiber: runtime.fiber,
          scheduler,
          agentId: runtime.acbId,
          agentName,
          jobId,
          context: agentContext,
          deterministicResult,
          evidence,
          evidenceStore,
          headSha: options.context.headSha,
          reportLanguage: options.reportLanguage,
          relevantContext,
          focusAreas: plan.focusAreas,
          maxFindingsPerSpecialist: options.maxFindingsPerSpecialist ?? 3,
          omitBaselineSnippets: isRecovery,
          facades: runtime.facades,
          persistence,
          providerName: options.modelDriver.provider,
          model: options.modelDriver.model,
        });
        rawFindingsCount += result.rawFindingsCount;
        if (!result.error) completedSpecialists += 1;
        findings.push(...result.findings);
        preExistingIssues.push(...result.preExistingIssues);
        totalCappedBySpecialists += result.cappedFindingsCount;
        if (result.error) {
          errors.push(`${agentName}: ${result.error}`);
          failedAgents.push(agentName);
        }
      }

      // -------------------------------------------------------------------
      // 9. Synthesizer → ReviewReport.
      // -------------------------------------------------------------------
      if (scheduler.getRun(runId)?.state === "CANCELLED") {
        // Typed cancellation (message preserved — the worker and callers
        // match on it) so a cancelled run never reads as a failure.
        throw new ReviewCancelledError("review run was cancelled before synthesis");
      }
      const synthesizerImage = contextManager.fork(baseImage);
      const synthesizerRuntime = this.#registerAgent({
        scheduler,
        bridge,
        broker,
        gateway,
        runId,
        jobId,
        name: "review-synthesizer",
        profile: "synthesizer",
        repositoryFullName: options.context.repositoryFullName,
        snapshot: options.snapshot,
        evidenceStore,
        backend: this.#backend(),
        providerName: options.modelDriver.provider,
        parent: supervisor?.acbId,
        contextImage: synthesizerImage,
      });
      agentContextImages.set(synthesizerRuntime.acbId, synthesizerImage);
      agentFacades.set(synthesizerRuntime.acbId, synthesizerRuntime.facades);
      agentCapabilities.set(synthesizerRuntime.acbId, {
        llm: synthesizerRuntime.handles.llm ? { handle: synthesizerRuntime.handles.llm } : undefined,
        evidenceRead: synthesizerRuntime.handles.evidenceRead
          ? { handle: synthesizerRuntime.handles.evidenceRead }
          : undefined,
      });

      scheduler.ready(synthesizerRuntime.acbId);
      const synthAdmitted = scheduler.admit();
      if (!synthAdmitted || synthAdmitted.id !== synthesizerRuntime.acbId) {
        throw new Error("synthesizer was never admitted");
      }
      await bridge.flush();
      await this.#fireHook(synthesizerRuntime, options);

      const synthesized = await runSynthesizerBody({
        fiber: synthesizerRuntime.fiber,
        scheduler,
        agentId: synthesizerRuntime.acbId,
        jobId,
        repositoryFullName: options.context.repositoryFullName,
        pullRequestNumber: options.context.pullRequestNumber,
        baseSha: options.context.baseSha,
        headSha: options.context.headSha,
        deterministicResult,
        missingBaselinePaths: options.context.changedFiles
          .filter(file => file.status !== "removed")
          .filter(file => (options.context.skippedBaselinePaths ?? []).includes(file.path)
            || !(file.path in options.context.baseFileContents))
          .map(file => file.path),
        analyzedPaths: deterministicResult.files
          .filter(file => file.confidence > 0 || file.findings.length > 0 || !/No Baseline|skipped|unsupported/i.test(file.riskLabel))
          .map(file => file.path),
        newFileCount: options.context.changedFiles.filter(file => file.status === "added").length,
        notAnalyzedReason: deterministicResult.files.length === 0
          ? "deterministic analysis returned no scored files"
          : undefined,
        findings,
        preExistingIssues,
        totalCappedBySpecialists,
        agentRuns,
        deterministic: options.deterministic,
        facades: synthesizerRuntime.facades,
        persistence,
        reportLanguage: options.reportLanguage,
        providerName: options.modelDriver.provider,
        model: options.modelDriver.model,
        minFindingScore: options.minFindingScore,
        maxReportedFindings: options.maxReportedFindings,
        maxFindingsPerFile: options.maxFindingsPerFile,
        scoreRubricV2: options.scoreRubricV2,
        numberedChangedCode: options.scoreRubricV2 === true
          ? numberedChangedLines(options.context.changedFiles, options.context.fileContents)
          : undefined,
        // Coverage facts as of synthesis start (audit P1-05): the
        // synthesizer adds its own status and derives the final outcome.
        coverage: {
          enabledAgents,
          failedAgents: [...failedAgents],
          plannerFailed: Boolean(supervisorResult.error),
          deterministicFailed: workflowStepsIncomplete(deterministicResult),
        } satisfies Omit<ReviewCoverage, "outcome" | "synthesizerFailed">,
      });
      if (synthesized.error) errors.push(`Synthesizer: ${synthesized.error}`);
      const report = synthesized.report;

      // -------------------------------------------------------------------
      // 10. Compatibility boundary: durable report + existing Outbox path.
      //    PR-5B: the host may route this through the CommitCoordinator, which
      //    is async (authorisation + durable sink). Await it so a commit DENY
      //    or sink failure surfaces as a failed job instead of a silent success.
      // -------------------------------------------------------------------
      // 10. Compatibility boundary: durable report + existing Outbox path.
      //     PR-5B: the host may route this through the CommitCoordinator, which
      //     is async (authorisation + durable sink). Await it so a commit DENY
      //     or sink failure surfaces as a failed job instead of a silent success.
      //
      //     Audit P1-04: attach the run's Kernel Evidence records to the
      //     report before it crosses the persistence boundary. Findings
      //     reference these by evidenceIds; without the durable copy those
      //     ids point into the in-memory EvidenceStore, which dies with the
      //     run — after a restart no resolver could ever answer them.
      // -------------------------------------------------------------------
      const durableReport: ReviewReport = {
        ...report,
        evidence: evidence.map(toDurableEvidenceRecord),
      };
      await Promise.resolve(persistence.persistReportAndEnqueuePublish(jobId, durableReport));

      // -------------------------------------------------------------------
      // 11. Project memory write-back (best effort — parity).
      // -------------------------------------------------------------------
      if (options.knowledgeIndexPath && options.deterministic.recordReview) {
        try {
          await options.deterministic.recordReview({
            indexPath: options.knowledgeIndexPath,
            jobId,
            reference: options.context.headSha,
            reportedAt: durableReport.createdAt,
            coveredFiles: options.context.changedFiles.map((file) => file.path),
            findings: durableReport.findings.map((finding) => ({
              file: finding.file,
              title: finding.title,
              severity: finding.severity,
            })),
          });
        } catch {
          // Memory is an enrichment; never fail a durable review.
        }
      }

      scheduler.succeedRun(runId);
      // Audit P1-02: terminal state revokes every capability issued for the
      // run — success is no reason to leave unused authorizations alive.
      const capabilitiesRevoked = this.#revokeIssuedCapabilities();

      return {
        report: durableReport,
        plan,
        runId,
        findings,
        evidence,
        evidenceIds: evidence.map((record) => record.id),
        scheduler,
        contextManager,
        baseContextImage: baseImage,
        agentContextImages,
        agentFacades,
        agentCapabilities,
        capabilitiesIssued: this.#issuedCount,
        capabilitiesRevoked,
        errors,
      };
    } catch (error) {
      const current = scheduler.getRun(runId);
      if (current && current.state !== "CANCELLED") {
        try {
          scheduler.failRun(runId);
        } catch {
          // Already terminal.
        }
      }
      // Audit P1-02: failure and cancellation revoke too — no terminal state
      // leaves issued capabilities alive.
      this.#revokeIssuedCapabilities();
      if (error instanceof ReviewCancelledError) {
        throw error;
      }
      if (current?.state === "CANCELLED") {
        // A cancelled run must surface as cancellation, not failure — the
        // worker keeps the job's `cancelled` status instead of marking it
        // failed (audit P1-07①).
        throw new ReviewCancelledError(`review run ${jobId} was cancelled`);
      }
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  #backend(): TrustedLLMBackend {
    const modelDriver = this.#options.modelDriver;
    // The run-scoped abort signal rides along on every backend dispatch
    // (audit P1-07①): agents cannot see or forge it, but cancelRun() and
    // shutdown reach the in-flight provider request through it.
    const signal = this.#abort.signal;
    return {
      invokeStructured: (request) => modelDriver.invokeStructured({ ...request, signal }),
      invokeAgentFindings: async (request) => {
        const result = await modelDriver.invokeAgentFindings({ ...request, signal });
        return { findings: result.data, tokenUsage: result.tokenUsage };
      },
      invokeText: async (request) => {
        const result = await modelDriver.invokeSummary({
          systemPrompt: request.systemPrompt,
          userPrompt: request.userPrompt,
          signal,
        });
        return { text: result.data.summary, tokenUsage: result.tokenUsage, scores: result.data.scores };
      },
    };
  }

  #registerAgent(input: RegisterAgentInput): AgentRuntime {
    const profile = AGENT_CAPABILITY_PROFILES[input.profile];
    const acbId = asAgentId(`${input.name}:${input.jobId}`);
    const principal: Principal = {
      id: makePrincipalId("agent", input.name, String(input.runId)),
      kind: "agent",
      runId: String(input.runId),
    };

    const handles: Record<string, CapabilityHandle> = {};
    const refs: CapabilityRef[] = [];

    const issue = (
      action: Parameters<CapabilityBroker["issue"]>[0]["action"],
      resource: Parameters<CapabilityBroker["issue"]>[0]["resource"],
      budget?: Parameters<CapabilityBroker["issue"]>[0]["budget"],
    ): CapabilityHandle => {
      const handle = input.broker.issue({ subject: principal, action, resource, budget });
      this.#issuedHandles.push(handle);
      this.#issuedCount += 1;
      refs.push({
        handleFingerprint: auditFingerprint(handle),
        action,
        resourceKind: resource.kind,
      });
      return handle;
    };

    const repositoryResource: RepositoryResource = {
      kind: "repository",
      id: input.repositoryFullName,
    };
    if (profile.repo) handles.repo = issue("repo.read", repositoryResource);
    if (profile.ast) handles.ast = issue("ast.query", { kind: "ast", snapshotId: input.snapshot.id });
    if (profile.evidenceRead) handles.evidenceRead = issue("evidence.read", { kind: "evidence", runId: input.jobId });
    if (profile.evidenceWrite) handles.evidenceWrite = issue("evidence.write", { kind: "evidence", runId: input.jobId });
    // Audit P2-04: llm.invoke carries a token budget so gateway commitTokens
    // is a real ledger, not a no-op. The cap is per-capability (per agent),
    // large enough for a full specialist pass, small enough that a runaway
    // loop is denied rather than billed unbounded.
    // H13 budget unification: the SAME caps now also ride the ACB
    // (tokenBudget) and a bounded wall-time policy (wallTimeBudgetMs), so
    // ACB snapshots and capability budgets state one consistent policy.
    if (profile.llm) {
      handles.llm = issue(
        "llm.invoke",
        { kind: "llm", provider: input.providerName },
        { maxTokens: REVIEW_AGENT_TOKEN_BUDGET, maxCalls: REVIEW_AGENT_MAX_LLM_CALLS },
      );
    }

    const facades: AgentFacadeSet = {
      llm: new CapabilityBoundLLMFacade({
        principal,
        handle: handles.llm!,
        resource: { kind: "llm", provider: input.providerName },
        gateway: input.gateway,
        backend: input.backend,
      }),
      evidence: new CapabilityBoundEvidenceFacade({
        principal,
        readHandle: handles.evidenceRead!,
        writeHandle: handles.evidenceWrite,
        resource: { kind: "evidence", runId: input.jobId },
        gateway: input.gateway,
        store: input.evidenceStore,
      }),
      repo: handles.repo
        ? new CapabilityBoundRepoFacade({
            principal,
            handle: handles.repo,
            resource: repositoryResource,
            gateway: input.gateway,
            snapshot: input.snapshot,
          })
        : undefined,
    };

    input.scheduler.registerAgent({
      id: acbId,
      runId: input.runId,
      priority: input.name === "review-supervisor" || input.name === "review-deterministic" ? 10 : 5,
      parent: input.parent,
      executionDomain: "in-process",
      logicalRing: 3,
      capabilities: refs,
      contextImage: input.contextImage,
      // H13 bounded budget policy on the ACB itself: token ceiling mirrors the
      // llm.invoke capability budget; the wall-time budget doubles as the
      // Scheduler deadline, so a queued agent whose budget already expired is
      // cancelled by admit() instead of starting (bounded timeout).
      tokenBudget: REVIEW_AGENT_TOKEN_BUDGET,
      wallTimeBudgetMs: REVIEW_AGENT_WALL_TIME_BUDGET_MS,
      deadline: Date.now() + REVIEW_AGENT_WALL_TIME_BUDGET_MS,
    });

    const fiber = input.bridge.attach(principal, acbId);

    return { acbId, name: input.name, principal, fiber, facades, handles, refs };
  }

  async #fireHook(runtime: AgentRuntime, options: ReviewWorkloadOptions): Promise<void> {
    if (!options.onAgentAdmitted) return;
    const broker = this.#broker!;
    await options.onAgentAdmitted({
      agentId: runtime.acbId,
      agentName: runtime.name,
      facades: runtime.facades,
      scheduler: this.#scheduler!,
      fiberState: runtime.fiber.fiber.state,
      revoke: (kind) => {
        const handle = runtime.handles[kind];
        if (handle) broker.revoke(handle, this.#kernelPrincipalId);
      },
    });
  }

  async #runDeterministicStage(input: {
    readonly scheduler: KernelScheduler;
    readonly bridge: SchedulerAgentBridge;
    readonly jobId: string;
    readonly runId: RunId;
    readonly options: ReviewWorkloadOptions;
    readonly agentContext: PRReviewContext;
    readonly persistence: ReviewWorkloadOptions["persistence"];
    readonly providerName: string;
  }): Promise<DomainAnalyzeSuccess> {
    const { scheduler, bridge, jobId, runId, options, agentContext, persistence, providerName } = input;
    const acbId = asAgentId(`review-deterministic:${jobId}`);
    const principal: Principal = {
      id: makePrincipalId("agent", "review-deterministic", String(runId)),
      kind: "agent",
      runId: String(runId),
    };
    scheduler.registerAgent({
      id: acbId,
      runId,
      priority: 10,
      executionDomain: "in-process",
      logicalRing: 3,
    });
    const fiber = bridge.attach(principal, acbId);
    scheduler.ready(acbId);
    const admitted = scheduler.admit();
    if (!admitted || admitted.id !== acbId) {
      throw new Error("deterministic stage was never admitted");
    }
    await bridge.flush();

    const startedAt = new Date().toISOString();
    const skippedSet = new Set(agentContext.skippedBaselinePaths ?? []);
    const files = agentContext.changedFiles.map((cf) => ({
      path: cf.path,
      content: agentContext.fileContents[cf.path] || "",
      // Absent base content means "no baseline", which is NOT the same as an
      // empty file: the engine must be able to tell the two apart, because a
      // drift score against a missing baseline is meaningless.
      baseline: skippedSet.has(cf.path) ? undefined : agentContext.baseFileContents[cf.path],
      diffHunks: cf.patch ? cf.patch.split("\n@@").map((h, i) => (i === 0 ? h : "@@" + h)) : [],
    }));
    const scope = options.deterministicScope ?? "diff";
    const changedRangesByFile = new Map<string, readonly LineRange[]>(
      agentContext.changedFiles.map(cf => [cf.path, changedLineRanges(cf.patch)])
    );

    try {
      return await fiber.execute(async () => {
        scheduler.wait(acbId, { kind: "tool", toolName: "deterministic.analyze" });
        let response: DomainAnalyzeResponse;
        try {
          response = await options.deterministic.analyze(files);
        } finally {
          scheduler.wake(acbId);
        }
        const readmitted = scheduler.admit();
        if (!readmitted || readmitted.id !== acbId) {
          throw new Error("deterministic stage lost Scheduler admission");
        }
        if (!response.ok) {
          throw new Error(`Deterministic analysis failed: ${response.error}`);
        }
        // Step 5: only the findings that land on the change reach the review.
        const scoped = scopeDeterministicFindings(response, changedRangesByFile, scope);
        if (scoped.ok) {
          for (const file of scoped.files) {
            if (skippedSet.has(file.path)) {
              file.riskLabel = "skipped";
            }
          }
        }
        const run: AgentRun = {
          id: `agent_${randomUUID()}`,
          jobId,
          agentName: "DeterministicAnalyzer",
          status: "succeeded",
          startedAt,
          finishedAt: new Date().toISOString(),
          inputSummary: `Analyzed ${files.length} changed files`,
          findings: [],
          provider: providerName as AgentRun["provider"],
        };
        persistence.saveAgentRun(run);
        scheduler.succeedAgent(acbId);
        return scoped;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown deterministic failure";
      const current: AgentSnapshot | undefined = scheduler.getAgent(acbId);
      if (current && current.state === "RUNNING") scheduler.failAgent(acbId);
      else if (current && current.state !== "SUCCEEDED" && current.state !== "FAILED" && current.state !== "CANCELLED") {
        scheduler.cancelAgent(acbId);
      }
      const run: AgentRun = {
        id: `agent_${randomUUID()}`,
        jobId,
        agentName: "DeterministicAnalyzer",
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        inputSummary: `Analyzed ${files.length} changed files`,
        findings: [],
        error: message,
        provider: providerName as AgentRun["provider"],
      };
      persistence.saveAgentRun(run);
      throw new Error(message);
    }
  }
}
