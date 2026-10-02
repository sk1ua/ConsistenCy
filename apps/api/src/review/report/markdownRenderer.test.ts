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
  it("discloses unknown and partial accounting and safe specific failure reasons", () => {
    const report: ReviewReport = { ...fixtureReport, agentRuns: [
      { id: "unknown", jobId: fixtureReport.jobId, agentName: "Security", status: "failed", startedAt: fixtureReport.createdAt,
        inputSummary: "fixture", findings: [], error: "request timeout after 300s; Authorization: Bearer secret-marker" },
      { id: "partial", jobId: fixtureReport.jobId, agentName: "Synthesizer", status: "failed", startedAt: fixtureReport.createdAt,
        inputSummary: "fixture", findings: [], error: "connection reset", tokenUsage: { inputTokens: 10, usageStatus: "partial" } }
    ] };
    const markdown = renderReviewComment(report, { providerName: "deepseek" });
    expect(markdown).toContain("token usage: unknown");
    expect(markdown).toContain("token usage: partial");
    expect(markdown).toContain("timeout after 300s");
    expect(markdown).toContain("connection reset");
    expect(markdown).toContain("not counted as zero");
    expect(markdown).toContain("Totals may be incomplete");
    expect(markdown).not.toContain("secret-marker");
  });
  it("shows score, trigger, and corroborating specialists", () => {
    const report: ReviewReport = { ...fixtureReport, findings: [{ ...fixtureReport.findings[0]!, score: 9, trigger: "An expired token is submitted", alsoReportedBy: ["Correctness", "Test"] }] };
    const markdown = renderReviewComment(report, { providerName: "mock" });
    expect(markdown).toContain("Score: 9/10");
    expect(markdown).toContain("Trigger scenario:** An expired token is submitted");
    expect(markdown).toContain("Also: Correctness, Test");
  });
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
