import { loadEnvFile } from "node:process";
import { createApiServer } from "./http";
import { loadEnv } from "./config/env";
import { logger } from "./config/logger";
import { openDatabase } from "./db/connection";
import { runMigrations } from "./db/migrations";
import { SQLiteJobStore } from "./jobs/sqliteJobStore";
import { ReviewWorker } from "./jobs/worker";
import { GitHubAppAuthenticator } from "./github/auth";
import { buildPRContext } from "./review/context/buildPRContext";
import { createLLMProvider } from "./review/llm/factory";
import { publishPullRequestComment } from "./github/comment";
import { renderReviewComment } from "./review/report/markdownRenderer";
import { redactSensitiveText } from "./security/redact";

try {
  loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
const config = loadEnv();
const database = openDatabase(config.databasePath);
runMigrations(database);
const jobs = new SQLiteJobStore(database);
const recoveredJobs = jobs.recoverStaleRunningJobs(new Date(Date.now() - 15 * 60 * 1_000));
if (recoveredJobs > 0) {
  logger.warn({ recoveredJobs }, "Recovered interrupted review jobs");
}
const provider = createLLMProvider(config);
const authenticator = config.GITHUB_APP_ID && config.GITHUB_PRIVATE_KEY
  ? new GitHubAppAuthenticator({ appId: config.GITHUB_APP_ID, privateKey: config.GITHUB_PRIVATE_KEY })
  : undefined;
export const worker = new ReviewWorker({
  jobStore: jobs,
  concurrency: config.CONSISTENCY_WORKER_CONCURRENCY,
  pollIntervalMs: config.CONSISTENCY_WORKER_POLL_INTERVAL_MS,
  workflow: {
    provider,
    contextBuilder: input => {
      if (!authenticator) throw new Error("GitHub App credentials are required to build PR context");
      return buildPRContext(input, { authenticator, workspaceRoot: config.workspaceRoot });
    },
    publishReport: async report => {
      if (!authenticator) throw new Error("GitHub App credentials are required to publish PR comments");
      const job = jobs.get(report.jobId);
      if (!job?.installationId) throw new Error("Review job is missing its GitHub installation id");
      const authentication = await authenticator.getInstallationToken(job.installationId);
      await publishPullRequestComment({
        repositoryFullName: report.repositoryFullName,
        pullRequestNumber: report.pullRequestNumber,
        token: authentication.token,
        body: renderReviewComment(report, {
          providerName: provider.name,
          webBaseUrl: config.CONSISTENCY_WEB_URL
        })
      });
    }
  },
  onError: (error, job) => {
    logger.error({
      jobId: job?.id,
      error: error instanceof Error ? redactSensitiveText(error.message) : "Unknown worker error"
    }, "Review worker failed a job");
  }
});

export const server = createApiServer({
  jobs,
  githubWebhookSecret: config.GITHUB_WEBHOOK_SECRET,
  apiToken: config.CONSISTENCY_API_TOKEN,
  nodeEnv: config.NODE_ENV,
  allowedOrigins: config.allowedOrigins,
  workspaceRoot: config.workspaceRoot,
  healthDetails: () => ({
    database: { ok: database.open },
    worker: worker.status(),
    llmProvider: provider.name,
    configuration: {
      githubAppConfigured: Boolean(config.GITHUB_APP_ID && config.GITHUB_PRIVATE_KEY),
      webhookSecretConfigured: Boolean(config.GITHUB_WEBHOOK_SECRET),
      databasePath: config.databasePath,
      workerConcurrency: config.CONSISTENCY_WORKER_CONCURRENCY,
      demoMode: provider.name === "mock"
    }
  })
});
server.on("close", () => {
  void worker.stop().finally(() => database.close());
});

if (process.env.NODE_ENV !== "test") {
  worker.start();
  server.listen(config.PORT, config.HOST, () => {
    logger.info({
      host: config.HOST,
      port: config.PORT,
      llmProvider: provider.name,
      workerConcurrency: config.CONSISTENCY_WORKER_CONCURRENCY
    }, "ConsistenCy API listening");
  });
}
