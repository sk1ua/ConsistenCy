import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedDemoData } from "../api/demoSeed";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { SQLiteJobStore } from "./sqliteJobStore";

const tempDirectories: string[] = [];

function createStore(path = ":memory:") {
  const database = openDatabase(path);
  runMigrations(database);
  return { database, store: new SQLiteJobStore(database) };
}

function acceptJob(store: SQLiteJobStore, deliveryId = "delivery-1") {
  const acceptance = store.acceptWebhookJob({
    delivery: { deliveryId, event: "pull_request", action: "opened" },
    job: {
      kind: "pull_request",
      repository: "sk1ua/ConsistenCy",
      pullRequestNumber: 34,
      installationId: 123,
      baseSha: "base123",
      headSha: "head456",
      senderLogin: "octocat",
      action: "opened"
    }
  });
  if (!acceptance.job) throw new Error("Expected a new job");
  return acceptance.job;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLiteJobStore", () => {
  it("atomically deduplicates webhook deliveries", () => {
    const { database, store } = createStore();
    try {
      const job = acceptJob(store);
      const duplicate = store.acceptWebhookJob({
        delivery: { deliveryId: "delivery-1", event: "pull_request", action: "opened" },
        job: {
          kind: "pull_request",
          repository: "sk1ua/ConsistenCy",
          pullRequestNumber: 34,
          installationId: 123,
          baseSha: "base123",
          headSha: "head456"
        }
      });
      expect(duplicate.duplicate).toBe(true);
      expect(store.list()).toHaveLength(1);
      expect(store.get(job.id)?.senderLogin).toBe("octocat");
    } finally {
      database.close();
    }
  });

  it("persists job state, reports, and agent runs across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-db-"));
    tempDirectories.push(directory);
    const path = join(directory, "consistency.db");
    const first = createStore(path);
    const job = acceptJob(first.store, "delivery-persisted");
    first.store.markRunning(job.id);
    first.store.saveAgentRun({
      id: "agent-run-1",
      jobId: job.id,
      agentName: "Planner",
      status: "succeeded",
      startedAt: "2026-06-11T00:00:00.000Z",
      finishedAt: "2026-06-11T00:00:01.000Z",
      inputSummary: "Plan the pull request review",
      findings: []
    });
    first.store.markSucceeded(job.id, {
      jobId: job.id,
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 34,
      baseSha: "base123",
      headSha: "head456",
      summary: "No confirmed findings",
      score: 100,
      riskLevel: "low",
      agentRuns: [],
      findings: [],
      createdAt: "2026-06-11T00:00:02.000Z"
    });
    first.database.close();

    const second = createStore(path);
    try {
      expect(second.store.get(job.id)).toMatchObject({
        status: "succeeded",
        result: { jobId: job.id, score: 100 }
      });
      expect(second.store.listAgentRuns(job.id)).toHaveLength(1);
      expect(second.store.getWebhookDelivery("delivery-persisted")?.status).toBe("enqueued");
    } finally {
      second.database.close();
    }
  });

  it("requeues stale running jobs", () => {
    const { database, store } = createStore();
    try {
      const job = acceptJob(store, "delivery-stale");
      store.markRunning(job.id);
      database.prepare("UPDATE jobs SET started_at = ? WHERE id = ?")
        .run("2026-06-10T00:00:00.000Z", job.id);

      expect(store.recoverStaleRunningJobs(new Date("2026-06-11T00:00:00.000Z"))).toBe(1);
      expect(store.get(job.id)).toMatchObject({
        status: "failed",
        error: "Job execution timed out while running"
      });
    } finally {
      database.close();
    }
  });

  it("claims each queued job only once", () => {
    const { database, store } = createStore();
    try {
      const first = acceptJob(store, "delivery-claim-1");
      const second = acceptJob(store, "delivery-claim-2");
      expect(store.claimNextQueued()?.id).toBe(first.id);
      expect(store.claimNextQueued()?.id).toBe(second.id);
      expect(store.claimNextQueued()).toBeUndefined();
      expect(store.list().every(job => job.status === "running")).toBe(true);
    } finally {
      database.close();
    }
  });

  it("seeds demo jobs without webhook delivery foreign keys", () => {
    const { database, store } = createStore();
    try {
      expect(seedDemoData(store)).toEqual({ created: 8 });
      expect(seedDemoData(store)).toEqual({ created: 0 });
      expect(store.list()).toHaveLength(8);
      expect(store.list().filter(job => job.status === "succeeded")).toHaveLength(5);
    } finally {
      database.close();
    }
  });

  it("atomically and idempotently persists report and enqueues publish outbox", () => {
    const { database, store } = createStore();
    try {
      const job = acceptJob(store, "delivery-outbox");
      store.markRunning(job.id);

      const report = {
        jobId: job.id,
        repositoryFullName: "sk1ua/ConsistenCy",
        pullRequestNumber: 34,
        baseSha: "base123",
        headSha: "head456",
        summary: "One finding",
        score: 85,
        riskLevel: "medium" as const,
        agentRuns: [],
        findings: [],
        createdAt: "2026-07-30T10:00:00.000Z"
      };

      // Call 1: running -> awaiting_publish
      const updated1 = store.persistReportAndEnqueuePublish(job.id, report);
      expect(updated1?.status).toBe("awaiting_publish");
      expect(updated1?.result?.score).toBe(85);

      const outboxRows1 = database.prepare("SELECT * FROM publish_outbox WHERE job_id = ?").all(job.id);
      expect(outboxRows1).toHaveLength(1);
      expect(outboxRows1[0]).toMatchObject({ status: "pending", target: "github_comment" });

      // Call 2 (Idempotent Replay): awaiting_publish -> awaiting_publish
      const updated2 = store.persistReportAndEnqueuePublish(job.id, report);
      expect(updated2?.status).toBe("awaiting_publish");

      const outboxRows2 = database.prepare("SELECT * FROM publish_outbox WHERE job_id = ?").all(job.id);
      expect(outboxRows2).toHaveLength(1); // No duplicate outbox row created

      // Call 3 on terminal/publishing state -> complete no-op (no status regression or ZodError on invalid payload)
      database.prepare("UPDATE jobs SET status = 'publishing' WHERE id = ?").run(job.id);
      const updated3 = store.persistReportAndEnqueuePublish(job.id, {} as any);
      expect(updated3?.status).toBe("publishing"); // Preserves 'publishing'

      // Outbox item must pass publishOutboxItemSchema
      const outboxItems = store.getPublishOutbox(job.id);
      expect(outboxItems).toHaveLength(1);
      expect(typeof outboxItems[0]!.id).toBe("string");

      // Invalid status test (queued/failed/cancelled) -> throws
      const queuedJob = acceptJob(store, "delivery-queued");
      expect(() => store.persistReportAndEnqueuePublish(queuedJob.id, report)).toThrow(/Invalid job status/);
    } finally {
      database.close();
    }
  });

  it("rolls back transaction cleanly when outbox insertion fails mid-transaction", () => {
    const { database, store } = createStore();
    try {
      const job = acceptJob(store, "delivery-rollback");
      store.markRunning(job.id);

      database.exec(`
        CREATE TRIGGER fail_publish_outbox
        BEFORE INSERT ON publish_outbox
        BEGIN
          SELECT RAISE(ABORT, 'forced outbox failure');
        END;
      `);

      const report = {
        jobId: job.id,
        repositoryFullName: "sk1ua/ConsistenCy",
        pullRequestNumber: 34,
        baseSha: "base123",
        headSha: "head456",
        summary: "Rollback test",
        score: 90,
        riskLevel: "low" as const,
        agentRuns: [],
        findings: [],
        createdAt: "2026-07-30T10:00:00.000Z"
      };

      expect(() => store.persistReportAndEnqueuePublish(job.id, report)).toThrow(/forced outbox failure/);

      const reportCount = (database.prepare("SELECT count(*) as count FROM reports WHERE job_id = ?").get(job.id) as { count: number }).count;
      const outboxCount = (database.prepare("SELECT count(*) as count FROM publish_outbox WHERE job_id = ?").get(job.id) as { count: number }).count;
      const currentJob = store.get(job.id);

      expect(reportCount).toBe(0);
      expect(outboxCount).toBe(0);
      expect(currentJob?.status).toBe("running");
    } finally {
      database.close();
    }
  });
});
