import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { SQLiteJobStore } from "../jobs/sqliteJobStore";

async function terminateWorkers(workers: Worker[]): Promise<void> {
  await Promise.allSettled(workers.map((worker) => worker.terminate()));
}

// Windows 下 SQLite sidecar 可能因句柄释放延迟而短暂无法删除：对测试自身创建的
// 精确路径做有限次数重试；最终仍失败则抛出明确错误，不允许静默残留。
async function removeDbFilesWithRetry(dbPath: string, attempts = 10, delayMs = 100): Promise<void> {
  const targets = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    lastError = undefined;
    for (const target of targets) {
      if (!existsSync(target)) continue;
      try {
        unlinkSync(target);
      } catch (error) {
        lastError = error;
      }
    }
    if (targets.every((target) => !existsSync(target))) return;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  const remaining = targets.filter((target) => existsSync(target));
  throw new Error(
    `Failed to clean up WAL test database files: ${remaining.join(", ")}` +
    (lastError ? ` (last error: ${String(lastError)})` : "")
  );
}

async function waitForWorkersReady(
  state: Int32Array,
  expectedReady: number,
  timeoutMs: number,
  workers: Worker[]
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Atomics.load(state, 0) < expectedReady) {
    if (Date.now() >= deadline) {
      await terminateWorkers(workers);
      throw new Error(
        "Timed out waiting for both WAL claim workers to open their database connections"
      );
    }
    await new Promise((res) => setTimeout(res, 10));
  }
}

const workerFixture = resolve(__dirname, "./fixtures/walClaimWorkerBootstrap.mjs");

function spawnWalClaimWorker(
  workerId: string,
  dbPath: string,
  sharedBuffer: SharedArrayBuffer,
  workers: Worker[],
  options?: { failBeforeReady?: boolean; blockBeforeReady?: boolean }
): Promise<{ workerId: string; claimedCount: number; success: boolean; item?: any; error?: string }> {
  return new Promise((res, rej) => {
    const worker = new Worker(workerFixture, {
      execArgv: [],
      workerData: {
        dbPath,
        workerId,
        sharedBuffer,
        failBeforeReady: options?.failBeforeReady,
        blockBeforeReady: options?.blockBeforeReady
      }
    });
    workers.push(worker);

    worker.on("message", (msg) => {
      worker.terminate().then(() => res(msg)).catch(() => res(msg));
    });
    worker.on("error", rej);
    worker.on("exit", (code) => {
      if (code !== 0 && code !== 1) {
        rej(new Error(`Worker ${workerId} exited with code ${code}`));
      }
    });
  });
}

describe("Multi-Thread WAL SQLite Claim Concurrency Test", () => {
  it("concurrent worker threads safely claim single outbox item via production SQLiteJobStore without SQLITE_BUSY or double claim", async () => {
    const dbPath = resolve(__dirname, `../../test_wal_claim_${Date.now()}.db`);

    await removeDbFilesWithRetry(dbPath);

    const db = openDatabase(dbPath);
    runMigrations(db);
    const store = new SQLiteJobStore(db);

    const jobAcc = store.acceptWebhookJob({
      delivery: { deliveryId: "del_wal", event: "pull_request" },
      job: { kind: "pull_request", repository: "sk1ua/ConsistenCy", pullRequestNumber: 1, baseSha: "b", headSha: "h" }
    });
    const job = jobAcc.job!;
    store.markRunning(job.id);
    store.persistReportAndEnqueuePublish(job.id, {
      jobId: job.id,
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 1,
      baseSha: "b",
      headSha: "h",
      summary: "WAL test report",
      score: 50,
      riskLevel: "medium",
      agentRuns: [],
      findings: [],
      createdAt: "2026-07-30T10:00:00Z"
    });
    db.close();

    const sharedBuffer = new SharedArrayBuffer(8); // 2 Int32s: [0] = ready count, [1] = start flag
    const typedArray = new Int32Array(sharedBuffer);
    const workers: Worker[] = [];

    try {
      const threads = [
        spawnWalClaimWorker("worker-A", dbPath, sharedBuffer, workers),
        spawnWalClaimWorker("worker-B", dbPath, sharedBuffer, workers)
      ];

      const firstWorkerFailure = Promise.race(
        threads.map((thread) =>
          thread.then(
            () => new Promise<never>(() => {}),
            (error) => Promise.reject(error)
          )
        )
      );

      await Promise.race([
        waitForWorkersReady(typedArray, 2, 5000, workers),
        firstWorkerFailure
      ]);

      Atomics.store(typedArray, 1, 1);
      Atomics.notify(typedArray, 1, 2);

      const results = await Promise.all(threads);

      const errors = results.filter((r) => !r.success).map((r) => r.error);
      expect(errors).toEqual([]);

      const totalClaimed = results.reduce((sum, r) => sum + r.claimedCount, 0);
      expect(totalClaimed).toBe(1);

      const verifyDb = openDatabase(dbPath);
      try {
        const verifyStore = new SQLiteJobStore(verifyDb);
        const updatedJob = verifyStore.get(job.id)!;
        const outbox = verifyStore.getPublishOutbox(job.id)[0]!;

        expect(updatedJob.status).toBe("publishing");
        expect(outbox.status).toBe("leased");
        expect(outbox.leaseGeneration).toBe(1);
        expect(["worker-A", "worker-B"]).toContain(outbox.leaseOwner);
      } finally {
        verifyDb.close();
      }
    } finally {
      await terminateWorkers(workers);
      await removeDbFilesWithRetry(dbPath);
    }
  });

  it("fails fast on worker bootstrap error before ready without unhandled rejections", async () => {
    const dbPath = resolve(__dirname, `../../test_wal_bootstrap_err_${Date.now()}.db`);

    await removeDbFilesWithRetry(dbPath);

    const db = openDatabase(dbPath);
    runMigrations(db);
    db.close();

    const sharedBuffer = new SharedArrayBuffer(8);
    const workers: Worker[] = [];

    try {
      const threadFailing = spawnWalClaimWorker("worker-failing", dbPath, sharedBuffer, workers, { failBeforeReady: true });
      await expect(threadFailing).rejects.toThrow("Simulated worker failure before ready");
    } finally {
      await terminateWorkers(workers);
      await removeDbFilesWithRetry(dbPath);
    }
  });

  it("terminates blocked workers and cleans up temp DB files when a worker times out waiting to be ready", async () => {
    const dbPath = resolve(__dirname, `../../test_wal_timeout_${Date.now()}.db`);

    await removeDbFilesWithRetry(dbPath);

    const db = openDatabase(dbPath);
    runMigrations(db);
    db.close();

    const sharedBuffer = new SharedArrayBuffer(8);
    const typedArray = new Int32Array(sharedBuffer);
    const workers: Worker[] = [];

    try {
      const threads = [
        spawnWalClaimWorker("worker-A", dbPath, sharedBuffer, workers),
        spawnWalClaimWorker("worker-B", dbPath, sharedBuffer, workers, { blockBeforeReady: true })
      ];

      const firstWorkerFailure = Promise.race(
        threads.map((thread) =>
          thread.then(
            () => new Promise<never>(() => {}),
            (error) => Promise.reject(error)
          )
        )
      );

      // Must prove Worker-A successfully reaches ready state first
      await Promise.race([
        waitForWorkersReady(typedArray, 1, 5000, workers),
        firstWorkerFailure
      ]);

      expect(Atomics.load(typedArray, 0)).toBe(1);

      // Second worker is blocked and never reaches ready state, triggering timeout
      await expect(
        Promise.race([
          waitForWorkersReady(typedArray, 2, 100, workers),
          firstWorkerFailure
        ])
      ).rejects.toThrow(
        "Timed out waiting for both WAL claim workers to open their database connections"
      );
    } finally {
      await terminateWorkers(workers);
      await removeDbFilesWithRetry(dbPath);

      // Assert all temp database files are cleanly deleted
      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
    }
  });
});
