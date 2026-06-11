import { createApiServer } from "./http";
import { loadEnv } from "./config/env";
import { logger } from "./config/logger";
import { openDatabase } from "./db/connection";
import { runMigrations } from "./db/migrations";
import { SQLiteJobStore } from "./jobs/sqliteJobStore";

const config = loadEnv();
const database = openDatabase(config.databasePath);
runMigrations(database);
const jobs = new SQLiteJobStore(database);
const recoveredJobs = jobs.recoverStaleRunningJobs(new Date(Date.now() - 15 * 60 * 1_000));
if (recoveredJobs > 0) {
  logger.warn({ recoveredJobs }, "Recovered interrupted review jobs");
}

export const server = createApiServer({ jobs, githubWebhookSecret: config.GITHUB_WEBHOOK_SECRET });
server.on("close", () => database.close());

if (process.env.NODE_ENV !== "test") {
  server.listen(config.PORT, config.HOST, () => {
    logger.info({ host: config.HOST, port: config.PORT }, "ConsistenCy API listening");
  });
}
