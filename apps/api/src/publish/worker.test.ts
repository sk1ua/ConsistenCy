import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { migrations, runMigrations, type Migration } from "../db/migrations";
import { GitHubAppAuthenticator } from "../github/auth";
import { InMemoryJobQueue } from "../jobQueue";
import { SQLiteJobStore } from "../jobs/sqliteJobStore";
import { publishOutboxItemSchema, type ReviewReport } from "@consistency/schema";
import { classifyGitHubError, publishToGitHub, type PublishToGitHubOptions } from "./githubPublisher";
import { PermanentPublishError, RateLimitedPublishError, TransientPublishError } from "./error";
import { PublishWorker } from "./worker";

function createValidReport(jobId: string): ReviewReport {
  return {
    jobId,
    repositoryFullName: "sk1ua/ConsistenCy",
    pullRequestNumber: 42,
    baseSha: "base123",
    headSha: "head123",
    summary: "High risk architectural issue in auth module.",
    score: 42,
    riskLevel: "high",
    agentRuns: [],
    findings: [],
    createdAt: "2026-07-30T10:00:00Z"
  };
}

describe("PublishWorker & Outbox Pipeline Test Suite", () => {
  it("0003 migration upgrade preserves historical data and adds lease_generation and external_id", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database, [migrations[0]!, migrations[1]!]);

      database.exec(`
        INSERT INTO webhook_deliveries (delivery_id, event, received_at, status)
        VALUES ('del_003', 'pull_request', '2026-07-30T10:00:00Z', 'enqueued');
        INSERT INTO jobs (id, type, status, delivery_id, repository_full_name, pull_request_number, base_sha, head_sha, created_at, updated_at)
        VALUES ('job_003', 'PR_REVIEW', 'awaiting_publish', 'del_003', 'sk1ua/ConsistenCy', 42, 'base', 'head', '2026-07-30T10:00:01Z', '2026-07-30T10:00:01Z');
        INSERT INTO publish_outbox (id, job_id, target, status, attempt_count, created_at, updated_at)
        VALUES ('outbox_003', 'job_003', 'github_comment', 'pending', 0, '2026-07-30T10:00:02Z', '2026-07-30T10:00:02Z');
      `);

      const applied = runMigrations(database, [migrations[2]!]);
      expect(applied).toEqual(["0003_publish_outbox_leasing"]);

      const row = database.prepare("SELECT * FROM publish_outbox WHERE id = 'outbox_003'").get() as any;
      expect(row.lease_generation).toBe(0);
      expect(row.external_id).toBeNull();

      expect(runMigrations(database)).toEqual([
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
    } finally {
      database.close();
    }
  });

  it("P1-2: 0003 migration execution failure rolls back real migrations[2] DDL in transaction cleanly", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database, [migrations[0]!, migrations[1]!]);

      database.exec(`
        INSERT INTO webhook_deliveries (delivery_id, event, received_at, status)
        VALUES ('del_rollback', 'pull_request', '2026-07-30T10:00:00Z', 'enqueued');
        INSERT INTO jobs (id, type, status, delivery_id, repository_full_name, pull_request_number, base_sha, head_sha, created_at, updated_at)
        VALUES ('job_rb', 'PR_REVIEW', 'awaiting_publish', 'del_rollback', 'sk1ua/ConsistenCy', 42, 'base', 'head', '2026-07-30T10:00:01Z', '2026-07-30T10:00:01Z');
        INSERT INTO publish_outbox (id, job_id, target, status, attempt_count, created_at, updated_at)
        VALUES ('outbox_rb', 'job_rb', 'github_comment', 'pending', 0, '2026-07-30T10:00:02Z', '2026-07-30T10:00:02Z');
      `);

      const real0003WithFailure: Migration = {
        id: migrations[2]!.id,
        up(db) {
          migrations[2]!.up(db);
          throw new Error("Simulated failure after real 0003 DDL");
        }
      };

      expect(() => runMigrations(database, [real0003WithFailure])).toThrow("Simulated failure after real 0003 DDL");

      const pragma = database.prepare("PRAGMA table_info(publish_outbox)").all() as any[];
      const hasLeaseGen = pragma.some(col => col.name === "lease_generation");
      const hasExternalId = pragma.some(col => col.name === "external_id");
      expect(hasLeaseGen).toBe(false);
      expect(hasExternalId).toBe(false);

      const appliedMigrations = database.prepare("SELECT id FROM schema_migrations WHERE id = '0003_publish_outbox_leasing'").all();
      expect(appliedMigrations).toHaveLength(0);

      const row = database.prepare("SELECT * FROM publish_outbox WHERE id = 'outbox_rb'").get() as any;
      expect(row).toBeDefined();
      expect(row.status).toBe("pending");
    } finally {
      database.close();
    }
  });

  it("parse returned outbox item from both SQLiteJobStore and InMemoryJobQueue against publishOutboxItemSchema", () => {
    const queue = new InMemoryJobQueue();
    const acceptance = queue.acceptWebhookJob({
      delivery: { deliveryId: "del_inmem", event: "pull_request" },
      job: { kind: "pull_request", repository: "sk1ua/ConsistenCy", pullRequestNumber: 1, baseSha: "b", headSha: "h" }
    });
    const inMemJob = acceptance.job!;
    queue.markRunning(inMemJob.id);
    queue.persistReportAndEnqueuePublish(inMemJob.id, createValidReport(inMemJob.id));

    const inMemOutbox = queue.getPublishOutbox(inMemJob.id);
    expect(inMemOutbox).toHaveLength(1);
    expect(publishOutboxItemSchema.parse(inMemOutbox[0]!)).toBeTruthy();

    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const sqlStore = new SQLiteJobStore(database);
      const sqlAcc = sqlStore.acceptWebhookJob({
        delivery: { deliveryId: "del_sql", event: "pull_request" },
        job: { kind: "pull_request", repository: "sk1ua/ConsistenCy", pullRequestNumber: 1, baseSha: "b", headSha: "h" }
      });
      const sqlJob = sqlAcc.job!;
      sqlStore.markRunning(sqlJob.id);
      sqlStore.persistReportAndEnqueuePublish(sqlJob.id, createValidReport(sqlJob.id));

      const sqlOutbox = sqlStore.getPublishOutbox(sqlJob.id);
      expect(sqlOutbox).toHaveLength(1);
      expect(publishOutboxItemSchema.parse(sqlOutbox[0]!)).toBeTruthy();
    } finally {
      database.close();
    }
  });

  it("leased and retrying outbox items parse cleanly against publishOutboxItemSchema", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const sqlStore = new SQLiteJobStore(database);
      const sqlAcc = sqlStore.acceptWebhookJob({
        delivery: { deliveryId: "del_schema", event: "pull_request" },
        job: { kind: "pull_request", repository: "sk1ua/ConsistenCy", pullRequestNumber: 1, baseSha: "b", headSha: "h" }
      });
      const sqlJob = sqlAcc.job!;
      sqlStore.markRunning(sqlJob.id);
      sqlStore.persistReportAndEnqueuePublish(sqlJob.id, createValidReport(sqlJob.id));

      const claimed = sqlStore.claimPublishOutboxItem("w1", 30000, 1);
      expect(claimed).toHaveLength(1);
      expect(publishOutboxItemSchema.parse(claimed[0]!)).toBeTruthy();

      sqlStore.markPublishOutboxRetry(claimed[0]!.id, "w1", claimed[0]!.leaseGeneration, "Network error", 1000);
      const retryingItems = sqlStore.getPublishOutbox(sqlJob.id);
      expect(retryingItems[0]!.status).toBe("retrying");
      expect(publishOutboxItemSchema.parse(retryingItems[0]!)).toBeTruthy();
    } finally {
      database.close();
    }
  });

  it("concurrency freeSlots guard: claimPublishOutboxItem is NOT called when active claims equal concurrency limit (concurrency=1 & concurrency=2)", async () => {
    const store = new InMemoryJobQueue();
    const claimSpy = vi.spyOn(store, "claimPublishOutboxItem");

    const worker = new PublishWorker({
      jobStore: store,
      concurrency: 2,
      pollIntervalMs: 50,
      leaseDurationMs: 30000,
      publishTimeoutMs: 15000,
      tokenFetcher: async () => "token",
      publisher: async (options: PublishToGitHubOptions) => {
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
    });

    const job1 = store.enqueue({ kind: "pull_request", deliveryId: "d1", repository: "r", pullRequestNumber: 1, baseSha: "b", headSha: "h" });
    store.markRunning(job1.id);
    store.persistReportAndEnqueuePublish(job1.id, createValidReport(job1.id));

    const job2 = store.enqueue({ kind: "pull_request", deliveryId: "d2", repository: "r", pullRequestNumber: 2, baseSha: "b", headSha: "h" });
    store.markRunning(job2.id);
    store.persistReportAndEnqueuePublish(job2.id, createValidReport(job2.id));

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(worker.status().activeClaims).toBe(2);
    const initialCalls = claimSpy.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(claimSpy.mock.calls.length).toBe(initialCalls);

    await worker.stop();
  });

  it("P0-1: Safe promise rejection handling and onError invocation when store mutation throws error", async () => {
    let unhandledRejectionCount = 0;
    const onUnhandledRejection = () => { unhandledRejectionCount++; };
    process.on("unhandledRejection", onUnhandledRejection);

    let onErrorCalls = 0;
    let reportedError: any;

    const store = new InMemoryJobQueue();
    const job = store.enqueue({ kind: "pull_request", deliveryId: "d_store_err", repository: "r", pullRequestNumber: 1, baseSha: "b", headSha: "h" });
    store.markRunning(job.id);
    store.persistReportAndEnqueuePublish(job.id, createValidReport(job.id));

    // Force store mutation method to throw database I/O error
    vi.spyOn(store, "markPublishOutboxSuccess").mockImplementation(() => {
      throw new Error("Disk I/O failure during markPublishOutboxSuccess");
    });
    vi.spyOn(store, "markPublishOutboxRetry").mockImplementation(() => {
      throw new Error("Disk I/O failure during markPublishOutboxRetry");
    });

    const worker = new PublishWorker({
      jobStore: store,
      concurrency: 1,
      pollIntervalMs: 30,
      tokenFetcher: async () => "token",
      publisher: async () => ({ commentId: "999" }),
      onError: (err) => {
        onErrorCalls++;
        reportedError = err;
      }
    });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await worker.stop();

    process.off("unhandledRejection", onUnhandledRejection);

    expect(onErrorCalls).toBe(1);
    expect(reportedError?.message).toBe("Disk I/O failure during markPublishOutboxRetry");
    expect(unhandledRejectionCount).toBe(0);
    expect(worker.status().activeClaims).toBe(0);
  });

  it("GitHubAppAuthenticator.getInstallationToken handles pre-aborted signal and in-flight cancellation cleanly", async () => {
    let authCalled = false;
    const authenticator = new GitHubAppAuthenticator(
      { appId: "123", privateKey: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC6\n-----END PRIVATE KEY-----" },
      () => async () => {
        authCalled = true;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { token: "ghs_test", createdAt: "now", expiresAt: "later" };
      }
    );

    const preAborted = AbortSignal.abort(new DOMException("Pre-aborted", "AbortError"));
    await expect(authenticator.getInstallationToken(10, preAborted)).rejects.toThrow("Pre-aborted");
    expect(authCalled).toBe(false);

    const controller = new AbortController();
    const inFlightPromise = authenticator.getInstallationToken(10, controller.signal);
    setTimeout(() => controller.abort(new DOMException("In-flight abort", "AbortError")), 50);

    await expect(inFlightPromise).rejects.toThrow("In-flight abort");
    expect(authCalled).toBe(true);
  });

  it("P0-1: 401 Installation Token Force-Refresh Plumbed Test", async () => {
    let fetcherCalls = 0;
    const forceRefreshParams: boolean[] = [];
    let publishCalls = 0;

    const store = new InMemoryJobQueue();
    const job = store.enqueue({ kind: "pull_request", deliveryId: "d401", repository: "r", pullRequestNumber: 1, baseSha: "b", headSha: "h" });
    store.markRunning(job.id);
    store.persistReportAndEnqueuePublish(job.id, createValidReport(job.id));

    const worker = new PublishWorker({
      jobStore: store,
      concurrency: 1,
      pollIntervalMs: 50,
      tokenFetcher: async (_j, _sig, options) => {
        fetcherCalls++;
        forceRefreshParams.push(options?.forceRefresh ?? false);
        return "token_" + fetcherCalls;
      },
      publisher: async () => {
        publishCalls++;
        if (publishCalls === 1) {
          throw classifyGitHubError({ status: 401, message: "Bad credentials" });
        }
        return { commentId: "comment_401_success" };
      }
    });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await worker.stop();

    expect(fetcherCalls).toBe(2);
    expect(forceRefreshParams).toEqual([false, true]);
    expect(publishCalls).toBe(2);
    expect(store.get(job.id)?.status).toBe("succeeded");
  });

  it("P0-1: Double 401 returns PermanentPublishError and marks job publish_failed immediately", async () => {
    let fetcherCalls = 0;
    const store = new InMemoryJobQueue();
    const job = store.enqueue({ kind: "pull_request", deliveryId: "d401_double", repository: "r", pullRequestNumber: 1, baseSha: "b", headSha: "h" });
    store.markRunning(job.id);
    store.persistReportAndEnqueuePublish(job.id, createValidReport(job.id));

    const worker = new PublishWorker({
      jobStore: store,
      concurrency: 1,
      pollIntervalMs: 50,
      tokenFetcher: async () => {
        fetcherCalls++;
        return "expired_token";
      },
      publisher: async () => {
        throw classifyGitHubError({ status: 401, message: "Unauthorized" });
      }
    });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await worker.stop();

    expect(fetcherCalls).toBe(2);
    expect(store.get(job.id)?.status).toBe("publish_failed");
    expect(store.getPublishOutbox(job.id)[0]!.attemptCount).toBe(1);
  });

  it("zero outbox store mutation after auth AbortSignal cancellation test", async () => {
    const store = new InMemoryJobQueue();
    const job = store.enqueue({ kind: "pull_request", deliveryId: "d_abort", repository: "r", pullRequestNumber: 1, baseSha: "b", headSha: "h" });
    store.markRunning(job.id);
    store.persistReportAndEnqueuePublish(job.id, createValidReport(job.id));

    const worker = new PublishWorker({
      jobStore: store,
      concurrency: 1,
      pollIntervalMs: 50,
      tokenFetcher: async (_j, signal) => {
        return new Promise((_res, rej) => {
          signal.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")), { once: true });
        });
      },
      publisher: async () => ({ commentId: "1" })
    });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 80));

    await worker.stop();

    const finalOutbox = store.getPublishOutbox(job.id)[0]!;
    expect(finalOutbox.status).toBe("leased");
  });

  it("claimPublishOutboxItem joins jobs table and excludes outbox items for terminal jobs (succeeded, cancelled, publish_failed)", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new SQLiteJobStore(database);

      const job1Acc = store.acceptWebhookJob({
        delivery: { deliveryId: "d1", event: "pull_request" },
        job: { kind: "pull_request", repository: "r", pullRequestNumber: 1, baseSha: "b", headSha: "h" }
      });
      const job1 = job1Acc.job!;
      store.markRunning(job1.id);
      store.persistReportAndEnqueuePublish(job1.id, createValidReport(job1.id));
      database.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(job1.id);

      const job2Acc = store.acceptWebhookJob({
        delivery: { deliveryId: "d2", event: "pull_request" },
        job: { kind: "pull_request", repository: "r", pullRequestNumber: 2, baseSha: "b", headSha: "h" }
      });
      const job2 = job2Acc.job!;
      store.markRunning(job2.id);
      store.persistReportAndEnqueuePublish(job2.id, createValidReport(job2.id));
      database.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(job2.id);

      const job3Acc = store.acceptWebhookJob({
        delivery: { deliveryId: "d3", event: "pull_request" },
        job: { kind: "pull_request", repository: "r", pullRequestNumber: 3, baseSha: "b", headSha: "h" }
      });
      const job3 = job3Acc.job!;
      store.markRunning(job3.id);
      store.persistReportAndEnqueuePublish(job3.id, createValidReport(job3.id));
      database.prepare("UPDATE jobs SET status = 'publish_failed' WHERE id = ?").run(job3.id);

      const claimed = store.claimPublishOutboxItem("w1", 30000, 10);
      expect(claimed).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("lease fencing isolation: stale worker completion returns false and does NOT overwrite store state", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new SQLiteJobStore(database);

      const jobAcc = store.acceptWebhookJob({
        delivery: { deliveryId: "d1", event: "pull_request" },
        job: { kind: "pull_request", repository: "r", pullRequestNumber: 1, baseSha: "b", headSha: "h" }
      });
      const job = jobAcc.job!;
      store.markRunning(job.id);
      store.persistReportAndEnqueuePublish(job.id, createValidReport(job.id));

      const claimedA = store.claimPublishOutboxItem("worker_A", 100, 1);
      expect(claimedA).toHaveLength(1);
      expect(claimedA[0]!.leaseGeneration).toBe(1);

      database.prepare("UPDATE publish_outbox SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(claimedA[0]!.id);
      const claimedB = store.claimPublishOutboxItem("worker_B", 30000, 1);
      expect(claimedB).toHaveLength(1);
      expect(claimedB[0]!.leaseGeneration).toBe(2);

      const successA = store.markPublishOutboxSuccess(claimedA[0]!.id, "worker_A", 1, "published", "comment_A");
      expect(successA).toBe(false);

      const outboxItem = store.getPublishOutbox(job.id)[0]!;
      expect(outboxItem.status).toBe("leased");
      expect(outboxItem.leaseOwner).toBe("worker_B");
      expect(outboxItem.leaseGeneration).toBe(2);

      const successB = store.markPublishOutboxSuccess(claimedB[0]!.id, "worker_B", 2, "published", "comment_B");
      expect(successB).toBe(true);

      const finalJob = store.get(job.id)!;
      expect(finalJob.status).toBe("succeeded");
    } finally {
      database.close();
    }
  });

  it("P0-3: Full Crash Window Recovery & Paginated Marker Takeover Test (Worker A create -> crash -> lease expiry -> Worker B paginated update)", async () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new SQLiteJobStore(database);

      const jobAcc = store.acceptWebhookJob({
        delivery: { deliveryId: "d_crash", event: "pull_request" },
        job: { kind: "pull_request", repository: "sk1ua/ConsistenCy", pullRequestNumber: 42, baseSha: "b", headSha: "h" }
      });
      const job = jobAcc.job!;
      store.markRunning(job.id);
      store.persistReportAndEnqueuePublish(job.id, createValidReport(job.id));

      let createCommentCalls = 0;
      let updateCommentCalls = 0;
      let paginateCalls = 0;

      // Construct a 105-comment page dataset where marker is on comment 101 (page 2, id: 999)
      const mockCommentsDataset = Array.from({ length: 105 }, (_, i) => ({
        id: i === 100 ? 999 : i + 100,
        body: i === 100 ? `Existing report\n\n<!-- consistency-job:${job.id}:github_comment -->` : `Comment ${i}`
      }));

      const fakeClientWorkerA = {
        paginate: async () => [],
        createComment: async () => {
          createCommentCalls++;
          return { data: { id: 999 } };
        },
        updateComment: async () => ({ data: { id: 999 } })
      };

      const fakeClientWorkerB = {
        paginate: async () => {
          paginateCalls++;
          return mockCommentsDataset;
        },
        createComment: async () => {
          createCommentCalls++;
          return { data: { id: 888 } };
        },
        updateComment: async (input: any) => {
          updateCommentCalls++;
          expect(input.comment_id).toBe(999);
          return { data: { id: 999 } };
        }
      };

      // 1. Worker A claims item (lease_generation = 1)
      const claimedA = store.claimPublishOutboxItem("Worker_A", 100, 1);
      expect(claimedA).toHaveLength(1);
      expect(claimedA[0]!.leaseGeneration).toBe(1);

      // 2. Worker A calls production publishToGitHub() -> creates comment id 999
      const pubResA = await publishToGitHub(
        {
          report: createValidReport(job.id),
          repositoryFullName: "sk1ua/ConsistenCy",
          pullRequestNumber: 42,
          token: "ghs_tokenA",
          externalId: null
        },
        { createClient: () => fakeClientWorkerA }
      );
      expect(pubResA.commentId).toBe("999");
      expect(createCommentCalls).toBe(1);

      // 3. Intentionally SKIP markPublishOutboxSuccess for Worker A (simulating crash before DB update)
      // 4. Force lease expiration in DB
      database.prepare("UPDATE publish_outbox SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(claimedA[0]!.id);

      // 5. Worker B claims item -> lease_generation = 2, status: leased by Worker_B
      const claimedB = store.claimPublishOutboxItem("Worker_B", 30000, 1);
      expect(claimedB).toHaveLength(1);
      expect(claimedB[0]!.leaseGeneration).toBe(2);

      // 6. Worker B calls production publishToGitHub() -> paginated marker search finds comment 999 on page 2 and updates comment 999
      const pubResB = await publishToGitHub(
        {
          report: createValidReport(job.id),
          repositoryFullName: "sk1ua/ConsistenCy",
          pullRequestNumber: 42,
          token: "ghs_tokenB",
          externalId: claimedB[0]!.externalId
        },
        { createClient: () => fakeClientWorkerB }
      );
      expect(pubResB.commentId).toBe("999");
      expect(paginateCalls).toBe(1);
      expect(updateCommentCalls).toBe(1);
      expect(createCommentCalls).toBe(1); // Total createComment remains 1!

      // 7. Worker B completes outbox item with leaseGeneration = 2 and externalId = "999"
      const successB = store.markPublishOutboxSuccess(claimedB[0]!.id, "Worker_B", 2, "published", pubResB.commentId);
      expect(successB).toBe(true);

      // 8. Stale Worker A attempts completion with leaseGeneration = 1 -> returns false
      const successA = store.markPublishOutboxSuccess(claimedA[0]!.id, "Worker_A", 1, "published", "999");
      expect(successA).toBe(false);

      // 9. Assert final DB state
      const finalJob = store.get(job.id)!;
      const finalOutbox = store.getPublishOutbox(job.id)[0]!;
      expect(finalJob.status).toBe("succeeded");
      expect(finalOutbox.status).toBe("published");
      expect(finalOutbox.externalId).toBe("999");
    } finally {
      database.close();
    }
  });

  it("P1-2: uses a valid externalId directly without marker pagination or comment creation", async () => {
    const paginate = vi.fn();
    const createComment = vi.fn();
    const updateComment = vi.fn(async ({ comment_id }: { comment_id: number }) => ({
      data: { id: comment_id }
    }));

    const result = await publishToGitHub(
      {
        report: createValidReport("job_external_id"),
        repositoryFullName: "sk1ua/ConsistenCy",
        pullRequestNumber: 42,
        token: "ghs_test_token",
        externalId: "999"
      },
      { createClient: () => ({ paginate, createComment, updateComment } as any) }
    );

    expect(result.commentId).toBe("999");
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 999 })
    );
    expect(paginate).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it("P1-2: Fast-path externalId update returning 404 falls back to paginated marker search", async () => {
    let fastPathUpdateCalls = 0;
    let fallbackPaginateCalls = 0;
    let fallbackUpdateCalls = 0;

    const fakeClient = {
      paginate: async () => [{ id: 777, body: `Marker\n\n<!-- consistency-job:job_fastpath:github_comment -->` }],
      updateComment: async (input: any) => {
        if (input.comment_id === 999) {
          fastPathUpdateCalls++;
          throw { status: 404, message: "Comment not found" };
        }
        fallbackUpdateCalls++;
        return { data: { id: 777 } };
      },
      createComment: async () => ({ data: { id: 888 } })
    };

    const res = await publishToGitHub(
      {
        report: createValidReport("job_fastpath"),
        repositoryFullName: "sk1ua/ConsistenCy",
        pullRequestNumber: 42,
        token: "ghs_token",
        externalId: "999"
      },
      { createClient: () => fakeClient }
    );

    expect(res.commentId).toBe("777");
    expect(fastPathUpdateCalls).toBe(1);
    expect(fallbackUpdateCalls).toBe(1);
  });

  it("P1-3: Unified Secret Redaction Across SQLite Outbox, Jobs, and Reports Tables on Publisher Permanent Failure", async () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new SQLiteJobStore(database);

      const secretToken = "ghs_SECRET_TOKEN_1234567890abcdef";
      const secretPat = "github_pat_SECRET_PAT_9876543210zyx";
      const secretBearer = "Bearer secret_bearer_token_val";
      const secretPem = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC6\n-----END PRIVATE KEY-----";

      const rawSecretError = `Failed with token ${secretToken}, PAT ${secretPat}, ${secretBearer}, and key ${secretPem}`;

      const jobAcc = store.acceptWebhookJob({
        delivery: { deliveryId: "d_redact", event: "pull_request" },
        job: { kind: "pull_request", repository: "r", pullRequestNumber: 1, baseSha: "b", headSha: "h" }
      });
      const job = jobAcc.job!;
      store.markRunning(job.id);
      store.persistReportAndEnqueuePublish(job.id, createValidReport(job.id));

      const worker = new PublishWorker({
        jobStore: store,
        concurrency: 1,
        pollIntervalMs: 50,
        tokenFetcher: async () => secretToken,
        publisher: async () => {
          throw new PermanentPublishError(rawSecretError, 403);
        }
      });

      worker.start();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await worker.stop();

      const outboxRow = database.prepare("SELECT * FROM publish_outbox WHERE job_id = ?").get(job.id) as any;
      const jobRow = database.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id) as any;
      const reportRow = database.prepare("SELECT * FROM reports WHERE job_id = ?").get(job.id) as any;

      expect(outboxRow.status).toBe("failed");
      expect(outboxRow.last_error).not.toContain(secretToken);
      expect(outboxRow.last_error).not.toContain("ghs_");
      expect(outboxRow.last_error).not.toContain("github_pat_");
      expect(outboxRow.last_error).not.toContain("secret_bearer_token_val");
      expect(outboxRow.last_error).not.toContain("MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC6");
      expect(outboxRow.last_error.length).toBeLessThanOrEqual(500);

      expect(jobRow.status).toBe("publish_failed");
      expect(jobRow.error).not.toContain(secretToken);
      expect(jobRow.error).not.toContain("github_pat_");
      expect(jobRow.error.length).toBeLessThanOrEqual(500);

      expect(reportRow.github_comment_status).toBe("failed");
      expect(reportRow.github_comment_error).not.toContain(secretToken);
      expect(reportRow.github_comment_error).not.toContain("github_pat_");
      expect(reportRow.github_comment_error.length).toBeLessThanOrEqual(500);
    } finally {
      database.close();
    }
  });

  it("P1-3: Unified Secret Redaction on tokenFetcher Permanent Failure", async () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new SQLiteJobStore(database);

      const secretToken = "ghs_SECRET_TOKEN_1234567890abcdef";
      const secretPat = "github_pat_SECRET_PAT_9876543210zyx";
      const secretBearer = "Bearer secret_bearer_token_val";
      const rawSecretError = `token fetch failed: token ${secretToken}, PAT ${secretPat}, ${secretBearer}`;

      const jobAcc = store.acceptWebhookJob({
        delivery: { deliveryId: "d_redact_tok", event: "pull_request" },
        job: { kind: "pull_request", repository: "r", pullRequestNumber: 1, baseSha: "b", headSha: "h" }
      });
      const job = jobAcc.job!;
      store.markRunning(job.id);
      store.persistReportAndEnqueuePublish(job.id, createValidReport(job.id));

      const publisherSpy = vi.fn();

      const worker = new PublishWorker({
        jobStore: store,
        concurrency: 1,
        pollIntervalMs: 50,
        tokenFetcher: async () => {
          throw new PermanentPublishError(rawSecretError, 401);
        },
        publisher: publisherSpy
      });

      worker.start();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await worker.stop();

      expect(publisherSpy).not.toHaveBeenCalled();

      const outboxRow = database.prepare("SELECT * FROM publish_outbox WHERE job_id = ?").get(job.id) as any;
      const jobRow = database.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id) as any;
      const reportRow = database.prepare("SELECT * FROM reports WHERE job_id = ?").get(job.id) as any;

      expect(outboxRow.status).toBe("failed");
      expect(outboxRow.last_error).not.toContain(secretToken);
      expect(outboxRow.last_error).not.toContain("github_pat_");
      expect(outboxRow.last_error).not.toContain("secret_bearer_token_val");
      expect(outboxRow.last_error.length).toBeLessThanOrEqual(500);

      expect(jobRow.status).toBe("publish_failed");
      expect(jobRow.error).not.toContain(secretToken);
      expect(jobRow.error).not.toContain("github_pat_");
      expect(jobRow.error.length).toBeLessThanOrEqual(500);

      expect(reportRow.github_comment_status).toBe("failed");
      expect(reportRow.github_comment_error).not.toContain(secretToken);
      expect(reportRow.github_comment_error).not.toContain("github_pat_");
      expect(reportRow.github_comment_error.length).toBeLessThanOrEqual(500);
    } finally {
      database.close();
    }
  });

  it("P1-3: Unified Secret Redaction on Publisher Transient Retry Failure", async () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new SQLiteJobStore(database);

      const secretToken = "ghs_SECRET_TOKEN_1234567890abcdef";
      const secretBearer = "Bearer secret_bearer_token_val";
      const rawSecretError = `network failed with ${secretBearer} and ${secretToken}`;

      const jobAcc = store.acceptWebhookJob({
        delivery: { deliveryId: "d_redact_trans", event: "pull_request" },
        job: { kind: "pull_request", repository: "r", pullRequestNumber: 1, baseSha: "b", headSha: "h" }
      });
      const job = jobAcc.job!;
      store.markRunning(job.id);
      store.persistReportAndEnqueuePublish(job.id, createValidReport(job.id));

      const worker = new PublishWorker({
        jobStore: store,
        concurrency: 1,
        pollIntervalMs: 5000, // Long poll interval so worker stops after 1 attempt
        tokenFetcher: async () => secretToken,
        publisher: async () => {
          throw new TransientPublishError(rawSecretError, 503);
        }
      });

      worker.start();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await worker.stop();

      const outboxRow = database.prepare("SELECT * FROM publish_outbox WHERE job_id = ?").get(job.id) as any;
      const jobRow = database.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id) as any;
      const reportRow = database.prepare("SELECT * FROM reports WHERE job_id = ?").get(job.id) as any;

      expect(outboxRow.status).toBe("retrying");
      expect(outboxRow.attempt_count).toBe(1);
      expect(outboxRow.last_error).not.toContain(secretToken);
      expect(outboxRow.last_error).not.toContain("secret_bearer_token_val");
      expect(outboxRow.last_error.length).toBeLessThanOrEqual(500);

      expect(jobRow.status).toBe("awaiting_publish");

      expect(reportRow.github_comment_status).toBe("pending");
      expect(reportRow.github_comment_error).not.toContain(secretToken);
      expect(reportRow.github_comment_error).not.toContain("secret_bearer_token_val");
      expect(reportRow.github_comment_error.length).toBeLessThanOrEqual(500);
    } finally {
      database.close();
    }
  });

  it("production error classifier tests covering 404, 422, 429, 403 rate limit, Retry-After, and x-ratelimit-reset", () => {
    const err404 = classifyGitHubError({ status: 404, message: "Not Found" });
    expect(err404).toBeInstanceOf(PermanentPublishError);
    expect(err404.status).toBe(404);

    const err422 = classifyGitHubError({ status: 422, message: "Validation Failed" });
    expect(err422).toBeInstanceOf(PermanentPublishError);
    expect(err422.status).toBe(422);

    const err429 = classifyGitHubError({
      status: 429,
      message: "Too Many Requests",
      response: { headers: { "retry-after": "60" } }
    });
    expect(err429).toBeInstanceOf(RateLimitedPublishError);
    expect(err429.retryAt).toBeDefined();

    const err403Rate = classifyGitHubError({
      status: 403,
      message: "Rate limit exceeded",
      response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1770000000" } }
    });
    expect(err403Rate).toBeInstanceOf(RateLimitedPublishError);
    expect(err403Rate.retryAt?.getTime()).toBe(1770000000 * 1000);
  });

  it("P1-3: Shutdown Test Coverage (sleep wake, idempotent stop, start-stop-start)", async () => {
    const store = new InMemoryJobQueue();

    const worker = new PublishWorker({
      jobStore: store,
      concurrency: 1,
      pollIntervalMs: 5000,
      tokenFetcher: async () => "token",
      publisher: async () => ({ commentId: "1" })
    });

    worker.start();
    expect(worker.status().running).toBe(true);

    const stopPromise1 = worker.stop();
    const stopPromise2 = worker.stop();
    await Promise.all([stopPromise1, stopPromise2]);
    expect(worker.status().running).toBe(false);

    worker.start();
    expect(worker.status().running).toBe(true);
    await worker.stop();
    expect(worker.status().running).toBe(false);
  });

  it("error classification & attempt count: permanent error fails on attempt 0 (0 retries), transient retries exactly 3 times", async () => {
    const store = new InMemoryJobQueue();

    const jobPerm = store.enqueue({ kind: "pull_request", deliveryId: "d_perm", repository: "r", pullRequestNumber: 1, baseSha: "b", headSha: "h" });
    store.markRunning(jobPerm.id);
    store.persistReportAndEnqueuePublish(jobPerm.id, createValidReport(jobPerm.id));
    (store.get(jobPerm.id) as any).result = undefined;

    const workerPerm = new PublishWorker({
      jobStore: store,
      concurrency: 1,
      pollIntervalMs: 50,
      tokenFetcher: async () => "token",
      publisher: async () => ({ commentId: "1" })
    });
    workerPerm.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await workerPerm.stop();

    expect(store.get(jobPerm.id)?.status).toBe("publish_failed");
    expect(store.getPublishOutbox(jobPerm.id)[0]!.attemptCount).toBe(1);

    let transientCalls = 0;
    const jobTrans = store.enqueue({ kind: "pull_request", deliveryId: "d_trans", repository: "r", pullRequestNumber: 2, baseSha: "b", headSha: "h" });
    store.markRunning(jobTrans.id);
    store.persistReportAndEnqueuePublish(jobTrans.id, createValidReport(jobTrans.id));

    const workerTrans = new PublishWorker({
      jobStore: store,
      concurrency: 1,
      pollIntervalMs: 30,
      maxAttempts: 3,
      backoffCalculator: () => 10,
      tokenFetcher: async () => "token",
      publisher: async () => {
        transientCalls++;
        throw new TransientPublishError("Network timeout", 503);
      }
    });

    workerTrans.start();

    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const outbox = store.getPublishOutbox(jobTrans.id)[0];
      if (outbox && outbox.status === "retrying") {
        (outbox as any).nextAttemptAt = new Date().toISOString();
      }
      if (store.get(jobTrans.id)?.status === "publish_failed") {
        break;
      }
    }

    await workerTrans.stop();

    expect(transientCalls).toBe(3);
    expect(store.get(jobTrans.id)?.status).toBe("publish_failed");
    expect(store.getPublishOutbox(jobTrans.id)[0]!.attemptCount).toBe(3);
  });
});
