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
  ReviewFinding,
} from "@consistency/schema";
import type { TrustedLLMBackend } from "../facades/llm-facade.js";
import { CapabilityBoundLLMFacade } from "../facades/llm-facade.js";
import { CapabilityBoundEvidenceFacade } from "../facades/evidence-facade.js";
import { CapabilityBoundRepoFacade } from "../facades/repo-facade.js";
import { DeterministicEvidenceRunner } from "../context/evidence-runner.js";
import { buildReviewBaseContext } from "../context/review-context.js";
import { runSupervisorBody } from "../supervisor/supervisor.js";
import { runReviewAgentBody } from "../agents/review-agent.js";
import { runSynthesizerBody } from "../synthesis/synthesizer.js";
import {
  AGENT_CAPABILITY_PROFILES,
  REVIEW_AGENTS,
  type AgentCapabilityProfile,
  type AgentCapabilityRefs,
  type AgentFacadeSet,
  type ReviewWorkloadOptions,
  type ReviewWorkloadResult,
} from "./types.js";

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

  constructor(options: ReviewWorkloadOptions) {
    this.#options = options;
  }

  /** Cancel the active Run (prevents any further Agent admission). */
  cancelRun(): void {
    if (this.#scheduler && this.#runId) {
      this.#scheduler.cancelRun(this.#runId);
    }
  }

  async run(): Promise<ReviewWorkloadResult> {
    const options = this.#options;
    const jobId = options.context.jobId;
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
      // 2. SHA-pinned content (RepositorySnapshot first, context fallback).
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
      const agentContext: PRReviewContext = {
        ...options.context,
        fileContents: { ...options.context.fileContents, ...Object.fromEntries(snapshotContents) },
      };

      // -------------------------------------------------------------------
      // 3. Deterministic PR-4 evidence over the snapshot.
      // -------------------------------------------------------------------
      const evidenceRunner = new DeterministicEvidenceRunner();
      const evidenceInputs = await evidenceRunner.run({
        repository: options.context.repositoryFullName,
        headSha: options.context.headSha,
        files: [...snapshotContents.entries()].map(([path, content]) => ({ path, content })),
      });
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

      // -------------------------------------------------------------------
      // 5. Legacy deterministic stage (WAIT_TOOL) — parity provider.
      // -------------------------------------------------------------------
      const deterministicResult = await this.#runDeterministicStage({
        scheduler,
        bridge,
        jobId,
        runId,
        options,
        agentContext,
        persistence,
        providerName: options.modelDriver.provider,
      });

      // -------------------------------------------------------------------
      // 6. History enrichment (best effort — parity).
      // -------------------------------------------------------------------
      let relevantContext: Record<string, RelevantContext> | undefined;
      if (options.knowledgeIndexPath && options.deterministic.relevantContext) {
        try {
          relevantContext = await options.deterministic.relevantContext(
            Object.entries(agentContext.fileContents).map(([path, content]) => ({ path, content })),
            agentContext.changedFiles.filter((f) => f.status !== "removed").map((f) => f.path),
            options.knowledgeIndexPath,
          );
        } catch {
          // Enrichment only.
        }
      }

      // -------------------------------------------------------------------
      // 7. Supervisor (planner) — chooses work; Scheduler admits.
      // -------------------------------------------------------------------
      const supervisor = this.#registerAgent({
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
      scheduler.ready(supervisor.acbId);
      const supervisorAdmitted = scheduler.admit();
      if (!supervisorAdmitted || supervisorAdmitted.id !== supervisor.acbId) {
        throw new Error("supervisor was never admitted");
      }
      await bridge.flush();
      await this.#fireHook(supervisor, options);

      const supervisorResult = await runSupervisorBody({
        fiber: supervisor.fiber,
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
      const agentContextImages = new Map<string, ContextImageId>();
      const agentFacades = new Map<string, AgentFacadeSet>();
      const agentCapabilities = new Map<string, AgentCapabilityRefs>();

      for (const agentName of REVIEW_AGENTS) {
        if (scheduler.getRun(runId)?.state !== "ACTIVE") break; // cancelled run
        const acbKey = `review-${agentName.toLowerCase()}`;
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
          parent: supervisor.acbId,
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

        if (!plan.enabledAgents.includes(agentName)) {
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
          facades: runtime.facades,
          persistence,
          providerName: options.modelDriver.provider,
          model: options.modelDriver.model,
        });
        findings.push(...result.findings);
        if (result.error) errors.push(`${agentName}: ${result.error}`);
      }

      // -------------------------------------------------------------------
      // 9. Synthesizer → ReviewReport.
      // -------------------------------------------------------------------
      if (scheduler.getRun(runId)?.state === "CANCELLED") {
        throw new Error("review run was cancelled before synthesis");
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
        parent: supervisor.acbId,
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
        findings,
        agentRuns,
        deterministic: options.deterministic,
        facades: synthesizerRuntime.facades,
        persistence,
        reportLanguage: options.reportLanguage,
        providerName: options.modelDriver.provider,
        model: options.modelDriver.model,
      });
      if (synthesized.error) errors.push(`Synthesizer: ${synthesized.error}`);
      const report = synthesized.report;

      // -------------------------------------------------------------------
      // 10. Compatibility boundary: durable report + existing Outbox path.
      // -------------------------------------------------------------------
      persistence.persistReportAndEnqueuePublish(jobId, report);

      // -------------------------------------------------------------------
      // 11. Project memory write-back (best effort — parity).
      // -------------------------------------------------------------------
      if (options.knowledgeIndexPath && options.deterministic.recordReview) {
        try {
          await options.deterministic.recordReview({
            indexPath: options.knowledgeIndexPath,
            jobId,
            reference: options.context.headSha,
            reportedAt: report.createdAt,
            coveredFiles: options.context.changedFiles.map((file) => file.path),
            findings: report.findings.map((finding) => ({
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

      return {
        report,
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
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  #backend(): TrustedLLMBackend {
    const modelDriver = this.#options.modelDriver;
    return {
      invokeStructured: (request) => modelDriver.invokeStructured(request),
      invokeAgentFindings: async (request) => {
        const result = await modelDriver.invokeAgentFindings(request);
        return { findings: result.data, tokenUsage: result.tokenUsage };
      },
      invokeText: async (request) => {
        const result = await modelDriver.invokeSummary({
          systemPrompt: request.systemPrompt,
          userPrompt: request.userPrompt,
        });
        return { text: result.data.summary, tokenUsage: result.tokenUsage };
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
    ): CapabilityHandle => {
      const handle = input.broker.issue({ subject: principal, action, resource });
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
    if (profile.llm) handles.llm = issue("llm.invoke", { kind: "llm", provider: input.providerName });

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
    const files = agentContext.changedFiles.map((cf) => ({
      path: cf.path,
      content: agentContext.fileContents[cf.path] || "",
      baseline: agentContext.baseFileContents[cf.path] ?? "",
      diffHunks: cf.patch ? cf.patch.split("\n@@").map((h, i) => (i === 0 ? h : "@@" + h)) : [],
    }));

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
        return response;
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
