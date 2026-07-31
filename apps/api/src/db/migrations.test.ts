import { describe, expect, it } from "vitest";
import { openDatabase } from "./connection";
import { migrations, runMigrations, type Migration } from "./migrations";

describe("SQLite foundation", () => {
  it("enables foreign keys and creates the migration table", () => {
    const database = openDatabase(":memory:");
    try {
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(runMigrations(database)).toEqual(["0001_review_storage", "0002_publish_outbox", "0003_publish_outbox_leasing"]);
      expect(runMigrations(database)).toEqual([]);
      const table = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get();
      expect(table).toBeTruthy();
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
      expect(applied).toEqual(["0001_review_storage", "0002_publish_outbox", "0003_publish_outbox_leasing"]);
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
      expect(applied).toEqual(["0002_publish_outbox", "0003_publish_outbox_leasing"]);

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
