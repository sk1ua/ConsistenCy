import { describe, expect, it, vi } from "vitest";
import { InMemoryJobQueue } from "./jobQueue";

describe("InMemoryJobQueue Outbox & Schema Parity", () => {
  it("persists analysis-only reports without entering the GitHub comment outbox", () => {
    const queue = new InMemoryJobQueue();
    const job = queue.enqueue({
      kind: "pull_request",
      deliveryId: "public-url-1",
      repository: "espnet/espnet",
      pullRequestNumber: 6327,
      installationId: 42,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      publicationPolicy: "disabled"
    });
    queue.markRunning(job.id);
    const updated = queue.persistReportAndEnqueuePublish(job.id, {
      jobId: job.id,
      repositoryFullName: job.repository,
      pullRequestNumber: job.pullRequestNumber!,
      baseSha: job.baseSha!,
      headSha: job.headSha!,
      summary: "Analysis-only report",
      score: 88,
      riskLevel: "low",
      agentRuns: [],
      findings: [],
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    expect(updated?.status).toBe("succeeded");
    expect(queue.getPublishOutbox(job.id)).toHaveLength(0);
    expect(queue.getReportCommentStatus(job.id)).toEqual({ status: "skipped" });
  });

  it("enforces reviewReportSchema parsing before mutation and persists outbox item", () => {
    const queue = new InMemoryJobQueue();
    const acceptance = queue.acceptWebhookJob({
      delivery: { deliveryId: "del_1", event: "pull_request", action: "opened" },
      job: {
        kind: "pull_request",
        repository: "sk1ua/ConsistenCy",
        pullRequestNumber: 10,
        installationId: 1,
        baseSha: "base",
        headSha: "head"
      }
    });

    const job = acceptance.job!;
    queue.markRunning(job.id);

    // Invalid report schema (missing score) must throw BEFORE modifying job or outbox
    const invalidReport: any = {
      jobId: job.id,
      repositoryFullName: "sk1ua/ConsistenCy"
    };

    expect(() => queue.persistReportAndEnqueuePublish(job.id, invalidReport)).toThrow();
    expect(queue.get(job.id)?.status).toBe("running"); // Status unchanged
    expect(queue.getPublishOutbox(job.id)).toHaveLength(0); // Outbox unchanged

    // Valid report
    const validReport = {
      jobId: job.id,
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 10,
      baseSha: "base",
      headSha: "head",
      summary: "Clean review",
      score: 95,
      riskLevel: "low" as const,
      agentRuns: [],
      findings: [],
      createdAt: "2026-07-30T12:00:00.000Z"
    };

    const updated = queue.persistReportAndEnqueuePublish(job.id, validReport);
    expect(updated?.status).toBe("awaiting_publish");

    // Outbox item created
    const outbox = queue.getPublishOutbox(job.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      jobId: job.id,
      target: "github_comment",
      status: "pending",
      attemptCount: 0
    });

    // Idempotent replay: calling again maintains a single outbox item
    queue.persistReportAndEnqueuePublish(job.id, validReport);
    expect(queue.getPublishOutbox(job.id)).toHaveLength(1);

    // Terminal status no-op with invalid payload does NOT throw ZodError
    queue.updateStatus(job.id, "publishing");
    const terminalResult = queue.persistReportAndEnqueuePublish(job.id, {} as any);
    expect(terminalResult?.status).toBe("publishing");
  });

  it("returns the exact latest pull request job per requested number without a global history cutoff", () => {
    vi.useFakeTimers();
    try {
      const queue = new InMemoryJobQueue();
      vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
      const pr1 = queue.enqueue({
        kind: "pull_request",
        repository: "owner/repo",
        repositoryId: "repository-1",
        pullRequestNumber: 1
      });
      let newestPr2 = "";
      for (let index = 0; index < 201; index += 1) {
        vi.setSystemTime(new Date(Date.parse("2026-08-02T00:00:00.000Z") + index * 1_000));
        newestPr2 = queue.enqueue({
          kind: "pull_request",
          repository: "owner/repo",
          repositoryId: "repository-1",
          pullRequestNumber: 2
        }).id;
      }
      queue.enqueue({ kind: "pull_request", repository: "other/repo", repositoryId: "repository-2", pullRequestNumber: 1 });
      queue.enqueue({ kind: "pull_request", repository: "owner/repo", pullRequestNumber: 1 });
      queue.enqueue({ kind: "push", repository: "owner/repo", repositoryId: "repository-1", pullRequestNumber: 1 });

      expect(queue.listLatestPullRequestJobsForRepository("repository-1", [1, 2, 2]).map(job => job.id))
        .toEqual([newestPr2, pr1.id]);
      expect(queue.listLatestPullRequestJobsForRepository("repository-1", [])).toEqual([]);
      expect(() => queue.listLatestPullRequestJobsForRepository(
        "repository-1",
        Array.from({ length: 101 }, (_, index) => index + 1)
      )).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
