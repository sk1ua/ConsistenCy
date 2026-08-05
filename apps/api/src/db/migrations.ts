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
  },
  {
    id: "0002_publish_outbox",
    up(database) {
      database.exec(`
        CREATE TABLE jobs_v2 (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type = 'PR_REVIEW'),
          status TEXT NOT NULL CHECK (status IN (
            'queued', 'running', 'awaiting_publish', 'publishing',
            'succeeded', 'failed', 'publish_failed', 'cancelled'
          )),
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

        INSERT INTO jobs_v2 SELECT * FROM jobs;
        DROP TABLE jobs;
        ALTER TABLE jobs_v2 RENAME TO jobs;

        CREATE INDEX jobs_status_created_at_idx ON jobs(status, created_at);

        CREATE TABLE publish_outbox (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          target TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'pending', 'leased', 'retrying', 'published', 'failed', 'skipped'
          )),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          next_attempt_at TEXT,
          lease_owner TEXT,
          lease_expires_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(job_id, target),
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        );

        CREATE INDEX publish_outbox_claim_idx ON publish_outbox(status, next_attempt_at, lease_expires_at);
      `);

      const violations = database.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(`Foreign key integrity check failed after migration 0002_publish_outbox: ${JSON.stringify(violations)}`);
      }
    }
  },
  {
    id: "0003_publish_outbox_leasing",
    up(database) {
      database.exec(`
        ALTER TABLE publish_outbox
          ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE publish_outbox
          ADD COLUMN external_id TEXT;
      `);
    }
  },
  {
    id: "0004_review_publication_policy",
    up(database) {
      database.exec(`
        ALTER TABLE jobs
          ADD COLUMN publication_policy TEXT NOT NULL DEFAULT 'github_comment'
          CHECK (publication_policy IN ('github_comment', 'disabled'));
      `);
    }
  },
  {
    id: "0005_repository_notebook",
    up(database) {
      database.exec(`
        CREATE TABLE notebooks (
          id TEXT PRIMARY KEY,
          repository_full_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX notebooks_repository_updated_idx ON notebooks(repository_full_name, updated_at);

        CREATE TABLE notebook_sources (
          id TEXT PRIMARY KEY,
          notebook_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          repository_full_name TEXT NOT NULL,
          pull_request_number INTEGER NOT NULL,
          base_sha TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          index_status TEXT NOT NULL CHECK (index_status IN ('queued', 'indexing', 'ready', 'failed')),
          indexed_at TEXT,
          error TEXT,
          UNIQUE(notebook_id, job_id),
          FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        );

        CREATE INDEX notebook_sources_notebook_idx ON notebook_sources(notebook_id, head_sha);

        CREATE TABLE notebook_messages (
          id TEXT PRIMARY KEY,
          notebook_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'degraded')),
          source_job_ids_json TEXT NOT NULL,
          citations_json TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          token_usage_json TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
        );

        CREATE INDEX notebook_messages_notebook_created_idx ON notebook_messages(notebook_id, created_at);

        CREATE TABLE notebook_cards (
          id TEXT PRIMARY KEY,
          notebook_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('change_map', 'architecture_impact', 'risk_brief', 'fix_plan')),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          source_job_ids_json TEXT NOT NULL,
          citations_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('generated', 'degraded', 'failed')),
          provider TEXT,
          model TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
        );

        CREATE INDEX notebook_cards_notebook_created_idx ON notebook_cards(notebook_id, created_at);

        CREATE TABLE repository_snapshot_indexes (
          id TEXT PRIMARY KEY,
          repository_full_name TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'indexing', 'ready', 'failed')),
          workspace_path TEXT,
          manifest_json TEXT NOT NULL DEFAULT '[]',
          indexed_at TEXT,
          error TEXT,
          UNIQUE(repository_full_name, head_sha)
        );
      `);
    }
  },
  {
    id: "0006_agent_run_provider_metadata",
    up(database) {
      database.exec(`
        ALTER TABLE agent_runs ADD COLUMN provider TEXT;
        ALTER TABLE agent_runs ADD COLUMN model TEXT;
      `);
    }
  },
  {
    id: "0007_notebook_citations",
    up(database) {
      database.exec(`
        CREATE TABLE notebook_citations (
          id TEXT PRIMARY KEY,
          notebook_id TEXT NOT NULL,
          message_id TEXT,
          card_id TEXT,
          repository_full_name TEXT NOT NULL,
          pull_request_number INTEGER NOT NULL,
          job_id TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          file TEXT NOT NULL,
          start_line INTEGER NOT NULL CHECK (start_line > 0),
          end_line INTEGER NOT NULL CHECK (end_line >= start_line),
          excerpt TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('file', 'diff', 'evidence', 'finding', 'history')),
          CHECK ((message_id IS NOT NULL) <> (card_id IS NOT NULL)),
          FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
          FOREIGN KEY (message_id) REFERENCES notebook_messages(id) ON DELETE CASCADE,
          FOREIGN KEY (card_id) REFERENCES notebook_cards(id) ON DELETE CASCADE,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        );

        CREATE INDEX notebook_citations_message_idx ON notebook_citations(message_id);
        CREATE INDEX notebook_citations_card_idx ON notebook_citations(card_id);
        CREATE INDEX notebook_citations_source_idx ON notebook_citations(repository_full_name, head_sha, file, start_line);
      `);

      // Keep citations written by the first notebook migration readable after
      // moving them into their own relational table. Invalid legacy JSON is
      // ignored here; the original JSON columns remain as a compatibility
      // fallback for inspection and recovery.
      const insertCitation = database.prepare(`
        INSERT OR IGNORE INTO notebook_citations (
          id, notebook_id, message_id, card_id, repository_full_name,
          pull_request_number, job_id, head_sha, file, start_line, end_line,
          excerpt, kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const citationKinds = new Set(["file", "diff", "evidence", "finding", "history"]);
      for (const row of database.prepare("SELECT * FROM notebook_messages").all() as Array<Record<string, unknown>>) {
        let citations: unknown[] = [];
        try {
          citations = JSON.parse(String(row.citations_json ?? "[]")) as unknown[];
        } catch {
          citations = [];
        }
        for (const value of citations) {
          if (!value || typeof value !== "object") continue;
          const citation = value as Record<string, unknown>;
          if (
            typeof citation.id !== "string" ||
            typeof citation.repository !== "string" ||
            typeof citation.pullRequestNumber !== "number" ||
            typeof citation.jobId !== "string" ||
            typeof citation.headSha !== "string" ||
            typeof citation.file !== "string" ||
            typeof citation.startLine !== "number" ||
            typeof citation.endLine !== "number" ||
            typeof citation.excerpt !== "string" ||
            typeof citation.kind !== "string" ||
            citation.pullRequestNumber <= 0 ||
            citation.startLine <= 0 ||
            citation.endLine < citation.startLine ||
            !citation.id ||
            !citation.repository ||
            !citation.jobId ||
            !citation.headSha ||
            !citation.file ||
            !citation.excerpt.trim() ||
            !citationKinds.has(citation.kind) ||
            !database.prepare("SELECT 1 FROM jobs WHERE id = ?").get(citation.jobId)
          ) continue;
          insertCitation.run(
            citation.id, row.notebook_id, row.id, null, citation.repository,
            citation.pullRequestNumber, citation.jobId, citation.headSha,
            citation.file, citation.startLine, citation.endLine, citation.excerpt,
            citation.kind
          );
        }
      }
      for (const row of database.prepare("SELECT * FROM notebook_cards").all() as Array<Record<string, unknown>>) {
        let citations: unknown[] = [];
        try {
          citations = JSON.parse(String(row.citations_json ?? "[]")) as unknown[];
        } catch {
          citations = [];
        }
        for (const value of citations) {
          if (!value || typeof value !== "object") continue;
          const citation = value as Record<string, unknown>;
          if (
            typeof citation.id !== "string" ||
            typeof citation.repository !== "string" ||
            typeof citation.pullRequestNumber !== "number" ||
            typeof citation.jobId !== "string" ||
            typeof citation.headSha !== "string" ||
            typeof citation.file !== "string" ||
            typeof citation.startLine !== "number" ||
            typeof citation.endLine !== "number" ||
            typeof citation.excerpt !== "string" ||
            typeof citation.kind !== "string" ||
            citation.pullRequestNumber <= 0 ||
            citation.startLine <= 0 ||
            citation.endLine < citation.startLine ||
            !citation.id ||
            !citation.repository ||
            !citation.jobId ||
            !citation.headSha ||
            !citation.file ||
            !citation.excerpt.trim() ||
            !citationKinds.has(citation.kind) ||
            !database.prepare("SELECT 1 FROM jobs WHERE id = ?").get(citation.jobId)
          ) continue;
          insertCitation.run(
            citation.id, row.notebook_id, null, row.id, citation.repository,
            citation.pullRequestNumber, citation.jobId, citation.headSha,
            citation.file, citation.startLine, citation.endLine, citation.excerpt,
            citation.kind
          );
        }
      }
    }
  },
  {
    id: "0008_public_read_access_mode",
    up(database) {
      database.exec(`
        ALTER TABLE jobs
          ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'github_app'
          CHECK (access_mode IN ('github_app', 'public_read'));
      `);
    }
  },
  {
    id: "0009_local_git_jobs",
    up(database) {
      // SQLite cannot relax NOT NULL in place, so the table is rebuilt the same
      // way 0002 did. Columns are listed explicitly rather than using
      // `SELECT *` because the shape changes here.
      database.exec(`
        CREATE TABLE jobs_v3 (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type = 'PR_REVIEW'),
          status TEXT NOT NULL CHECK (status IN (
            'queued', 'running', 'awaiting_publish', 'publishing',
            'succeeded', 'failed', 'publish_failed', 'cancelled'
          )),
          repository_full_name TEXT NOT NULL,
          pull_request_number INTEGER,
          repo_path TEXT,
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
          publication_policy TEXT NOT NULL DEFAULT 'github_comment'
            CHECK (publication_policy IN ('github_comment', 'disabled')),
          access_mode TEXT NOT NULL DEFAULT 'github_app'
            CHECK (access_mode IN ('github_app', 'public_read', 'local_git')),
          CHECK (access_mode = 'local_git' OR pull_request_number IS NOT NULL),
          CHECK (access_mode <> 'local_git' OR repo_path IS NOT NULL),
          CHECK (access_mode <> 'local_git' OR publication_policy = 'disabled'),
          FOREIGN KEY (delivery_id) REFERENCES webhook_deliveries(delivery_id)
        );

        INSERT INTO jobs_v3 (
          id, type, status, repository_full_name, pull_request_number, repo_path,
          installation_id, base_sha, head_sha, delivery_id, sender_login, action,
          created_at, updated_at, started_at, finished_at, error,
          publication_policy, access_mode
        )
        SELECT
          id, type, status, repository_full_name, pull_request_number, NULL,
          installation_id, base_sha, head_sha, delivery_id, sender_login, action,
          created_at, updated_at, started_at, finished_at, error,
          publication_policy, access_mode
        FROM jobs;

        DROP TABLE jobs;
        ALTER TABLE jobs_v3 RENAME TO jobs;

        CREATE INDEX jobs_status_created_at_idx ON jobs(status, created_at);
      `);

      const violations = database.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(`Foreign key integrity check failed after migration 0009_local_git_jobs: ${JSON.stringify(violations)}`);
      }
    }
  },
  {
    id: "0010_local_notebook_sources",
    up(database) {
      // Local repository reviews have no pull request, so notebook sources
      // must allow a NULL pull_request_number.
      database.exec(`
        CREATE TABLE notebook_sources_v2 (
          id TEXT PRIMARY KEY,
          notebook_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          repository_full_name TEXT NOT NULL,
          pull_request_number INTEGER,
          base_sha TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          index_status TEXT NOT NULL CHECK (index_status IN ('queued', 'indexing', 'ready', 'failed')),
          indexed_at TEXT,
          error TEXT,
          UNIQUE(notebook_id, job_id),
          FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        );

        INSERT INTO notebook_sources_v2 SELECT * FROM notebook_sources;
        DROP TABLE notebook_sources;
        ALTER TABLE notebook_sources_v2 RENAME TO notebook_sources;

        CREATE INDEX notebook_sources_notebook_idx ON notebook_sources(notebook_id, head_sha);
        PRAGMA foreign_key_check;
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

    try {
      database.pragma("foreign_keys = OFF");
      database.transaction(() => {
        migration.up(database);
        database
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, new Date().toISOString());
      })();
    } finally {
      database.pragma("foreign_keys = ON");
    }

    newlyApplied.push(migration.id);
    appliedIds.add(migration.id);
  }

  return newlyApplied;
}
