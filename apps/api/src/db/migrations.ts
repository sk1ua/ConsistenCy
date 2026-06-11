import type { ConsistencyDatabase } from "./connection";

export type Migration = {
  id: string;
  up(database: ConsistencyDatabase): void;
};

export const migrations: readonly Migration[] = [
  {
    id: "0001_review_storage",
    up(database) {
      database.exec(`
        CREATE TABLE webhook_deliveries (
          delivery_id TEXT PRIMARY KEY,
          event TEXT NOT NULL,
          action TEXT,
          received_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('enqueued', 'ignored', 'failed'))
        );

        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type = 'PR_REVIEW'),
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
          repository_full_name TEXT NOT NULL,
          pull_request_number INTEGER NOT NULL,
          installation_id INTEGER,
          base_sha TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          delivery_id TEXT UNIQUE,
          sender_login TEXT,
          action TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          error TEXT,
          FOREIGN KEY (delivery_id) REFERENCES webhook_deliveries(delivery_id)
        );

        CREATE INDEX jobs_status_created_at_idx ON jobs(status, created_at);

        CREATE TABLE agent_runs (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          input_summary TEXT NOT NULL,
          findings_json TEXT NOT NULL,
          error TEXT,
          token_usage_json TEXT,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        );

        CREATE INDEX agent_runs_job_id_idx ON agent_runs(job_id, started_at);

        CREATE TABLE reports (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL UNIQUE,
          report_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          github_comment_status TEXT NOT NULL DEFAULT 'pending',
          github_comment_error TEXT,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        );
      `);
    }
  }
];

function ensureMigrationTable(database: ConsistencyDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

export function runMigrations(
  database: ConsistencyDatabase,
  pendingMigrations: readonly Migration[] = migrations
): string[] {
  ensureMigrationTable(database);
  const appliedIds = new Set(
    database.prepare("SELECT id FROM schema_migrations").all().map(row => (row as { id: string }).id)
  );
  const newlyApplied: string[] = [];

  for (const migration of [...pendingMigrations].sort((left, right) => left.id.localeCompare(right.id))) {
    if (appliedIds.has(migration.id)) {
      continue;
    }
    database.transaction(() => {
      migration.up(database);
      database
        .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, new Date().toISOString());
    })();
    newlyApplied.push(migration.id);
    appliedIds.add(migration.id);
  }

  return newlyApplied;
}
