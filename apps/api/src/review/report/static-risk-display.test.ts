import { expect, it } from "vitest";
import { staticRiskDisplayLabel, type ReviewReport } from "@consistency/schema";
import { renderReviewComment } from "./markdownRenderer";

it("uses the same peak-file static label as the terminal, including baseline warnings", () => {
  const report: ReviewReport = {
    jobId: "job_static", repositoryFullName: "owner/repo", baseSha: "base", headSha: "head",
    summary: "Review complete", score: 88, riskLevel: "low", findings: [], agentRuns: [],
    staticRiskLabel: "Severe Drift / No Baseline / skipped", createdAt: "2026-09-30T12:00:00.000Z",
  };
  const markdown = renderReviewComment(report, { providerName: "mock" });
  expect(markdown).toContain(`**Static risk:** ${staticRiskDisplayLabel(report.riskLevel, report.staticRiskLabel)}`);
  expect(markdown).not.toContain("**Static risk:** LOW");
});
