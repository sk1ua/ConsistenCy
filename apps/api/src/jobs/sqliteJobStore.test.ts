import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
        status: "queued",
        error: "Recovered after an interrupted worker run"
      });
    } finally {
      database.close();
    }
  });
});
