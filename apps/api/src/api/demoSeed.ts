import { demoReviewReport } from "@consistency/schema";
import type { ReviewJobStore } from "../jobQueue";

export function seedDemoData(store: ReviewJobStore): { created: number } {
  if (store.list().some(job => job.baseSha?.startsWith("demo-base-"))) return { created: 0 };
  const definitions = [
    { repository: "sk1ua/ConsistenCy", pullRequestNumber: 34, score: 74, status: "succeeded" as const },
    { repository: "acme/payments-api", pullRequestNumber: 182, score: 42, status: "succeeded" as const },
    { repository: "studio/design-system", pullRequestNumber: 76, score: 91, status: "succeeded" as const },
    { repository: "acme/customer-portal", pullRequestNumber: 221, score: 100, status: "running" as const }
  ];
  for (const [index, definition] of definitions.entries()) {
    const job = store.enqueue({
      kind: "pull_request",
      deliveryId: `manual:demo:${index + 1}`,
      repository: definition.repository,
      pullRequestNumber: definition.pullRequestNumber,
      installationId: 1,
      baseSha: `demo-base-${index + 1}`,
      headSha: `demo-head-${index + 1}`
    });
    if (definition.status === "running") {
      store.markRunning(job.id);
      continue;
    }
    store.markRunning(job.id);
    store.markSucceeded(job.id, {
      ...demoReviewReport,
      jobId: job.id,
      repositoryFullName: definition.repository,
      pullRequestNumber: definition.pullRequestNumber,
      baseSha: job.baseSha!,
      headSha: job.headSha!,
      score: definition.score,
      riskLevel: definition.score < 40 ? "critical" : definition.score < 60 ? "high" : definition.score < 80 ? "medium" : "low",
      summary: `Demo review for ${definition.repository} pull request #${definition.pullRequestNumber}.`,
      agentRuns: demoReviewReport.agentRuns.map(run => ({ ...run, id: `${run.id}_${index}`, jobId: job.id })),
      findings: demoReviewReport.findings.map(finding => ({ ...finding, id: `${finding.id}_${index}` })),
      createdAt: new Date(Date.now() - index * 3_600_000).toISOString()
    });
  }
  return { created: definitions.length };
}
