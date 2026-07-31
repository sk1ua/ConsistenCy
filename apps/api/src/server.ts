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
import { buildPRContext } from "./review/context/buildPRContext";
import { createLLMProvider } from "./review/llm/factory";
import { redactSensitiveText, sanitizePublishFailure } from "./security/redact";
import { loadRealData } from "./data/realData";
import { DeterministicAnalyzer } from "./review/deterministic";

const { config, store: settingsStore } = loadRuntimeConfig();
const database = openDatabase(config.databasePath);
runMigrations(database);
const jobs = new SQLiteJobStore(database);
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

export const worker = new ReviewWorker({
  jobStore: jobs,
  concurrency: config.CONSISTENCY_WORKER_CONCURRENCY,
  pollIntervalMs: config.CONSISTENCY_WORKER_POLL_INTERVAL_MS,
  workflow: {
    provider,
    deterministicAnalyzer,
    contextBuilder: input => {
      if (!authenticator) throw new Error("GitHub App credentials are required to build PR context");
      return buildPRContext(input, { authenticator, workspaceRoot: config.workspaceRoot });
    }
  },
  onError: (error, job) => {
    logger.error({
      jobId: job?.id,
      error: error instanceof Error ? redactSensitiveText(error.message) : "Unknown worker error"
    }, "Review worker failed a job");
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
  healthDetails: () => ({
    database: { ok: database.open },
    worker: worker.status(),
    publishWorker: publishWorker.status(),
    deterministicAnalyzer: deterministicAnalyzer.status(),
    llmProvider: provider.name,
    configuration: {
      githubAppConfigured: Boolean(config.GITHUB_APP_ID && config.GITHUB_PRIVATE_KEY),
      webhookSecretConfigured: Boolean(config.GITHUB_WEBHOOK_SECRET),
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
    // 2. Stop ReviewWorker (stops producing new Outbox items)
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
  server.listen(config.PORT, config.HOST, () => {
    logger.info({
      host: config.HOST,
      port: config.PORT,
      llmProvider: provider.name,
      workerConcurrency: config.CONSISTENCY_WORKER_CONCURRENCY,
      publishWorkerConcurrency: config.CONSISTENCY_PUBLISH_WORKER_CONCURRENCY
    }, "ConsistenCy API listening");
  });
}
