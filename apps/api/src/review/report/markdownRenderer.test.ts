import { describe, expect, it } from "vitest";
import type { ReviewReport } from "@consistency/schema";
import { renderReviewComment } from "./markdownRenderer";

const fixtureReport: ReviewReport = {
  jobId: "job-test-1",
  repositoryFullName: "sk1ua/ConsistenCy",
  pullRequestNumber: 34,
  baseSha: "8b3fabb",
  headSha: "2894e50",
  summary: "Automated review.",
  score: 74,
    riskLevel: "medium",
    riskBand: "medium",
    agentRuns: [],
  findings: [
    {
      id: "finding-1",
      agent: "Security",
      title: "API authorization check",
      severity: "medium",
      confidence: "hypothesis",
      file: "apps/api/src/http.ts",
      evidence: "Endpoint verification needed.",
      reasoning: "Management routes require auth.",
      recommendation: "Add bearer token.",
      uncertainty: "Proxy config not visible.",
      tags: ["api", "auth"]
    }
  ],
  createdAt: "2026-06-10T15:00:00.000Z"
};

describe("renderReviewComment", () => {
  it("renders a bounded GitHub review comment with a full report link", () => {
    const markdown = renderReviewComment(fixtureReport, {
      providerName: "deepseek",
      webBaseUrl: "http://127.0.0.1:5173",
      maxFindings: 1
    });

    expect(markdown).toContain("# ConsistenCy PR Review");
    expect(markdown).toContain("apps/api/src/http.ts");
    expect(markdown).toContain("View full report in ConsistenCy");
    expect(markdown).toContain("**Finding risk:** MEDIUM");
    expect(markdown).toContain("**Static risk:** MEDIUM");
    expect(markdown.length).toBeLessThanOrEqual(60_000);
  });
});
