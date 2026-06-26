import { describe, expect, it } from "vitest";
import type { PRReviewContext } from "@consistency/schema";
import { InMemoryJobQueue } from "../jobQueue";
import { MockLLMProvider } from "../review/llm/mockProvider";
import { ReviewWorker } from "./worker";

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

function context(jobId: string, pullRequestNumber: number): PRReviewContext {
  return {
    jobId,
    repositoryFullName: "sk1ua/ConsistenCy",
    pullRequestNumber,
    baseSha: "base123",
    headSha: "head456",
    changedFiles: [],
    diff: "",
    fileContents: {},
    projectMetadata: {},
    workspacePath: `C:/consistency/workspaces/${jobId}`
  };
}

describe("ReviewWorker", () => {
  it("automatically executes a queued job to a persisted report", async () => {
    const store = new InMemoryJobQueue();
    const job = enqueue(store, "34");
    const worker = new ReviewWorker({
      jobStore: store,
      workflow: {
        provider: new MockLLMProvider(),
        contextBuilder: input => Promise.resolve(context(input.jobId, input.pullRequestNumber))
      }
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(store.get(job.id)).toMatchObject({ status: "succeeded", result: { score: 100 } });
    expect(worker.status().activeJobs).toBe(0);
  });

  it("marks a job failed when context construction fails", async () => {
    const store = new InMemoryJobQueue();
    const job = enqueue(store, "35");
    const worker = new ReviewWorker({
      jobStore: store,
      workflow: {
        provider: new MockLLMProvider(),
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
    const worker = new ReviewWorker({
      jobStore: store,
      concurrency: 2,
      workflow: {
        provider: new MockLLMProvider(),
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
    expect(store.list().every(job => job.status === "succeeded")).toBe(true);
  });
});
