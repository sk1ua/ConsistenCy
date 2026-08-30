import { describe, expect, it } from "vitest";
import { openDatabase } from "./connection";
import { migrations, runMigrations, type Migration } from "./migrations";
import { workflowSpecSchema } from "@consistency/schema";
import { SQLiteAuditDomainStore } from "../audit/store";

describe("SQLite foundation", () => {
  it("enables foreign keys and creates the migration table", () => {
    const database = openDatabase(":memory:");
    try {
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(runMigrations(database)).toEqual([
        "0001_review_storage",
        "0002_publish_outbox",
        "0003_publish_outbox_leasing",
        "0004_review_publication_policy",
        "0005_repository_notebook",
        "0006_agent_run_provider_metadata",
        "0007_notebook_citations",
        "0008_public_read_access_mode",
        "0009_local_git_jobs",
        "0010_local_notebook_sources",
        "0011_audit_control_plane",
        "0012_repository_pulses",
        "0013_audit_run_planning_receipts",
        "0014_automation_scheduler",
        "0015_remove_demo_data",
        "0016_job_llm_model",
        "0017_workflow_runtime_definitions_runs",
        "0018_workflow_runtime_bindings",
        "0019_jobs_canonical_repository_id",
        "0020_workflow_runtime_triggers",
        "0021_audit_execution_bridge",
        "0022_audit_runtime_only_runs"
      ]);
      expect(runMigrations(database)).toEqual([]);
      const table = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get();
      expect(table).toBeTruthy();
      const accessModeColumn = (database.pragma("table_info(jobs)") as Array<{ name: string; dflt_value: string | null }>)
        .find(column => column.name === "access_mode");
      expect(accessModeColumn).toMatchObject({ name: "access_mode", dflt_value: "'github_app'" });
    } finally {
      database.close();
    }
  });

  it("applies migrations once and rolls back failed migrations", () => {
    const database = openDatabase(":memory:");
    const successful: Migration = {
      id: "0001_test",
      up(db) {
        db.exec("CREATE TABLE test_records (id TEXT PRIMARY KEY)");
      }
    };
    const failing: Migration = {
      id: "0002_failure",
      up(db) {
        db.exec("CREATE TABLE should_rollback (id TEXT PRIMARY KEY)");
        throw new Error("migration failed");
      }
    };

    try {
      expect(runMigrations(database, [successful])).toEqual(["0001_test"]);
      expect(runMigrations(database, [successful])).toEqual([]);
      expect(() => runMigrations(database, [successful, failing])).toThrow("migration failed");
      const rolledBack = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'")
        .get();
      expect(rolledBack).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("creates the review domain tables and publish outbox table", () => {
    const database = openDatabase(":memory:");
    try {
      const applied = runMigrations(database);
      expect(applied).toEqual([
        "0001_review_storage",
        "0002_publish_outbox",
        "0003_publish_outbox_leasing",
        "0004_review_publication_policy",
        "0005_repository_notebook",
        "0006_agent_run_provider_metadata",
        "0007_notebook_citations",
        "0008_public_read_access_mode",
        "0009_local_git_jobs",
        "0010_local_notebook_sources",
        "0011_audit_control_plane",
        "0012_repository_pulses",
        "0013_audit_run_planning_receipts",
        "0014_automation_scheduler",
        "0015_remove_demo_data",
        "0016_job_llm_model",
        "0017_workflow_runtime_definitions_runs",
        "0018_workflow_runtime_bindings",
        "0019_jobs_canonical_repository_id",
        "0020_workflow_runtime_triggers",
        "0021_audit_execution_bridge",
        "0022_audit_runtime_only_runs"
      ]);
      const tables = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('webhook_deliveries', 'jobs', 'agent_runs', 'reports', 'publish_outbox')
        ORDER BY name
      `).all() as Array<{ name: string }>;
      expect(tables.map(table => table.name)).toEqual(["agent_runs", "jobs", "publish_outbox", "reports", "webhook_deliveries"]);
    } finally {
      database.close();
    }
  });

  it("safely migrates historical data from 0001 to 0002 with foreign key integrity intact", () => {
    const database = openDatabase(":memory:");
    try {
      // Step 1: Run 0001 only
      runMigrations(database, [migrations[0]!]);

      // Seed historical data into 0001 tables
      database.exec(`
        INSERT INTO webhook_deliveries (delivery_id, event, action, received_at, status)
        VALUES ('del_1', 'pull_request', 'opened', '2026-07-30T10:00:00Z', 'enqueued');

        INSERT INTO jobs (id, type, status, repository_full_name, pull_request_number, base_sha, head_sha, delivery_id, created_at, updated_at)
        VALUES ('job_1', 'PR_REVIEW', 'running', 'sk1ua/ConsistenCy', 42, 'base1', 'head1', 'del_1', '2026-07-30T10:00:01Z', '2026-07-30T10:00:01Z');

        INSERT INTO agent_runs (id, job_id, agent_name, status, started_at, input_summary, findings_json)
        VALUES ('run_1', 'job_1', 'Planner', 'succeeded', '2026-07-30T10:00:02Z', 'summary', '[]');

        INSERT INTO reports (id, job_id, report_json, created_at)
        VALUES ('rep_1', 'job_1', '{"score":100}', '2026-07-30T10:00:03Z');
      `);

      // Step 2: Apply 0002 & 0003 migrations
      const applied = runMigrations(database, migrations);
      expect(applied).toEqual([
        "0002_publish_outbox",
        "0003_publish_outbox_leasing",
        "0004_review_publication_policy",
        "0005_repository_notebook",
        "0006_agent_run_provider_metadata",
        "0007_notebook_citations",
        "0008_public_read_access_mode",
        "0009_local_git_jobs",
        "0010_local_notebook_sources",
        "0011_audit_control_plane",
        "0012_repository_pulses",
        "0013_audit_run_planning_receipts",
        "0014_automation_scheduler",
        "0015_remove_demo_data",
        "0016_job_llm_model",
        "0017_workflow_runtime_definitions_runs",
        "0018_workflow_runtime_bindings",
        "0019_jobs_canonical_repository_id",
        "0020_workflow_runtime_triggers",
        "0021_audit_execution_bridge",
        "0022_audit_runtime_only_runs"
      ]);

      // Assert data preserved
      const job = database.prepare("SELECT * FROM jobs WHERE id = 'job_1'").get() as any;
      expect(job).toBeTruthy();
      expect(job.repository_full_name).toBe("sk1ua/ConsistenCy");

      const agentRun = database.prepare("SELECT * FROM agent_runs WHERE job_id = 'job_1'").get() as any;
      expect(agentRun).toBeTruthy();

      const report = database.prepare("SELECT * FROM reports WHERE job_id = 'job_1'").get() as any;
      expect(report).toBeTruthy();

      // Assert foreign keys active
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);

      // Assert new job status 'awaiting_publish' is writable
      database.prepare("UPDATE jobs SET status = 'awaiting_publish' WHERE id = 'job_1'").run();
      const updatedJob = database.prepare("SELECT status FROM jobs WHERE id = 'job_1'").get() as any;
      expect(updatedJob.status).toBe("awaiting_publish");

      // Assert invalid status is rejected by CHECK constraint
      expect(() => {
        database.prepare("UPDATE jobs SET status = 'invalid_status' WHERE id = 'job_1'").run();
      }).toThrow();
    } finally {
      database.close();
    }
  });

  it("restores foreign_keys=ON and rolls back real 0002 table changes if failure occurs mid-migration", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database, [migrations[0]!]);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);

      database.exec(`
        INSERT INTO webhook_deliveries (delivery_id, event, received_at, status)
        VALUES ('del_bad', 'pull_request', '2026-07-30T10:00:00Z', 'enqueued');
        INSERT INTO jobs (id, type, status, delivery_id, repository_full_name, pull_request_number, base_sha, head_sha, created_at, updated_at)
        VALUES ('job_bad', 'PR_REVIEW', 'running', 'del_bad', 'sk1ua/ConsistenCy', 1, 'base', 'head', '2026-07-30T10:00:01Z', '2026-07-30T10:00:01Z');
      `);

      const real0002WithFailure: Migration = {
        id: migrations[1]!.id,
        up: (db) => {
          migrations[1]!.up(db);
          throw new Error("Simulated failure at end of real 0002 migration");
        }
      };

      expect(() => runMigrations(database, [migrations[0]!, real0002WithFailure])).toThrow(/Simulated failure at end of real 0002 migration/);

      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);

      const outboxTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'publish_outbox'").get();
      expect(outboxTable).toBeUndefined();

      const job = database.prepare("SELECT * FROM jobs WHERE id = 'job_bad'").get() as any;
      expect(job).toBeTruthy();
      expect(job.status).toBe("running");
    } finally {
      database.close();
    }
  });
});

describe("0009_local_git_jobs", () => {
  const upTo0008 = migrations.filter(migration => migration.id < "0009");
  const migration0009 = migrations.find(migration => migration.id === "0009_local_git_jobs")!;

  function seedGitHubJob(database: ReturnType<typeof openDatabase>): void {
    database.exec(`
      INSERT INTO webhook_deliveries (delivery_id, event, action, received_at, status)
      VALUES ('delivery_1', 'pull_request', 'opened', '2026-08-05T00:00:00.000Z', 'enqueued');

      INSERT INTO jobs (
        id, type, status, repository_full_name, pull_request_number, installation_id,
        base_sha, head_sha, delivery_id, sender_login, action, created_at, updated_at
      ) VALUES (
        'job_kept', 'PR_REVIEW', 'succeeded', 'sk1ua/ConsistenCy', 34, 99,
        'base123', 'head456', 'delivery_1', 'sk1ua', 'opened',
        '2026-08-05T00:00:00.000Z', '2026-08-05T00:01:00.000Z'
      );

      INSERT INTO agent_runs (id, job_id, agent_name, status, started_at, input_summary, findings_json)
      VALUES ('run_1', 'job_kept', 'Security', 'succeeded', '2026-08-05T00:00:30.000Z', 'Analyzed 2 files', '[]');

      INSERT INTO reports (id, job_id, report_json, created_at)
      VALUES ('report_1', 'job_kept', '{"jobId":"job_kept"}', '2026-08-05T00:01:00.000Z');
    `);
  }

  it("preserves existing jobs and their foreign-key children through the table rebuild", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database, upTo0008);
      seedGitHubJob(database);

      expect(runMigrations(database, migrations)).toEqual([
        "0009_local_git_jobs",
        "0010_local_notebook_sources",
        "0011_audit_control_plane",
        "0012_repository_pulses",
        "0013_audit_run_planning_receipts",
        "0014_automation_scheduler",
        "0015_remove_demo_data",
        "0016_job_llm_model",
        "0017_workflow_runtime_definitions_runs",
        "0018_workflow_runtime_bindings",
        "0019_jobs_canonical_repository_id",
        "0020_workflow_runtime_triggers",
        "0021_audit_execution_bridge",
        "0022_audit_runtime_only_runs"
      ]);

      const job = database.prepare("SELECT * FROM jobs WHERE id = 'job_kept'").get() as any;
      expect(job).toMatchObject({
        repository_full_name: "sk1ua/ConsistenCy",
        pull_request_number: 34,
        installation_id: 99,
        base_sha: "base123",
        head_sha: "head456",
        delivery_id: "delivery_1",
        access_mode: "github_app",
        publication_policy: "github_comment",
        repo_path: null
      });

      expect(database.prepare("SELECT COUNT(*) c FROM agent_runs WHERE job_id = 'job_kept'").get()).toMatchObject({ c: 1 });
      expect(database.prepare("SELECT COUNT(*) c FROM reports WHERE job_id = 'job_kept'").get()).toMatchObject({ c: 1 });
      expect(database.pragma("foreign_key_check")).toEqual([]);

      const index = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'jobs_status_created_at_idx'")
        .get();
      expect(index).toBeTruthy();
    } finally {
      database.close();
    }
  });

  it("accepts a local job without a pull request and rejects one without a repo path", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);

      const insertLocal = (repoPath: string | null, policy = "disabled") => database.prepare(`
        INSERT INTO jobs (
          id, type, status, repository_full_name, pull_request_number, repo_path,
          base_sha, head_sha, publication_policy, access_mode, created_at, updated_at
        ) VALUES (?, 'PR_REVIEW', 'queued', 'ConsistenCy', NULL, ?, 'base123', 'WORKING_TREE', ?, 'local_git', ?, ?)
      `).run(`job_${repoPath ?? "null"}_${policy}`, repoPath, policy, "2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z");

      expect(() => insertLocal("D:/sk1ua/python/ConsistenCy")).not.toThrow();
      expect(() => insertLocal(null)).toThrow(/CHECK constraint failed/);
      // A local review must never be routed to a GitHub comment.
      expect(() => insertLocal("D:/repo", "github_comment")).toThrow(/CHECK constraint failed/);
    } finally {
      database.close();
    }
  });

  it("still requires a pull request number for GitHub jobs", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      expect(() => database.prepare(`
        INSERT INTO jobs (
          id, type, status, repository_full_name, pull_request_number,
          base_sha, head_sha, access_mode, created_at, updated_at
        ) VALUES ('job_bad', 'PR_REVIEW', 'queued', 'sk1ua/ConsistenCy', NULL,
          'base123', 'head456', 'github_app', '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z')
      `).run()).toThrow(/CHECK constraint failed/);
    } finally {
      database.close();
    }
  });

  it("is a no-op to re-run", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      expect(runMigrations(database, [migration0009])).toEqual([]);
    } finally {
      database.close();
    }
  });
});

describe("0011_audit_control_plane", () => {
  it("backfills a renderer-safe display name while retaining the local locator only server-side", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database, migrations.filter(migration => migration.id < "0011"));
      database.prepare(`
        INSERT INTO jobs (
          id, type, status, repository_full_name, pull_request_number, repo_path,
          base_sha, head_sha, publication_policy, access_mode, created_at, updated_at
        ) VALUES (
          'job_private_path', 'PR_REVIEW', 'queued', 'D:/private/customer/repository', NULL,
          'D:/private/customer/repository', 'base', 'WORKING_TREE', 'disabled', 'local_git',
          '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'
        )
      `).run();

      expect(runMigrations(database, migrations.filter(migration => migration.id <= "0011_audit_control_plane")))
        .toEqual(["0011_audit_control_plane"]);
      const repository = database.prepare(`
        SELECT display_name, source, server_locator FROM repositories
        WHERE identity_key = 'local:D:/private/customer/repository'
      `).get() as { display_name: string; source: string; server_locator: string };
      expect(repository).toEqual({
        display_name: "Local repository",
        source: "local_git",
        server_locator: "D:/private/customer/repository"
      });
    } finally {
      database.close();
    }
  });
});

describe("0013_audit_run_planning_receipts", () => {
  it("refuses to hide pre-existing duplicate active runs when adding the coalescence constraint", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database, migrations.filter(migration => migration.id <= "0012_repository_pulses"));
      const store = new SQLiteAuditDomainStore(database);
      const repository = store.createRepository({
        displayName: "trusted-local",
        source: "local_git",
        monitoringEnabled: true
      }, { serverLocator: "D:/server-only/trusted-local", trustLevel: "trusted_local" });
      const workflow = store.createWorkflowRevision({
        workflowId: "migration-test",
        spec: workflowSpecSchema.parse({
          version: 2,
          name: "migration-test",
          nodes: [{ id: "security", uses: "engine.security" }],
          verifiers: [],
          synthesizer: { needs: ["security"] }
        })
      });
      const policy = store.createPolicyRevision({
        policyId: "migration-test",
        name: "Migration test",
        requiredChecks: [],
        minimumCoverage: 0,
        warnAtRiskScore: 40,
        failAtRiskScore: 70,
        enforcement: "advisory"
      });
      // This fixture intentionally remains on 0012. Insert the legacy shape
      // directly because the current store targets the fully migrated schema.
      database.prepare(`
        INSERT INTO automations (
          id, repository_id, name, trigger_json, workflow_revision_id,
          policy_revision_id, execution_profile, enabled, created_at, updated_at
        ) VALUES ('automation_duplicate', ?, 'duplicate-active', '{"type":"manual"}', ?,
          ?, 'trusted_sandbox', 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z')
      `).run(repository.id, workflow.id, policy.id);
      const automation = { id: "automation_duplicate" };
      const insertLegacyDraft = database.prepare(`
        INSERT INTO audit_runs (
          id, repository_id, source, automation_id, workflow_revision_id,
          policy_revision_id, execution_profile, status, publication_status, created_at
        ) VALUES (?, ?, 'manual', ?, ?, ?, 'trusted_sandbox', 'created', 'skipped', ?)
      `);
      insertLegacyDraft.run("audit_run_duplicate_1", repository.id, automation.id, workflow.id, policy.id, "2026-08-14T00:00:00.000Z");
      insertLegacyDraft.run("audit_run_duplicate_2", repository.id, automation.id, workflow.id, policy.id, "2026-08-14T00:01:00.000Z");

      expect(() => runMigrations(database, migrations)).toThrow(/multiple active runs/i);
      expect(database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'audit_run_planning_receipts'
      `).get()).toBeUndefined();
      expect(database.prepare(`
        SELECT id FROM schema_migrations WHERE id = '0013_audit_run_planning_receipts'
      `).get()).toBeUndefined();
    } finally {
      database.close();
    }
  });
});

describe("0014_automation_scheduler", () => {
  it("preserves legacy planning receipts and adds durable schedule provenance", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database, migrations.filter(migration => migration.id <= "0013_audit_run_planning_receipts"));
      const store = new SQLiteAuditDomainStore(database);
      const repository = store.createRepository({
        displayName: "scheduler-migration",
        source: "local_git",
        monitoringEnabled: true
      }, { serverLocator: "D:/server-only/scheduler-migration", trustLevel: "trusted_local" });
      const workflow = store.createWorkflowRevision({
        workflowId: "scheduler-migration",
        spec: workflowSpecSchema.parse({
          version: 2,
          name: "scheduler-migration",
          nodes: [{ id: "security", uses: "engine.security" }],
          verifiers: [],
          synthesizer: { needs: ["security"] }
        })
      });
      const policy = store.createPolicyRevision({
        policyId: "scheduler-migration",
        name: "Scheduler migration",
        requiredChecks: [],
        minimumCoverage: 0,
        warnAtRiskScore: 40,
        failAtRiskScore: 70,
        enforcement: "advisory"
      });
      // This fixture intentionally remains on 0013. Insert the legacy shape
      // directly because the current store targets the fully migrated schema.
      database.prepare(`
        INSERT INTO automations (
          id, repository_id, name, trigger_json, workflow_revision_id,
          policy_revision_id, execution_profile, enabled, created_at, updated_at
        ) VALUES ('automation_legacy_manual', ?, 'legacy-manual', '{"type":"manual"}', ?,
          ?, 'static_readonly', 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z')
      `).run(repository.id, workflow.id, policy.id);
      const automation = { id: "automation_legacy_manual" };
      database.prepare(`
        INSERT INTO audit_runs (
          id, repository_id, source, automation_id, workflow_revision_id,
          policy_revision_id, execution_profile, status, publication_status, created_at
        ) VALUES ('audit_run_legacy', ?, 'manual', ?, ?, ?, 'static_readonly', 'created', 'skipped', ?)
      `).run(repository.id, automation.id, workflow.id, policy.id, "2026-08-14T00:00:00.000Z");
      database.prepare(`
        INSERT INTO audit_run_planning_receipts (
          id, planning_key, repository_id, automation_id, workflow_digest,
          source, source_event_id, audit_run_id, disposition, created_at
        ) VALUES ('receipt_legacy', ?, ?, ?, ?, 'manual', NULL, 'audit_run_legacy', 'created', ?)
      `).run("a".repeat(64), repository.id, automation.id, workflow.digest, "2026-08-14T00:00:00.000Z");

      expect(runMigrations(database, migrations)).toEqual(["0014_automation_scheduler", "0015_remove_demo_data", "0016_job_llm_model",
        "0017_workflow_runtime_definitions_runs", "0018_workflow_runtime_bindings",
        "0019_jobs_canonical_repository_id", "0020_workflow_runtime_triggers",
        "0021_audit_execution_bridge", "0022_audit_runtime_only_runs"]);
      expect(database.prepare("SELECT scheduled_for FROM audit_runs WHERE id = 'audit_run_legacy'").get())
        .toEqual({ scheduled_for: null });
      expect(database.prepare("SELECT scheduled_for FROM audit_run_planning_receipts WHERE id = 'receipt_legacy'").get())
        .toEqual({ scheduled_for: null });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_schedule_states'").get())
        .toBeTruthy();
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_schedule_windows'").get())
        .toBeTruthy();
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });
});

describe("0015_remove_demo_data (Database Safety Test)", () => {
  it("deletes explicitly seeded demo records while preserving real user records", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database, migrations.filter(m => m.id <= "0014_automation_scheduler"));

      // 1. Insert an explicit Demo record
      database.exec(`
        INSERT INTO webhook_deliveries (delivery_id, event, action, received_at, status)
        VALUES ('manual:demo:1', 'pull_request', 'demo', '2026-08-18T00:00:00.000Z', 'enqueued');

        INSERT INTO jobs (
          id, type, status, repository_full_name, pull_request_number,
          base_sha, head_sha, delivery_id, sender_login, action, created_at, updated_at
        ) VALUES (
          'job_demo_1', 'PR_REVIEW', 'succeeded', 'sk1ua/ConsistenCy', 34,
          'demo-base-1', 'demo-head-1', 'manual:demo:1', 'demo', 'demo', '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z'
        );

        INSERT INTO reports (id, job_id, report_json, created_at)
        VALUES ('report_demo_1', 'job_demo_1', '{}', '2026-08-18T00:00:00.000Z');
      `);

      // 2. Insert a REAL user record
      database.exec(`
        INSERT INTO webhook_deliveries (delivery_id, event, action, received_at, status)
        VALUES ('delivery_real_123', 'pull_request', 'opened', '2026-08-18T00:00:00.000Z', 'enqueued');

        INSERT INTO jobs (
          id, type, status, repository_full_name, pull_request_number,
          base_sha, head_sha, delivery_id, sender_login, action, created_at, updated_at
        ) VALUES (
          'job_real_123', 'PR_REVIEW', 'succeeded', 'sk1ua/ConsistenCy', 42,
          'c4de53c659334ba29bd392f11aa69d61500c29e6', '161877ca87d1e0dae806f21e3c6591b6a738dde8',
          'delivery_real_123', 'sk1ua', 'opened', '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z'
        );

        INSERT INTO reports (id, job_id, report_json, created_at)
        VALUES ('report_real_123', 'job_real_123', '{"score": 88}', '2026-08-18T00:00:00.000Z');
      `);

      expect(database.prepare("SELECT count(*) as count FROM jobs").get()).toEqual({ count: 2 });
      expect(database.prepare("SELECT count(*) as count FROM reports").get()).toEqual({ count: 2 });

      // 3. Run migration 0015
      runMigrations(database, migrations.filter(m => m.id === "0015_remove_demo_data"));

      // 4. Verify ONLY demo records were removed
      const remainingJobs = database.prepare("SELECT id FROM jobs").all() as Array<{ id: string }>;
      expect(remainingJobs).toEqual([{ id: "job_real_123" }]);

      const remainingReports = database.prepare("SELECT id FROM reports").all() as Array<{ id: string }>;
      expect(remainingReports).toEqual([{ id: "report_real_123" }]);

      const remainingDeliveries = database.prepare("SELECT delivery_id FROM webhook_deliveries").all() as Array<{ delivery_id: string }>;
      expect(remainingDeliveries).toEqual([{ delivery_id: "delivery_real_123" }]);
    } finally {
      database.close();
    }
  });
});

describe("0021_audit_execution_bridge", () => {
  it("preserves legacy automations and runs while adding runtime mapping and run-event persistence", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database, migrations.filter(migration => migration.id <= "0020_workflow_runtime_triggers"));

      // Seed pre-0021 rows using the exact historical column shape.
      database.prepare(`
        INSERT INTO repositories (
          id, display_name, source, identity_key, server_locator,
          remote_full_name, trust_level, monitoring_enabled, created_at, updated_at
        ) VALUES ('repo_bridge', 'bridge', 'local_git', 'local:D:/private/work/bridge', 'D:/private/work/bridge',
          NULL, 'trusted_local', 1, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')
      `).run();
      database.prepare(`
        INSERT INTO workflow_revisions (id, workflow_id, revision, digest, spec_json, created_at)
        VALUES ('wfrev_bridge', 'wf_bridge', 1, ?, '{}', '2026-08-20T00:00:00.000Z')
      `).run("a".repeat(64));
      database.prepare(`
        INSERT INTO policy_revisions (id, policy_id, revision, name, digest, policy_json, created_at)
        VALUES ('policyrev_bridge', 'policy_bridge', 1, 'Bridge', ?, '{}', '2026-08-20T00:00:00.000Z')
      `).run("b".repeat(64));
      database.prepare(`
        INSERT INTO automations (
          id, repository_id, name, trigger_json, workflow_revision_id,
          policy_revision_id, execution_profile, enabled, created_at, updated_at
        ) VALUES ('automation_bridge', 'repo_bridge', 'Legacy bridge', '{"type":"manual"}', 'wfrev_bridge',
          'policyrev_bridge', 'static_readonly', 1, '2026-08-20T00:00:01.000Z', '2026-08-20T00:00:01.000Z')
      `).run();
      database.prepare(`
        INSERT INTO audit_runs (
          id, repository_id, source, automation_id, workflow_revision_id,
          policy_revision_id, execution_profile, status, publication_status, created_at
        ) VALUES ('auditrun_bridge', 'repo_bridge', 'manual', 'automation_bridge', 'wfrev_bridge',
          'policyrev_bridge', 'static_readonly', 'created', 'skipped', '2026-08-20T00:00:02.000Z')
      `).run();

      expect(runMigrations(database, migrations)).toEqual(["0021_audit_execution_bridge", "0022_audit_runtime_only_runs"]);

      // Historical automation data is preserved; the new mapping stays NULL.
      const automation = database.prepare("SELECT * FROM automations WHERE id = 'automation_bridge'").get() as any;
      expect(automation).toMatchObject({
        repository_id: "repo_bridge",
        name: "Legacy bridge",
        workflow_revision_id: "wfrev_bridge",
        policy_revision_id: "policyrev_bridge",
        enabled: 1
      });
      expect(automation.runtime_definition_id).toBeNull();

      // Historical run data is preserved; bridge columns stay NULL.
      const run = database.prepare("SELECT * FROM audit_runs WHERE id = 'auditrun_bridge'").get() as any;
      expect(run).toMatchObject({
        repository_id: "repo_bridge",
        automation_id: "automation_bridge",
        status: "created"
      });
      expect(run.workflow_runtime_run_id).toBeNull();
      expect(run.execution_error).toBeNull();

      // Runtime-only automations are now representable: a NULL legacy revision
      // with a runtime definition satisfies the at-least-one CHECK.
      database.prepare(`
        INSERT INTO automations (
          id, repository_id, name, trigger_json, workflow_revision_id,
          policy_revision_id, execution_profile, enabled, runtime_definition_id, created_at, updated_at
        ) VALUES ('automation_runtime_only', 'repo_bridge', 'Runtime only', '{"type":"manual"}', NULL,
          'policyrev_bridge', 'static_readonly', 1, 'verified-mini-review', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')
      `).run();
      database.prepare(`
        INSERT INTO audit_runs (
          id, repository_id, source, automation_id, workflow_revision_id,
          policy_revision_id, execution_profile, status, publication_status, created_at
        ) VALUES ('auditrun_runtime_only', 'repo_bridge', 'manual', 'automation_runtime_only', NULL,
          'policyrev_bridge', 'static_readonly', 'created', 'skipped', '2026-08-21T00:00:01.000Z')
      `).run();
      expect((database.prepare("SELECT workflow_revision_id FROM audit_runs WHERE id = 'auditrun_runtime_only'").get() as any).workflow_revision_id)
        .toBeNull();
      expect(() => database.prepare(`
        INSERT INTO automations (
          id, repository_id, name, trigger_json, workflow_revision_id,
          policy_revision_id, execution_profile, enabled, created_at, updated_at
        ) VALUES ('automation_empty', 'repo_bridge', 'Empty mapping', '{"type":"manual"}', NULL,
          'policyrev_bridge', 'static_readonly', 1, '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')
      `).run()).toThrow(/CHECK constraint failed/);

      // The run-event table is append-only per run and rejects unknown types.
      database.prepare(`
        INSERT INTO audit_run_events (id, audit_run_id, event_type, seq, payload_json, created_at)
        VALUES ('runevt_1', 'auditrun_bridge', 'run_queued', 1, '{"status":"queued"}', '2026-08-21T00:01:00.000Z')
      `).run();
      expect(() => database.prepare(`
        INSERT INTO audit_run_events (id, audit_run_id, event_type, seq, payload_json, created_at)
        VALUES ('runevt_bad_type', 'auditrun_bridge', 'detonated', 2, '{}', '2026-08-21T00:01:01.000Z')
      `).run()).toThrow(/CHECK constraint failed/);
      expect(() => database.prepare(`
        INSERT INTO audit_run_events (id, audit_run_id, event_type, seq, payload_json, created_at)
        VALUES ('runevt_duplicate_seq', 'auditrun_bridge', 'run_running', 1, '{}', '2026-08-21T00:01:02.000Z')
      `).run()).toThrow(/UNIQUE constraint failed/);
      expect(() => database.prepare(`
        INSERT INTO audit_run_events (id, audit_run_id, event_type, seq, payload_json, created_at)
        VALUES ('runevt_orphan', 'auditrun_missing', 'run_queued', 1, '{}', '2026-08-21T00:01:03.000Z')
      `).run()).toThrow(/FOREIGN KEY constraint failed/);

      expect(database.pragma("foreign_key_check")).toEqual([]);
      const index = database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'audit_run_events_run_idx'
      `).get();
      expect(index).toBeTruthy();
      const automationColumns = database.pragma("table_info(automations)") as Array<{ name: string }>;
      expect(automationColumns.map(column => column.name)).toContain("runtime_definition_id");
      expect(runMigrations(database, [migrations[migrations.length - 1]!])).toEqual([]);
    } finally {
      database.close();
    }
  });
});
