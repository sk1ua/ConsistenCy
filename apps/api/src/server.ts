import { createApiServer } from "./http";
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
import { createContextBuilder } from "./review/context/contextRouter";
import { triggerLocalReview } from "./trigger/local";
import { HeartbeatDaemon } from "./heartbeat/daemon";
import { LocalGitAdapter } from "@consistency/vcs-core";
import { createLLMProvider } from "./review/llm/factory";
import { redactSensitiveText, sanitizePublishFailure } from "./security/redact";
import { loadRealData } from "./data/realData";
import { DeterministicAnalyzer } from "./review/deterministic";
import { SQLiteNotebookStore } from "./notebook/store";
import { RepositorySnapshotIndexer } from "./notebook/indexer";
import { NotebookGraph } from "./notebook/graph";
import { enqueuePublicPrReview } from "./review/publicPr";
import { fileURLToPath } from "node:url";

const { config, store: settingsStore } = loadRuntimeConfig();
const database = openDatabase(config.databasePath);
runMigrations(database);
const jobs = new SQLiteJobStore(database);
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
  demoWorkspacePath: fileURLToPath(new URL("./notebook/demo-snapshot", import.meta.url)),
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

export const worker = new ReviewWorker({
  jobStore: jobs,
  concurrency: config.CONSISTENCY_WORKER_CONCURRENCY,
  pollIntervalMs: config.CONSISTENCY_WORKER_POLL_INTERVAL_MS,
  workflow: {
    provider,
    deterministicAnalyzer,
    reportLanguage: config.reportLanguage,
    reviewWorkflow: config.reviewWorkflow,
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

export const server = createApiServer({
  jobs,
  githubWebhookSecret: config.GITHUB_WEBHOOK_SECRET,
  apiToken: config.CONSISTENCY_API_TOKEN,
  nodeEnv: config.NODE_ENV,
  allowedOrigins: config.allowedOrigins,
  workspaceRoot: config.workspaceRoot,
  settings: {
    get: () => settingsStore.snapshot(process.env),
    update: patch => settingsStore.update(patch)
  },
  realData: () => loadRealData(),
  publicPrAnalysisEnabled: config.publicPrAnalysisEnabled,
  notebookEnabled: config.notebookEnabled,
  notebookStore,
  notebookGraph,
  publicPr: url => enqueuePublicPrReview({
    url,
    jobs,
    publicReadToken: config.GITHUB_PUBLIC_READ_TOKEN
  }),
  localReview: input => triggerLocalReview(jobs, input, {
    allowedRoots: config.localReviewRoots
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
    llmProvider: provider.name,
    llmModel: provider.model,
    publicPrAnalysis: config.publicPrAnalysisEnabled,
    publicPrAccessMode: config.publicPrAnalysisEnabled
      ? config.GITHUB_PUBLIC_READ_TOKEN ? "pat" : "anonymous"
      : "disabled",
    notebook: config.notebookEnabled,
    configuration: {
      githubAppConfigured: Boolean(config.GITHUB_APP_ID && config.GITHUB_PRIVATE_KEY),
      webhookSecretConfigured: Boolean(config.GITHUB_WEBHOOK_SECRET),
      publicReadTokenConfigured: Boolean(config.GITHUB_PUBLIC_READ_TOKEN),
      databasePath: config.databasePath,
      workerConcurrency: config.CONSISTENCY_WORKER_CONCURRENCY,
      publishWorkerConcurrency: config.CONSISTENCY_PUBLISH_WORKER_CONCURRENCY,
      demoMode: provider.name === "mock"
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
    // 2. Stop the heartbeat first: it only observes, so nothing depends on it.
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
  server.listen(config.PORT, config.HOST, () => {
    logger.info({
      host: config.HOST,
      port: config.PORT,
      llmProvider: provider.name,
      workerConcurrency: config.CONSISTENCY_WORKER_CONCURRENCY,
      publishWorkerConcurrency: config.CONSISTENCY_PUBLISH_WORKER_CONCURRENCY,
      // Surfaced at startup because any checkout under these roots is readable
      // through POST /reviews/local.
      localReviewRoots: config.localReviewRoots
    }, "ConsistenCy API listening");

    if (config.localReviewRootsAreDefaulted) {
      logger.warn({
        localReviewRoots: config.localReviewRoots
      }, "CONSISTENCY_LOCAL_REVIEW_ROOTS is unset; every repository under the project's parent directory can be read via POST /reviews/local");
    }
  });
}
