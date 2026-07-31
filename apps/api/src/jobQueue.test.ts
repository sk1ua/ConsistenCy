import { describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "./jobQueue";

describe("InMemoryJobQueue Outbox & Schema Parity", () => {
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
});
