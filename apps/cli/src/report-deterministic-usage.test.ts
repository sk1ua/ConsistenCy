import { describe, expect, it } from "vitest";
import type { AgentRun, ReviewReport } from "@consistency/schema";
import { renderReport } from "./report";
import { plainPalette } from "./terminal";

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

describe("terminal deterministic agent usage", () => {
  it.each(["succeeded", "failed"] as const)("does not label a %s deterministic run's token usage unknown", status => {
    const output = renderReport(report(status), { palette: plainPalette });
    const row = output.split("\n").find(line => line.includes("DeterministicAnalyzer"));
    expect(row).toBeDefined();
    expect(row).not.toContain("token");
    expect(output).not.toContain("token usage: unknown");
    expect(output).not.toContain("cached tokens: unknown");
    if (status === "failed") expect(output).toContain("Python engine exited before analysis");
  });

  it("still discloses unknown failed LLM usage alongside a deterministic run", () => {
    const output = renderReport(report("succeeded", [llmRun()]), { palette: plainPalette });
    expect(output.split("\n").find(line => line.includes("DeterministicAnalyzer"))).not.toContain("token");
    expect(output.split("\n").find(line => line.includes("Security"))).toContain("token usage: unknown");
    expect(output).toContain("cached tokens: unknown");
    expect(output).toContain("connection reset");
    expect(output).toContain("未报告的用量不按 0");
    expect(output).not.toContain("0 cached tokens");
  });

  it("retains partial paid LLM counters and warnings", () => {
    const output = renderReport(report("succeeded", [llmRun({ inputTokens: 17, cachedTokens: 5, totalTokens: 24, usageStatus: "partial" })]), { palette: plainPalette });
    expect(output).toContain("24 tokens");
    expect(output).toContain("5 cached tokens");
    expect(output).toContain("token usage: partial");
    expect(output).toContain("总量可能不完整");
    expect(output.split("\n").find(line => line.includes("DeterministicAnalyzer"))).not.toContain("token");
  });
});
