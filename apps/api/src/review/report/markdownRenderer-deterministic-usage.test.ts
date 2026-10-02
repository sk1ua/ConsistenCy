import { describe, expect, it } from "vitest";
import type { AgentRun, ReviewReport } from "@consistency/schema";
import { renderReviewComment } from "./markdownRenderer";

function report(status: "succeeded" | "failed", llmRuns: AgentRun[] = []): ReviewReport {
  return {
    jobId: "deterministic-usage", repositoryFullName: "test/example", baseSha: "base", headSha: "head",
    summary: "Review completed.", score: 90, riskLevel: "low", findings: [], createdAt: "2026-09-29T12:00:00.000Z",
    agentRuns: [{ id: "deterministic", jobId: "deterministic-usage", agentName: "DeterministicAnalyzer", status,
      startedAt: "2026-09-29T12:00:00.000Z", inputSummary: "fixture", findings: [],
      ...(status === "failed" ? { error: "Python engine exited before analysis" } : {}) }, ...llmRuns]
  };
}

function llmRun(tokenUsage?: AgentRun["tokenUsage"]): AgentRun {
  return { id: "llm", jobId: "deterministic-usage", agentName: "Security", status: "failed",
    startedAt: "2026-09-29T12:00:00.000Z", inputSummary: "fixture", findings: [], error: "connection reset", tokenUsage };
}

describe("Markdown deterministic agent usage", () => {
  it.each(["succeeded", "failed"] as const)("does not label a %s deterministic run's token usage unknown", status => {
    const markdown = renderReviewComment(report(status), { providerName: "deepseek" });
    const row = markdown.split("\n").find(line => line.includes("DeterministicAnalyzer"));
    expect(row).toContain(status);
    expect(row).not.toContain("token");
    expect(markdown).not.toContain("token usage: unknown");
    expect(markdown).not.toContain("Totals may be incomplete");
    if (status === "failed") expect(markdown).toContain("Python engine exited before analysis");
  });

  it("still discloses unknown failed LLM usage alongside a deterministic run", () => {
    const markdown = renderReviewComment(report("succeeded", [llmRun()]), { providerName: "deepseek" });
    expect(markdown.split("\n").find(line => line.includes("DeterministicAnalyzer"))).not.toContain("token");
    expect(markdown.split("\n").find(line => line.includes("Security"))).toContain("token usage: unknown");
    expect(markdown).toContain("connection reset");
    expect(markdown).toContain("unreported usage is not counted as zero");
  });

  it("retains partial paid LLM accounting warnings", () => {
    const markdown = renderReviewComment(report("succeeded", [llmRun({ inputTokens: 17, totalTokens: 24, usageStatus: "partial" })]), { providerName: "deepseek" });
    expect(markdown).toContain("token usage: partial");
    expect(markdown).toContain("Totals may be incomplete");
    expect(markdown.split("\n").find(line => line.includes("DeterministicAnalyzer"))).not.toContain("token");
  });
});
