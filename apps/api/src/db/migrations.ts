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
  },
  {
    id: "0011_audit_control_plane",
    up(database) {
      database.exec(`
        CREATE TABLE repositories (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('local_git', 'github', 'gitlab')),
          identity_key TEXT NOT NULL UNIQUE,
          server_locator TEXT,
          remote_full_name TEXT,
          default_branch TEXT,
          trust_level TEXT NOT NULL CHECK (trust_level IN ('untrusted_readonly', 'trusted_local')),
          monitoring_enabled INTEGER NOT NULL DEFAULT 0 CHECK (monitoring_enabled IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (source = 'local_git' OR remote_full_name IS NOT NULL),
          CHECK (source = 'local_git' OR trust_level = 'untrusted_readonly')
        );

        CREATE INDEX repositories_source_updated_idx ON repositories(source, updated_at);

        CREATE TABLE repository_events (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN (
            'working_tree', 'commit_pushed', 'branch_switched',
            'pull_request', 'schedule', 'manual'
          )),
          source TEXT NOT NULL CHECK (source IN ('local_git', 'github', 'gitlab', 'scheduler', 'user')),
          dedupe_key TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          base_revision TEXT,
          head_revision TEXT,
          changed_files_json TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          UNIQUE(repository_id, dedupe_key),
          FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
        );

        CREATE INDEX repository_events_timeline_idx ON repository_events(repository_id, occurred_at DESC);

        CREATE TABLE workflow_revisions (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          digest TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(workflow_id, revision),
          UNIQUE(workflow_id, digest)
        );

        CREATE TABLE policy_revisions (
          id TEXT PRIMARY KEY,
          policy_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          name TEXT NOT NULL,
          digest TEXT NOT NULL,
          policy_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(policy_id, revision),
          UNIQUE(policy_id, digest)
        );

        CREATE TABLE automations (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL,
          name TEXT NOT NULL,
          trigger_json TEXT NOT NULL,
          workflow_revision_id TEXT NOT NULL,
          policy_revision_id TEXT NOT NULL,
          execution_profile TEXT NOT NULL CHECK (execution_profile IN ('static_readonly', 'trusted_sandbox')),
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(repository_id, name),
          FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
          FOREIGN KEY (workflow_revision_id) REFERENCES workflow_revisions(id),
          FOREIGN KEY (policy_revision_id) REFERENCES policy_revisions(id)
        );

        CREATE INDEX automations_repository_enabled_idx ON automations(repository_id, enabled, updated_at);

        CREATE TABLE audit_runs (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('manual', 'repository_event', 'schedule', 'legacy_job')),
          source_event_id TEXT,
          automation_id TEXT,
          workflow_revision_id TEXT NOT NULL,
          policy_revision_id TEXT NOT NULL,
          execution_profile TEXT NOT NULL CHECK (execution_profile IN ('static_readonly', 'trusted_sandbox')),
          base_revision TEXT,
          head_revision TEXT,
          status TEXT NOT NULL CHECK (status IN ('created', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
          risk_score REAL CHECK (risk_score BETWEEN 0 AND 100),
          coverage REAL CHECK (coverage BETWEEN 0 AND 1),
          policy_evaluation_json TEXT,
          publication_status TEXT NOT NULL CHECK (publication_status IN ('pending', 'published', 'failed', 'skipped')),
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          error TEXT,
          FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
          FOREIGN KEY (source_event_id) REFERENCES repository_events(id),
          FOREIGN KEY (automation_id) REFERENCES automations(id),
          FOREIGN KEY (workflow_revision_id) REFERENCES workflow_revisions(id),
          FOREIGN KEY (policy_revision_id) REFERENCES policy_revisions(id)
        );

        CREATE INDEX audit_runs_repository_created_idx ON audit_runs(repository_id, created_at DESC);
        CREATE INDEX audit_runs_status_created_idx ON audit_runs(status, created_at);

        CREATE TABLE run_step_artifacts (
          id TEXT PRIMARY KEY,
          audit_run_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          uses TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'timed_out')),
          required INTEGER NOT NULL CHECK (required IN (0, 1)),
          input_digest TEXT NOT NULL,
          tool_version TEXT,
          ruleset_digest TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          duration_ms INTEGER CHECK (duration_ms >= 0),
          evidence_json TEXT,
          log_summary TEXT,
          skip_reason TEXT,
          error TEXT,
          UNIQUE(audit_run_id, step_id),
          FOREIGN KEY (audit_run_id) REFERENCES audit_runs(id) ON DELETE CASCADE
        );

        CREATE INDEX run_step_artifacts_run_idx ON run_step_artifacts(audit_run_id, started_at);

        CREATE TABLE audit_issues (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          rule_id TEXT NOT NULL,
          title TEXT NOT NULL,
          severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
          confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'likely', 'hypothesis')),
          state TEXT NOT NULL CHECK (state IN (
            'open', 'reviewing', 'accepted_risk', 'false_positive', 'resolved'
          )),
          location_json TEXT,
          evidence_summary TEXT NOT NULL,
          first_seen_run_id TEXT NOT NULL,
          last_seen_run_id TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          resolved_at TEXT,
          state_reason TEXT,
          tags_json TEXT NOT NULL,
          UNIQUE(repository_id, fingerprint),
          FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
          FOREIGN KEY (first_seen_run_id) REFERENCES audit_runs(id),
          FOREIGN KEY (last_seen_run_id) REFERENCES audit_runs(id)
        );

        CREATE INDEX audit_issues_repository_state_idx ON audit_issues(repository_id, state, last_seen_at DESC);

        CREATE TABLE finding_occurrences (
          id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          audit_run_id TEXT NOT NULL,
          artifact_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('new', 'existing', 'resolved', 'regressed')),
          severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
          confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'likely', 'hypothesis')),
          location_json TEXT,
          evidence_summary TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          FOREIGN KEY (issue_id) REFERENCES audit_issues(id) ON DELETE CASCADE,
          FOREIGN KEY (audit_run_id) REFERENCES audit_runs(id) ON DELETE CASCADE,
          FOREIGN KEY (artifact_id) REFERENCES run_step_artifacts(id)
        );

        CREATE INDEX finding_occurrences_issue_idx ON finding_occurrences(issue_id, observed_at DESC);

        CREATE TABLE evolution_snapshots (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL,
          audit_run_id TEXT,
          head_revision TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          UNIQUE(repository_id, head_revision),
          FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
          FOREIGN KEY (audit_run_id) REFERENCES audit_runs(id)
        );

        CREATE INDEX evolution_snapshots_repository_captured_idx ON evolution_snapshots(repository_id, captured_at DESC);

        CREATE TABLE audit_reports_v2 (
          id TEXT PRIMARY KEY,
          audit_run_id TEXT NOT NULL UNIQUE,
          report_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (audit_run_id) REFERENCES audit_runs(id) ON DELETE CASCADE
        );

        INSERT INTO repositories (
          id, display_name, source, identity_key, server_locator,
          remote_full_name, default_branch, trust_level,
          monitoring_enabled, created_at, updated_at
        )
        SELECT
          'repo_legacy_' || lower(hex(randomblob(16))),
          CASE
            WHEN legacy.access_mode = 'local_git' THEN 'Local repository'
            ELSE legacy.repository_full_name
          END,
          CASE WHEN legacy.access_mode = 'local_git' THEN 'local_git' ELSE 'github' END,
          CASE
            WHEN legacy.access_mode = 'local_git'
              THEN 'local:' || coalesce(legacy.repo_path, legacy.repository_full_name)
            ELSE 'github:' || lower(legacy.repository_full_name)
          END,
          CASE WHEN legacy.access_mode = 'local_git' THEN legacy.repo_path ELSE NULL END,
          CASE WHEN legacy.access_mode = 'local_git' THEN NULL ELSE legacy.repository_full_name END,
          NULL,
          'untrusted_readonly',
          0,
          legacy.created_at,
          legacy.updated_at
        FROM (
          SELECT
            repository_full_name,
            'local_git' AS access_mode,
            repo_path,
            min(created_at) AS created_at,
            max(updated_at) AS updated_at
          FROM jobs
          WHERE access_mode = 'local_git'
          GROUP BY coalesce(repo_path, repository_full_name)

          UNION ALL

          SELECT
            repository_full_name,
            'github_app' AS access_mode,
            NULL AS repo_path,
            min(created_at) AS created_at,
            max(updated_at) AS updated_at
          FROM jobs
          WHERE access_mode <> 'local_git'
          GROUP BY lower(repository_full_name)
        ) AS legacy;
      `);

      const violations = database.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(`Foreign key integrity check failed after migration 0011_audit_control_plane: ${JSON.stringify(violations)}`);
      }
    }
  },
  {
    id: "0012_repository_pulses",
    up(database) {
      database.exec(`
        CREATE TABLE repository_pulses (
          pulse_id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('stopped', 'idle', 'scanning', 'indexing', 'degraded')),
          observed_at TEXT NOT NULL,
          dirty_file_count INTEGER NOT NULL CHECK (dirty_file_count >= 0),
          pending_events INTEGER NOT NULL CHECK (pending_events >= 0),
          branch TEXT,
          head_revision TEXT,
          metrics_json TEXT,
          last_error TEXT,
          FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
        );

        CREATE INDEX repository_pulses_timeline_idx
          ON repository_pulses(repository_id, observed_at DESC, pulse_id);
      `);

      const violations = database.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(`Foreign key integrity check failed after migration 0012_repository_pulses: ${JSON.stringify(violations)}`);
      }
    }
  },
  {
    id: "0013_audit_run_planning_receipts",
    up(database) {
      const duplicateActiveAutomations = database.prepare(`
        SELECT automation_id, count(*) AS run_count
        FROM audit_runs
        WHERE automation_id IS NOT NULL
          AND status IN ('created', 'queued', 'running')
        GROUP BY automation_id
        HAVING count(*) > 1
      `).all() as Array<{ automation_id: string; run_count: number }>;
      if (duplicateActiveAutomations.length > 0) {
        throw new Error(
          "Cannot enforce audit-run planning coalescence while an automation has multiple active runs"
        );
      }

      database.exec(`
        CREATE UNIQUE INDEX audit_runs_one_active_per_automation_idx
          ON audit_runs(automation_id)
          WHERE automation_id IS NOT NULL
            AND status IN ('created', 'queued', 'running');

        CREATE TABLE audit_run_planning_receipts (
          id TEXT PRIMARY KEY,
          planning_key TEXT NOT NULL UNIQUE,
          repository_id TEXT NOT NULL,
          automation_id TEXT NOT NULL,
          workflow_digest TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('manual', 'repository_event')),
          source_event_id TEXT,
          audit_run_id TEXT NOT NULL,
          disposition TEXT NOT NULL CHECK (disposition IN ('created', 'coalesced')),
          created_at TEXT NOT NULL,
          CHECK (
            (source = 'manual' AND source_event_id IS NULL)
            OR (source = 'repository_event' AND source_event_id IS NOT NULL)
          ),
          UNIQUE(source_event_id, automation_id, workflow_digest),
          FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
          FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE,
          FOREIGN KEY (source_event_id) REFERENCES repository_events(id),
          FOREIGN KEY (audit_run_id) REFERENCES audit_runs(id)
        );

        CREATE INDEX audit_run_planning_receipts_automation_idx
          ON audit_run_planning_receipts(automation_id, created_at DESC, id);
        CREATE INDEX audit_run_planning_receipts_run_idx
          ON audit_run_planning_receipts(audit_run_id, created_at, id);
      `);

      const violations = database.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(`Foreign key integrity check failed after migration 0013_audit_run_planning_receipts: ${JSON.stringify(violations)}`);
      }
    }
  },
  {
    id: "0014_automation_scheduler",
    up(database) {
      database.exec(`
        ALTER TABLE audit_runs ADD COLUMN scheduled_for TEXT;

        DROP INDEX audit_run_planning_receipts_automation_idx;
        DROP INDEX audit_run_planning_receipts_run_idx;
        ALTER TABLE audit_run_planning_receipts RENAME TO audit_run_planning_receipts_legacy;

        CREATE TABLE audit_run_planning_receipts (
          id TEXT PRIMARY KEY,
          planning_key TEXT NOT NULL UNIQUE,
          repository_id TEXT NOT NULL,
          automation_id TEXT NOT NULL,
          workflow_digest TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('manual', 'repository_event', 'schedule')),
          source_event_id TEXT,
          scheduled_for TEXT,
          audit_run_id TEXT NOT NULL,
          disposition TEXT NOT NULL CHECK (disposition IN ('created', 'coalesced')),
          created_at TEXT NOT NULL,
          CHECK (
            (source = 'manual' AND source_event_id IS NULL AND scheduled_for IS NULL)
            OR (source = 'repository_event' AND source_event_id IS NOT NULL AND scheduled_for IS NULL)
            OR (source = 'schedule' AND source_event_id IS NULL AND scheduled_for IS NOT NULL)
          ),
          UNIQUE(source_event_id, automation_id, workflow_digest),
          UNIQUE(automation_id, workflow_digest, scheduled_for),
          FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
          FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE,
          FOREIGN KEY (source_event_id) REFERENCES repository_events(id),
          FOREIGN KEY (audit_run_id) REFERENCES audit_runs(id)
        );

        INSERT INTO audit_run_planning_receipts (
          id, planning_key, repository_id, automation_id, workflow_digest,
          source, source_event_id, scheduled_for, audit_run_id, disposition, created_at
        )
        SELECT
          id, planning_key, repository_id, automation_id, workflow_digest,
          source, source_event_id, NULL, audit_run_id, disposition, created_at
        FROM audit_run_planning_receipts_legacy;

        DROP TABLE audit_run_planning_receipts_legacy;

        CREATE INDEX audit_run_planning_receipts_automation_idx
          ON audit_run_planning_receipts(automation_id, created_at DESC, id);
        CREATE INDEX audit_run_planning_receipts_run_idx
          ON audit_run_planning_receipts(audit_run_id, created_at, id);
        CREATE UNIQUE INDEX audit_runs_automation_schedule_window_idx
          ON audit_runs(automation_id, scheduled_for)
          WHERE source = 'schedule' AND automation_id IS NOT NULL AND scheduled_for IS NOT NULL;

        CREATE TABLE automation_schedule_states (
          automation_id TEXT PRIMARY KEY,
          cron TEXT NOT NULL,
          timezone TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('scheduled', 'invalid')),
          next_scheduled_at TEXT,
          last_scheduled_for TEXT,
          last_outcome TEXT CHECK (last_outcome IN ('created', 'coalesced', 'skipped')),
          last_planning_receipt_id TEXT,
          last_audit_run_id TEXT,
          error TEXT,
          updated_at TEXT NOT NULL,
          CHECK (
            (status = 'scheduled' AND next_scheduled_at IS NOT NULL)
            OR (status = 'invalid' AND error IS NOT NULL)
          ),
          FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE,
          FOREIGN KEY (last_planning_receipt_id) REFERENCES audit_run_planning_receipts(id),
          FOREIGN KEY (last_audit_run_id) REFERENCES audit_runs(id)
        );

        CREATE TABLE automation_schedule_windows (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL,
          scheduled_for TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('created', 'coalesced', 'skipped')),
          planning_receipt_id TEXT,
          audit_run_id TEXT,
          reason TEXT CHECK (reason IS NULL OR reason = 'missed_window_policy_skip'),
          recorded_at TEXT NOT NULL,
          UNIQUE(automation_id, scheduled_for),
          CHECK (
            (outcome = 'skipped' AND planning_receipt_id IS NULL AND audit_run_id IS NULL AND reason IS NOT NULL)
            OR (outcome IN ('created', 'coalesced') AND planning_receipt_id IS NOT NULL AND audit_run_id IS NOT NULL AND reason IS NULL)
          ),
          FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE,
          FOREIGN KEY (planning_receipt_id) REFERENCES audit_run_planning_receipts(id),
          FOREIGN KEY (audit_run_id) REFERENCES audit_runs(id)
        );

        CREATE INDEX automation_schedule_windows_history_idx
          ON automation_schedule_windows(automation_id, scheduled_for DESC, id);
      `);

      const violations = database.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(`Foreign key integrity check failed after migration 0014_automation_scheduler: ${JSON.stringify(violations)}`);
      }
    }
  },
  {
    id: "0015_remove_demo_data",
    up(database) {
      database.exec(`
        DELETE FROM notebook_citations WHERE job_id IN (
          SELECT id FROM jobs WHERE action = 'demo' OR delivery_id LIKE 'manual:demo:%'
        ) OR notebook_id NOT IN (
          SELECT DISTINCT notebook_id FROM notebook_sources WHERE job_id NOT IN (
            SELECT id FROM jobs WHERE action = 'demo' OR delivery_id LIKE 'manual:demo:%'
          )
        );
        DELETE FROM notebook_cards WHERE notebook_id NOT IN (
          SELECT DISTINCT notebook_id FROM notebook_sources WHERE job_id NOT IN (
            SELECT id FROM jobs WHERE action = 'demo' OR delivery_id LIKE 'manual:demo:%'
          )
        );
        DELETE FROM notebook_messages WHERE notebook_id NOT IN (
          SELECT DISTINCT notebook_id FROM notebook_sources WHERE job_id NOT IN (
            SELECT id FROM jobs WHERE action = 'demo' OR delivery_id LIKE 'manual:demo:%'
          )
        );
        DELETE FROM notebook_sources WHERE job_id IN (
          SELECT id FROM jobs WHERE action = 'demo' OR delivery_id LIKE 'manual:demo:%'
        );
        DELETE FROM notebooks WHERE id NOT IN (SELECT DISTINCT notebook_id FROM notebook_sources);
        DELETE FROM repository_snapshot_indexes WHERE head_sha LIKE 'demo-%';
        DELETE FROM reports WHERE job_id IN (
          SELECT id FROM jobs WHERE action = 'demo' OR delivery_id LIKE 'manual:demo:%'
        );
        DELETE FROM agent_runs WHERE job_id IN (
          SELECT id FROM jobs WHERE action = 'demo' OR delivery_id LIKE 'manual:demo:%'
        );
        DELETE FROM publish_outbox WHERE job_id IN (
          SELECT id FROM jobs WHERE action = 'demo' OR delivery_id LIKE 'manual:demo:%'
        );
        DELETE FROM jobs WHERE action = 'demo' OR delivery_id LIKE 'manual:demo:%';
        DELETE FROM webhook_deliveries WHERE delivery_id LIKE 'manual:demo:%' OR action = 'demo';
      `);

      const violations = database.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(`Foreign key integrity check failed after migration 0015_remove_demo_data: ${JSON.stringify(violations)}`);
      }
    }
  },
  {
    id: "0016_job_llm_model",
    up(database) {
      database.exec(`
        ALTER TABLE jobs ADD COLUMN llm_provider TEXT;
        ALTER TABLE jobs ADD COLUMN llm_model TEXT;
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
