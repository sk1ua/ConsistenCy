import { describe, expect, it, vi } from "vitest";
import type { PRReviewContext } from "@consistency/schema";
import { InMemoryJobQueue } from "../jobQueue";
import { MockLLMProvider } from "../review/llm/mockProvider";
import { ReviewCancelledError } from "@consistency/workload-review";
import { ReviewWorker } from "./worker";
import { DeterministicAnalyzer } from "../review/deterministic";

function enqueue(store: InMemoryJobQueue, suffix: string) {
  return store.acceptWebhookJob({
    delivery: { deliveryId: `delivery-${suffix}`, event: "pull_request", action: "opened" },
    job: {
      kind: "pull_request",
      repository: "sk1ua/ConsistenCy",
      pullRequestNumber: Number(suffix) || 34,
      installationId: 123,
      baseSha: "base123",
      headSha: "head456",
      senderLogin: "octocat",
      action: "opened"
    }
  }).job!;
}

function context(jobId: string, pullRequestNumber: number | undefined): PRReviewContext {
  return {
    jobId,
    source: "github_pr",
    repositoryFullName: "sk1ua/ConsistenCy",
    pullRequestNumber,
    baseSha: "base123",
    headSha: "head456",
    changedFiles: [],
    diff: "",
    fileContents: {},
    baseFileContents: {},
    projectMetadata: {},
    workspacePath: `C:/consistency/workspaces/${jobId}`
  };
}

function createMockAnalyzer() {
  const analyzer = new DeterministicAnalyzer("python", "engine");
  vi.spyOn(analyzer, "analyze").mockResolvedValue({
    id: "req_1",
    ok: true,
    files: []
  });
  vi.spyOn(analyzer, "composeReview").mockResolvedValue({
    id: "req_2",
    ok: true,
    overallScore: 100,
    riskLevel: "low",
    summary: "Mock analysis summary",
    recommendations: []
  });
  return analyzer;
}

describe("ReviewWorker", () => {
  it("automatically executes a queued job to awaiting_publish and outbox entry", async () => {
    const store = new InMemoryJobQueue();
    const job = enqueue(store, "34");
    const analyzer = createMockAnalyzer();
    const worker = new ReviewWorker({
      jobStore: store,
      workflow: {
        provider: new MockLLMProvider(),
        deterministicAnalyzer: analyzer,
        contextBuilder: input => Promise.resolve(context(input.jobId, input.pullRequestNumber))
      }
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(store.get(job.id)).toMatchObject({ status: "awaiting_publish", result: { score: 100 } });
    expect(worker.status().activeJobs).toBe(0);
  });

  it("marks a job failed when context construction fails", async () => {
    const store = new InMemoryJobQueue();
    const job = enqueue(store, "35");
    const analyzer = createMockAnalyzer();
    const worker = new ReviewWorker({
      jobStore: store,
      workflow: {
        provider: new MockLLMProvider(),
        deterministicAnalyzer: analyzer,
        contextBuilder: async () => { throw new Error("GitHub clone failed"); }
      }
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(store.get(job.id)).toMatchObject({ status: "failed", error: "GitHub clone failed" });
  });

  it("honors configured concurrency", async () => {
    const store = new InMemoryJobQueue();
    enqueue(store, "36");
    enqueue(store, "37");
    let active = 0;
    let maximumActive = 0;
    const analyzer = createMockAnalyzer();
    const worker = new ReviewWorker({
      jobStore: store,
      concurrency: 2,
      workflow: {
        provider: new MockLLMProvider(),
        deterministicAnalyzer: analyzer,
        contextBuilder: async input => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise(resolve => setTimeout(resolve, 20));
          active -= 1;
          return context(input.jobId, input.pullRequestNumber);
        }
      }
    });

    await expect(worker.runOnce()).resolves.toBe(2);
    expect(maximumActive).toBe(2);
    expect(store.list().every(job => job.status === "awaiting_publish")).toBe(true);
  });
});

describe("ReviewWorker shutdown grace (audit P1-07③) and cancellation guard (P1-07①)", () => {
  it("stop() fires the grace-expiry hook instead of waiting forever on a hung job", async () => {
    const store = new InMemoryJobQueue();
    const job = enqueue(store, "77");
    const worker = new ReviewWorker({
      jobStore: store,
      workflow: {
        provider: new MockLLMProvider(),
        deterministicAnalyzer: createMockAnalyzer(),
        contextBuilder: async input => {
          // Simulates a hung/slow context build (in production: an
          // in-flight provider call that ignores nothing — the host cancels
          // live runs on expiry so the call aborts).
          await new Promise(resolve => setTimeout(resolve, 300));
          throw new Error(`context build failed for ${input.jobId}`);
        }
      }
    });
    worker.start();

    const onExpiry = vi.fn();
    const startedAt = Date.now();
    await worker.stop({ ms: 50, onExpiry });
    const elapsed = Date.now() - startedAt;

    expect(onExpiry).toHaveBeenCalledTimes(1);
    // stop() returned within the two grace windows (50 + 50 ms), long before
    // the 300 ms job finished — shutdown no longer blocks indefinitely.
    expect(elapsed).toBeLessThan(300);

    // The abandoned job still settles: the loop finished afterwards.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(store.get(job.id)?.status).toBe("failed");
  });

  it("stop() resolves immediately when nothing is in flight", async () => {
    const worker = new ReviewWorker({
      jobStore: new InMemoryJobQueue(),
      workflow: {
        provider: new MockLLMProvider(),
        deterministicAnalyzer: createMockAnalyzer(),
        contextBuilder: input => Promise.resolve(context(input.jobId, input.pullRequestNumber))
      }
    });
    worker.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    const onExpiry = vi.fn();
    await worker.stop({ ms: 1_000, onExpiry });
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it("never overwrites a cancelled job with failed (P1-07①)", async () => {
    const store = new InMemoryJobQueue();
    const job = enqueue(store, "78");
    store.markRunning(job.id);
    store.updateStatus(job.id, "cancelled", "Cancelled by request");
    const worker = new ReviewWorker({
      jobStore: store,
      workflow: {
        provider: new MockLLMProvider(),
        deterministicAnalyzer: createMockAnalyzer(),
        contextBuilder: async input => {
          throw new ReviewCancelledError(`review run ${input.jobId} was cancelled`);
        }
      }
    });

    await worker.execute(store.get(job.id)!);

    expect(store.get(job.id)?.status).toBe("cancelled");
  });
});
