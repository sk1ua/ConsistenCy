import { createApiServer } from "./http";
import { findProjectRoot } from "./config/settings";
import { loadRuntimeConfig } from "./config/runtime";
import { logger } from "./config/logger";
import { openDatabase } from "./db/connection";
import { runMigrations } from "./db/migrations";
import { SQLiteJobStore } from "./jobs/sqliteJobStore";
import { ReviewWorker } from "./jobs/worker";
import { PublishWorker } from "./publish/worker";
import { publishToGitHub } from "./publish/githubPublisher";
import { PermanentPublishError } from "./publish/error";
import { GitHubAppAuthenticator } from "./github/auth";
import { testGitHubConnection } from "./github/connectionTest";
import { GitHubOauthDeviceFlow } from "./github/oauthDeviceFlow";
import { RepositoryPullRequestService } from "./github/pullRequestReader";
import { connectPublicGitHubRepository } from "./github/publicRepository";
import { createContextBuilder } from "./review/context/contextRouter";
import { triggerLocalReview } from "./trigger/local";
import { HeartbeatDaemon } from "./heartbeat/daemon";
import { RepositorySupervisor } from "./heartbeat/repositorySupervisor";
import { LocalGitAdapter } from "@consistency/vcs-core";
import { createLLMProvider, createReviewLLMProvider, resolveReviewModel } from "./review/llm/factory";
import { redactSensitiveText, sanitizePublicError, sanitizePublishFailure } from "./security/redact";
import { loadRealData } from "./data/realData";
import { DeterministicAnalyzer } from "./review/deterministic";
import { SQLiteNotebookStore } from "./notebook/store";
import { RepositorySnapshotIndexer } from "./notebook/indexer";
import { NotebookGraph } from "./notebook/graph";
import { enqueuePublicPrReview } from "./review/publicPr";
import { WorkflowStore } from "./workflows/store";
import { resolveJobDiff } from "./review/jobDiff";
import { SQLiteAuditDomainStore } from "./audit/store";
import type { AuditExecutionAvailability } from "./audit/store";
import { buildRepositorySupervisorRegistrations } from "./audit/repositorySupervision";
import { AuditRunPlanner } from "./audit/planner";
import { AutomationScheduler } from "./audit/scheduler";
import {
  AUDIT_EXECUTION_AUTOMATION_NOT_MAPPED_REASON,
  AUDIT_EXECUTION_DISABLED_REASON,
  AUDIT_EXECUTION_LOCAL_REPOSITORY_REQUIRED_REASON,
  AuditRunExecutor
} from "./audit/executor";
import { RuntimeRegistry } from "./review/runtimeRegistry";
import { WorkflowRuntimeHost } from "./workflow-runtime/host";
import { WorkflowTriggerExecutor, WorkflowTriggerPlanner } from "./workflow-runtime/triggers";
import { WorkflowRuntimeStore } from "./workflow-runtime/store";

const { config, store: settingsStore } = loadRuntimeConfig();
const database = openDatabase(config.databasePath);
runMigrations(database);
const jobs = new SQLiteJobStore(database);
// Construct the runtime store before the audit store so runtime-mapped
// automation CRUD is gated by the canonical definition/revision persistence.
const workflowRuntimeStore = new WorkflowRuntimeStore(database);

/**
 * Executor-slice availability computation: armed executor × automation mapped
 * to a runtime definition × locally monitored repository. Lazy by design — it
 * reads the store only when a planning result is actually produced.
 */
function auditExecutionAvailability(subject: {
  repositoryId: string;
  automationId: string;
}): AuditExecutionAvailability {
  if (!config.auditExecutionEnabled) {
    return { available: false, reason: AUDIT_EXECUTION_DISABLED_REASON };
  }
  const automation = auditStore.getAutomation(subject.automationId);
  if (automation === undefined || automation.runtimeDefinitionId === undefined) {
    return { available: false, reason: AUDIT_EXECUTION_AUTOMATION_NOT_MAPPED_REASON };
  }
  const repository = auditStore.getRepository(subject.repositoryId);
  if (repository === undefined || repository.source !== "local_git") {
    return { available: false, reason: AUDIT_EXECUTION_LOCAL_REPOSITORY_REQUIRED_REASON };
  }
  return { available: true };
}

const auditStore = new SQLiteAuditDomainStore(database, {
  workflowRuntime: workflowRuntimeStore,
  resolveExecutionAvailability: auditExecutionAvailability
});
const notebookStore = new SQLiteNotebookStore(database);
const recoveredJobs = jobs.recoverStaleRunningJobs(new Date(Date.now() - 15 * 60 * 1_000));
if (recoveredJobs > 0) {
  logger.warn({ recoveredJobs }, "Recovered interrupted review jobs");
}

const provider = createLLMProvider(config);
export const deterministicAnalyzer = new DeterministicAnalyzer(
  config.CONSISTENCY_PYTHON_PATH,
  config.CONSISTENCY_ENGINE_MODULE,
  [],
  config.engineRoot
);

const authenticator = config.GITHUB_APP_ID && config.GITHUB_PRIVATE_KEY
  ? new GitHubAppAuthenticator({ appId: config.GITHUB_APP_ID, privateKey: config.GITHUB_PRIVATE_KEY })
  : undefined;

const snapshotIndexer = new RepositorySnapshotIndexer({
  store: notebookStore,
  authenticator,
  publicReadToken: config.GITHUB_PUBLIC_READ_TOKEN,
  workspaceRoot: config.workspaceRoot,
  maxBytes: config.CONSISTENCY_NOTEBOOK_INDEX_MAX_BYTES
});
const notebookGraph = new NotebookGraph({
  provider,
  jobs,
  notebookStore,
  indexer: snapshotIndexer,
  maxToolCalls: config.CONSISTENCY_NOTEBOOK_MAX_TOOL_CALLS,
  maxContextChars: config.CONSISTENCY_NOTEBOOK_MAX_CONTEXT_TOKENS * 4,
  reportLanguage: config.reportLanguage
});

export const workflows = new WorkflowStore();
export const runtimeRegistry = new RuntimeRegistry();
export const workflowRuntimeHost = new WorkflowRuntimeHost({
  store: workflowRuntimeStore,
  // Canonical repository resolution: opaque repositoryId → registered local
  // Git checkout binding. Unknown ids and non-local/unpathed repositories
  // never reach snapshot construction (host fails closed with sanitized
  // 404/503 semantics).
  resolveRepository: repositoryId => {
    const repository = auditStore.getRepository(repositoryId);
    if (!repository) return undefined;
    if (repository.source !== "local_git") {
      return { status: "unavailable" as const, reason: "repository has no local Git checkout to pin" };
    }
    const localPath = auditStore.getLocalRepositoryPath(repository.id);
    if (!localPath) {
      return { status: "unavailable" as const, reason: "repository local path is unavailable" };
    }
    return {
      status: "ok" as const,
      binding: {
        repositoryId: repository.id,
        displayName: repository.displayName,
        ...(repository.remoteFullName === undefined ? {} : { remoteFullName: repository.remoteFullName }),
        localPath
      }
    };
  }
});

// Seed the immutable builtin workflow definition + honestly fail runs that
// were still `running` when the previous process exited.
const workflowRuntimeInit = workflowRuntimeHost.initialize();
if (workflowRuntimeInit.interruptedRunsRecovered > 0) {
  logger.warn(
    { interruptedRuns: workflowRuntimeInit.interruptedRunsRecovered },
    "Marked interrupted workflow-runtime runs as failed after restart"
  );
}

export const worker = new ReviewWorker({
  jobStore: jobs,
  concurrency: config.CONSISTENCY_WORKER_CONCURRENCY,
  pollIntervalMs: config.CONSISTENCY_WORKER_POLL_INTERVAL_MS,
  workflow: {
    provider,
    providerFactory: override => createReviewLLMProvider(config, override),
    deterministicAnalyzer,
    reportLanguage: config.reportLanguage,
    reviewWorkflow: config.reviewWorkflow,
    runtimeRegistry,
    reviewWorkflowSpec: name => {
      const found = workflows.get(name);
      return found?.source === "draft" ? found.spec : undefined;
    },
    workspaceRoot: config.workspaceRoot,
    contextBuilder: createContextBuilder({
      github: {
        authenticator,
        publicReadToken: config.GITHUB_PUBLIC_READ_TOKEN,
        workspaceRoot: config.workspaceRoot
      }
    })
  },
  onError: (error, job) => {
    logger.error({
      jobId: job?.id,
      error: error instanceof Error ? redactSensitiveText(error.message) : "Unknown worker error"
    }, "Review worker failed a job");
  },
  onSucceeded: (job) => {
    if (config.notebookEnabled === false) return;
    try {
      const { source } = notebookStore.ensureForJob(job);
      void snapshotIndexer.ensure(job, source).catch(err => {
        logger.warn({
          jobId: job.id,
          error: err instanceof Error ? redactSensitiveText(err.message) : "Unknown index error"
        }, "Notebook index warm-up failed");
      });
    } catch (err) {
      logger.warn({ jobId: job.id, error: String(err) }, "Notebook warm-up setup failed");
    }
  }
});

export const publishWorker = new PublishWorker({
  jobStore: jobs,
  tokenFetcher: async (job, signal, options) => {
    if (!authenticator || !job.installationId) {
      throw new PermanentPublishError("GitHub App credentials or installation ID are missing");
    }
    const tokenInfo = await authenticator.getInstallationToken(
      job.installationId,
      signal,
      options?.forceRefresh ?? false
    );
    return tokenInfo.token;
  },
  publisher: publishToGitHub,
  concurrency: config.CONSISTENCY_PUBLISH_WORKER_CONCURRENCY,
  pollIntervalMs: config.CONSISTENCY_PUBLISH_WORKER_POLL_INTERVAL_MS,
  leaseDurationMs: config.CONSISTENCY_PUBLISH_LEASE_DURATION_MS,
  publishTimeoutMs: config.CONSISTENCY_PUBLISH_TIMEOUT_MS,
  maxAttempts: config.CONSISTENCY_PUBLISH_MAX_ATTEMPTS,
  onError: (error, item) => {
    logger.error({
      outboxId: item.id,
      jobId: item.jobId,
      error: sanitizePublishFailure(error)
    }, "Publish worker failed a task");
  }
});

export const heartbeat = new HeartbeatDaemon({
  repository: new LocalGitAdapter({ root: config.heartbeatRepoPath }),
  config: {
    enabled: config.heartbeatEnabled,
    pulseIntervalMs: config.CONSISTENCY_HEARTBEAT_INTERVAL_MS,
    watchFilesystem: false,
    indexPath: ".consistency/knowledge_graph.sqlite",
    maxIndexedFileBytes: 1_048_576
  },
  // Newest-first reports drive the risk index and outstanding security debt.
  recentReports: () => jobs.list()
    .map(job => job.result)
    .filter((report): report is NonNullable<typeof report> => report !== undefined),
  onError: error => {
    logger.warn({
      error: error instanceof Error ? redactSensitiveText(error.message) : "Unknown heartbeat error"
    }, "Heartbeat pulse failed");
  }
});

function repositorySupervisorRegistrations() {
  return buildRepositorySupervisorRegistrations(
    auditStore,
    config.CONSISTENCY_HEARTBEAT_INTERVAL_MS,
    {
      // Enabled on_change workflow bindings join the registration digest so
      // binding changes re-arm change events (CKPT5).
      onChangeBindings: repositoryId =>
        workflowRuntimeStore
          .listBindings(repositoryId)
          .filter(binding => binding.enabled && binding.triggerMode === "on_change")
          .map(binding => binding.definitionId)
    }
  );
}

export const auditRunPlanner = new AuditRunPlanner(auditStore);
export const workflowTriggerExecutor = new WorkflowTriggerExecutor({
  store: workflowRuntimeStore,
  trigger: (input) => workflowRuntimeHost.triggerBinding(input),
  pollIntervalMs: config.CONSISTENCY_WORKFLOW_TRIGGER_POLL_INTERVAL_MS,
  onError: failure => {
    logger.warn({
      planId: failure.planId,
      error: sanitizePublicError(
        failure.error instanceof Error ? failure.error.message : "Unknown workflow trigger execution error"
      )
    }, "Workflow trigger execution failed");
  }
});
// Planning failures are handled at the supervisor sink call site (logged
// sanitized; supervision itself never breaks).
export const workflowTriggerPlanner = new WorkflowTriggerPlanner({
  store: workflowRuntimeStore
});
/**
 * Audit execution bridge: drains durable audit-run drafts whose automation
 * maps a workflow-runtime definition through the SAME canonical host path as
 * manual triggers, then mirrors the linked run's terminal outcome. Same
 * single-flight discipline as the CKPT5 trigger executor above.
 */
export const auditRunExecutor = new AuditRunExecutor({
  store: auditStore,
  launch: input => workflowRuntimeHost.launchDefinitionRun(input),
  getWorkflowRuntimeRun: runId => {
    const found = workflowRuntimeStore.getRun(runId);
    return found === undefined
      ? undefined
      : { status: found.status, ...(found.error === undefined ? {} : { error: found.error }) };
  },
  pollIntervalMs: config.CONSISTENCY_AUDIT_EXECUTION_POLL_INTERVAL_MS,
  onError: failure => {
    logger.warn({
      runId: failure.runId,
      phase: failure.phase,
      error: sanitizePublicError(
        failure.error instanceof Error ? failure.error.message : "Unknown audit run execution error"
      )
    }, "Audit run execution failed");
  }
});
export const automationScheduler = new AutomationScheduler(auditStore, auditRunPlanner, {
  pollIntervalMs: config.CONSISTENCY_AUTOMATION_SCHEDULER_INTERVAL_MS,
  onError: failure => {
    logger.warn({
      automationId: failure.automationId,
      error: sanitizePublicError(
        failure.error instanceof Error ? failure.error.message : "Unknown automation scheduler error"
      )
    }, "Automation scheduler evaluation failed");
  }
});

/**
 * Read-only, multi-repository observation. The sink persists evidence and may
 * plan a durable `created` AuditRun; it never queues execution or runs code from
 * a monitored checkout.
 */
export const repositorySupervisor = new RepositorySupervisor(
  repositorySupervisorRegistrations(),
  {
    sink: {
      writePulse: (repositoryId, pulse) => {
        auditStore.saveRepositoryPulse(repositoryId, pulse);
      },
      writeChangeEvent: event => {
        const persisted = auditStore.saveRepositoryEvent(event);
        auditRunPlanner.planRepositoryEvent(persisted);
        try {
          workflowTriggerPlanner.planRepositoryEvent(persisted);
        } catch (error) {
          // Trigger planning must never break supervision; the durable event
          // stays persisted and planning failure is logged sanitized.
          logger.warn({
            error: sanitizePublicError(
              error instanceof Error ? error.message : "Unknown workflow trigger planning error"
            )
          }, "Workflow trigger planning failed");
        }
      }
    },
    onError: failure => {
      logger.warn({
        repositoryId: failure.repositoryId,
        phase: failure.phase,
        error: sanitizePublicError(
          failure.error instanceof Error ? failure.error.message : "Unknown repository supervision error"
        )
      }, "Repository supervision failed");
    }
  }
);

async function reconcileRepositorySupervisor(): Promise<void> {
  await repositorySupervisor.reconcile(repositorySupervisorRegistrations());
  if (automationScheduler.isRunning) automationScheduler.tick();
}

export const server = createApiServer({
  jobs,
  pullRequestService: new RepositoryPullRequestService({
    authenticator,
    publicReadToken: config.GITHUB_PUBLIC_READ_TOKEN,
    jobs,
    listRemotes: async localPath => new LocalGitAdapter({ root: localPath }).getRemotes()
  }),
  runtimeRegistry,
  workflowRuntime: workflowRuntimeHost,
  githubWebhookSecret: config.GITHUB_WEBHOOK_SECRET,
  apiToken: config.CONSISTENCY_API_TOKEN,
  desktopControlToken: config.CONSISTENCY_DESKTOP_CONTROL_TOKEN,
  nodeEnv: config.NODE_ENV,
  allowedOrigins: config.allowedOrigins,
  workspaceRoot: config.workspaceRoot,
  settingsWritable: config.settingsWritable,
  settings: {
    get: () => settingsStore.snapshot(process.env),
    update: patch => settingsStore.update(patch)
  },
  realData: () => loadRealData(),
  publicPrAnalysisEnabled: config.publicPrAnalysisEnabled,
  notebookEnabled: config.notebookEnabled,
  notebookStore,
  notebookGraph,
  resolveReviewModel: override => resolveReviewModel({ config, override }),
  publicRepositoryConnect: input => connectPublicGitHubRepository({
    input,
    store: auditStore,
    authenticator,
    publicReadToken: config.GITHUB_PUBLIC_READ_TOKEN
  }),
  // Settings "Test Connection" probe: bounded, read-only. Without a draft it
  // targets the ACTIVE process credential; CKPT4 Phase 2C lets the caller
  // probe one unsaved draft PAT in place of it — the draft exists only for the
  // duration of a single request and is never persisted or logged here.
  testGitHubConnection: draft => testGitHubConnection({
    publicReadToken: config.GITHUB_PUBLIC_READ_TOKEN,
    appAuthenticator: authenticator,
    publicPrAnalysisEnabled: config.publicPrAnalysisEnabled,
    ...(draft?.publicReadToken === undefined ? {} : { draftPublicReadToken: draft.publicReadToken })
  }),
  // GitHub OAuth Device Flow sign-in. The client id is a public setting; the
  // flow stores the device_code and access token only inside this process and
  // hands the token once to the renderer for the existing credential save path.
  githubOauth: new GitHubOauthDeviceFlow(config.GITHUB_OAUTH_CLIENT_ID ?? ""),
  publicPr: (url, modelOverride) => enqueuePublicPrReview({
    url,
    jobs,
    repositoryStore: auditStore,
    publicReadToken: config.GITHUB_PUBLIC_READ_TOKEN,
    llmProvider: modelOverride?.provider,
    llmModel: modelOverride?.model
  }),
  llmProviderConfigured: Boolean(provider),
  // CKPT6 Phase 3: provider channel for the workflow copilot proposal route.
  // Model resolution stays behind options.resolveReviewModel; this factory only
  // materializes the per-request provider (deepseek/openai) for invokeWithSchema.
  copilotProvider: resolved => createReviewLLMProvider(config, resolved),
  // Fail-closed: without explicit CONSISTENCY_LOCAL_REVIEW_ROOTS the legacy
  // endpoint stays disabled entirely — http.ts reports a missing localReview
  // dependency as LOCAL_REVIEW_UNAVAILABLE (503) instead of falling back to
  // any implicit root. Registered checkout paths only extend what a review may
  // read after an operator configures explicit roots.
  localReview: config.localReviewRoots.length === 0 ? undefined : input => {
    const registeredLocalRoots: string[] = [];
    if (auditStore) {
      for (const repo of auditStore.listRepositories()) {
        if (repo.source === "local_git") {
          const p = auditStore.getLocalRepositoryPath(repo.id);
          if (p) registeredLocalRoots.push(p);
        }
      }
    }
    const heartbeatRoot = heartbeat.latest()?.repository.root;
    if (heartbeatRoot && heartbeatRoot !== "unknown") {
      registeredLocalRoots.push(heartbeatRoot);
    }
    const projectRoot = findProjectRoot();
    const combinedRoots = [
      ...config.localReviewRoots,
      ...registeredLocalRoots,
      ...(projectRoot ? [projectRoot] : [])
    ];

    return triggerLocalReview(jobs, input, {
      allowedRoots: combinedRoots
    });
  },
  auditStore,
  auditPlanner: auditRunPlanner,
  automationScheduler,
  auditExecution: { enabled: config.auditExecutionEnabled },
  onAuditRepositoriesChanged: reconcileRepositorySupervisor,
  onWorkflowBindingsChanged: reconcileRepositorySupervisor,
  workflows,
  jobDiff: jobId => resolveJobDiff(jobId, {
    jobs,
    workspaceRoot: config.workspaceRoot
  }),
  heartbeat: {
    latest: () => heartbeat.latest(),
    subscribe: subscriber => heartbeat.subscribe(subscriber)
  },
  healthDetails: () => ({
    database: { ok: database.open },
    worker: worker.status(),
    publishWorker: publishWorker.status(),
    deterministicAnalyzer: deterministicAnalyzer.status(),
    llmConfigured: Boolean(provider),
    llmProvider: provider?.name ?? "none",
    llmModel: provider?.model ?? undefined,
    llmCapabilities: {
      deepseek: {
        configured: Boolean(config.DEEPSEEK_API_KEY),
        defaultModel: config.DEEPSEEK_MODEL
      },
      openai: {
        configured: Boolean(config.OPENAI_API_KEY),
        defaultModel: config.OPENAI_MODEL
      }
    },
    publicPrAnalysis: config.publicPrAnalysisEnabled,
    publicPrAccessMode: config.publicPrAnalysisEnabled
      ? config.GITHUB_PUBLIC_READ_TOKEN ? "pat" : "anonymous"
      : "disabled",
    notebook: config.notebookEnabled,
    configuration: {
      githubAppConfigured: Boolean(config.GITHUB_APP_ID && config.GITHUB_PRIVATE_KEY),
      webhookSecretConfigured: Boolean(config.GITHUB_WEBHOOK_SECRET),
      publicReadTokenConfigured: Boolean(config.GITHUB_PUBLIC_READ_TOKEN),
      storage: {
        kind: config.databasePath === ":memory:" ? "memory" : "file",
        configured: config.databasePath.trim().length > 0
      },
      workerConcurrency: config.CONSISTENCY_WORKER_CONCURRENCY,
      publishWorkerConcurrency: config.CONSISTENCY_PUBLISH_WORKER_CONCURRENCY,
      // Effective review pipeline workflow name. config.reviewWorkflow is null
      // only for the documented "legacy" opt-out, so this round-trips the
      // CONSISTENCY_REVIEW_WORKFLOW value the process actually runs with.
      reviewWorkflow: config.reviewWorkflow ?? "legacy"
    }
  })
});

let shutdownPromise: Promise<void> | null = null;

export async function shutdownApplication(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    // 1. Stop receiving HTTP requests
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // 2. Stop schedulers and read-only observers before persistence is closed.
    try {
      workflowTriggerExecutor.stop();
    } catch (err) {
      logger.error({ error: err }, "Error stopping workflow trigger executor during shutdown");
    }
    try {
      auditRunExecutor.stop();
    } catch (err) {
      logger.error({ error: err }, "Error stopping audit run executor during shutdown");
    }
    try {
      automationScheduler.stop();
    } catch (err) {
      logger.error({ error: err }, "Error stopping automation scheduler during shutdown");
    }
    try {
      repositorySupervisor.stop();
    } catch (err) {
      logger.error({ error: err }, "Error stopping repository supervisor during shutdown");
    }
    try {
      heartbeat.stop();
    } catch (err) {
      logger.error({ error: err }, "Error stopping heartbeat during shutdown");
    }
    // 3. Stop ReviewWorker (stops producing new Outbox items)
    try {
      await worker.stop();
    } catch (err) {
      logger.error({ error: err }, "Error stopping review worker during shutdown");
    }
    // 3. Stop PublishWorker (waits for / aborts active in-flight publish tasks)
    try {
      await publishWorker.stop();
    } catch (err) {
      logger.error({ error: err }, "Error stopping publish worker during shutdown");
    }
    // 4. Close DeterministicAnalyzer process
    try {
      await deterministicAnalyzer.shutdown();
    } catch (err) {
      logger.error({ error: err }, "Error shutting down deterministic analyzer during shutdown");
    }
    // 5. Close database connection
    try {
      database.close();
    } catch (err) {
      logger.error({ error: err }, "Error closing database during shutdown");
    }
  })();

  return shutdownPromise;
}

const handleSignal = (signal: string) => {
  logger.info({ signal }, "Received shutdown signal");
  shutdownApplication()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ error: err }, "Graceful application shutdown failed");
      process.exit(1);
    });
};

process.once("SIGTERM", () => handleSignal("SIGTERM"));
process.once("SIGINT", () => handleSignal("SIGINT"));

server.on("close", () => {
  void shutdownApplication();
});

if (process.env.NODE_ENV !== "test") {
  if (config.CONSISTENCY_WORKERS_ENABLED) {
    worker.start();
    publishWorker.start();
  }
  heartbeat.start();
  automationScheduler.start();
  if (config.workflowTriggersEnabled) {
    workflowTriggerExecutor.start();
  }
  if (config.auditExecutionEnabled) {
    // Order matters: the workflow host already marked ITS interrupted runs
    // failed above, so linked audit runs resolve to a terminal outcome here
    // and restart honesty mirrors real history instead of inventing one.
    const reconciledAuditRuns = auditRunExecutor.reconcileInterruptedRuns();
    if (reconciledAuditRuns > 0) {
      logger.warn(
        { interruptedAuditRuns: reconciledAuditRuns },
        "Reconciled audit runs left active by the previous process"
      );
    }
    auditRunExecutor.start();
  }
  void repositorySupervisor.start().catch(error => {
    logger.error({
      error: sanitizePublicError(error instanceof Error ? error.message : "Unknown repository supervision error")
    }, "Repository supervisor failed to start");
  });
  server.listen(config.PORT, config.HOST, () => {
    logger.info({
      host: config.HOST,
      port: config.PORT,
      llmProvider: provider ? provider.name : "none",
      workerConcurrency: config.CONSISTENCY_WORKER_CONCURRENCY,
      publishWorkerConcurrency: config.CONSISTENCY_PUBLISH_WORKER_CONCURRENCY,
      // Surfaced at startup because any checkout under these roots is readable
      // through POST /reviews/local.
      localReviewRootCount: config.localReviewRoots.length
    }, "ConsistenCy API listening");

    if (config.localReviewRootsAreDefaulted) {
      logger.warn({
        localReviewRootCount: config.localReviewRoots.length
      }, "CONSISTENCY_LOCAL_REVIEW_ROOTS is unset; the legacy local review endpoint (POST /reviews/local) is disabled until explicit review roots are configured");
    }
  });
}
