import { demoReviewReport } from "@consistency/schema";
import type { ReviewJobStore } from "../jobQueue";

export function seedDemoData(store: ReviewJobStore): { created: number } {
  const definitions: Array<{ repository: string; pullRequestNumber: number; score?: number; status: "succeeded" | "running" | "queued" | "failed" }> = [
    { repository: "sk1ua/ConsistenCy", pullRequestNumber: 34, score: 74, status: "succeeded" as const },
    { repository: "acme/payments-api", pullRequestNumber: 182, score: 42, status: "succeeded" as const },
    { repository: "studio/design-system", pullRequestNumber: 76, score: 91, status: "succeeded" as const },
    { repository: "acme/customer-portal", pullRequestNumber: 221, status: "running" as const },
    { repository: "acme/ops-runner", pullRequestNumber: 166, status: "queued" as const },
    { repository: "acme/billing-api", pullRequestNumber: 377, score: 62, status: "succeeded" as const },
    { repository: "acme/notifications", pullRequestNumber: 254, score: 68, status: "succeeded" as const },
    { repository: "acme/auth-service", pullRequestNumber: 312, status: "failed" as const }
  ];
  const existing = new Set(store.list().map(job => job.baseSha));
  let created = 0;
  for (const [index, definition] of definitions.entries()) {
    const baseSha = `demo-base-${index + 1}`;
    if (existing.has(baseSha)) continue;
    const deliveryId = `manual:demo:${index + 1}`;
    store.recordWebhookDelivery({
      deliveryId,
      event: "pull_request",
      action: "opened",
      status: "enqueued"
    });
    const job = store.enqueue({
      kind: "pull_request",
      deliveryId,
      repository: definition.repository,
      pullRequestNumber: definition.pullRequestNumber,
      installationId: 1,
      baseSha,
      headSha: `demo-head-${index + 1}`
    });
    created += 1;
    if (definition.status === "queued") continue;
    if (definition.status === "running") {
      store.markRunning(job.id);
      continue;
    }
    store.markRunning(job.id);
    if (definition.status === "failed") {
      store.markFailed(job.id, "Demo failure: review provider unavailable");
      continue;
    }
    const score = definition.score ?? 100;
    store.markSucceeded(job.id, {
      ...demoReviewReport,
      jobId: job.id,
      repositoryFullName: definition.repository,
      pullRequestNumber: definition.pullRequestNumber,
      baseSha: job.baseSha!,
      headSha: job.headSha!,
      score,
      riskLevel: score < 40 ? "critical" : score < 60 ? "high" : score < 80 ? "medium" : "low",
      summary: `Demo review for ${definition.repository} pull request #${definition.pullRequestNumber}.`,
      agentRuns: demoReviewReport.agentRuns.map(run => ({ ...run, id: `${run.id}_${index}`, jobId: job.id })),
      findings: demoReviewReport.findings.map(finding => ({ ...finding, id: `${finding.id}_${index}` })),
      createdAt: new Date(Date.now() - index * 3_600_000).toISOString()
    });
  }
  return { created };
}
