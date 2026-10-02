import { describe, expect, it } from "vitest";
import type { ReviewCoverage, ReviewFinding, ReviewReport } from "@consistency/schema";
import {
  DEFAULT_THRESHOLD,
  capabilityConstraints,
  collectConstraints,
  exitCodeFor,
  renderReport
} from "./report";
import { plainPalette, plural } from "./terminal";

const OPTIONS = { palette: plainPalette } as const;

describe("plural — Chinese units must not take an English plural", () => {
  it("keeps the unit unchanged for any count", () => {
    // Regression: the default plural form used to append an `s`, so a degraded
    // report rendered `0 个文件s` and `6 个专项审查 agents`.
    expect(plural(0, "个文件")).toBe("0 个文件");
    expect(plural(1, "个文件")).toBe("1 个文件");
    expect(plural(999, "项约束")).toBe("999 项约束");
    expect(plural(6, "个专项审查 agent")).toBe("6 个专项审查 agent");
  });

  it("still honours an explicit plural form when a unit needs one", () => {
    expect(plural(1, "file", "files")).toBe("1 file");
    expect(plural(2, "file", "files")).toBe("2 files");
  });
});

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "f1",
    agent: "Security",
    title: "Prefer explicit error boundaries",
    severity: "medium",
    confidence: "likely",
    file: "apps/cli/src/main.ts",
    startLine: 120,
    endLine: 140,
    evidence: "The handler swallows the rejection.",
    reasoning: "A failed render leaves the tree mounted but stale.",
    recommendation: "Add an error boundary around the shell.",
    // Overrides go LAST. Placed before the defaults they are silently
    // discarded, which is how this fixture previously reported every finding
    // as `medium` no matter what a test asked for.
    ...overrides
  } as ReviewFinding;
}

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    jobId: "job_cli_test",
    repositoryFullName: "demo-repo",
    baseSha: "1234567",
    headSha: "abcdef1",
    summary: "Review completed.",
    score: 88,
    riskLevel: "low",
    riskBand: "medium",
    llmProvider: "deepseek",
    llmModel: "deepseek-chat",
    agentRuns: [],
    findings: [],
    createdAt: "2026-09-29T12:00:00.000Z",
    ...overrides
  } as ReviewReport;
}

const COMPLETE_COVERAGE: ReviewCoverage = {
  outcome: "complete",
  enabledAgents: ["Security"],
  failedAgents: [],
  plannerFailed: false,
  synthesizerFailed: false
};

const DEGRADED_COVERAGE: ReviewCoverage = {
  outcome: "degraded",
  enabledAgents: ["Security", "Test"],
  failedAgents: ["Test"],
  plannerFailed: false,
  synthesizerFailed: true
};

describe("renderReport — the promise this module exists to keep", () => {
  it("shows unknown failed usage rather than zero cached tokens", () => {
    const output = renderReport(report({ agentRuns: [{ id: "agent_unknown", jobId: "job_cli_test", agentName: "Security", status: "failed",
      startedAt: "2026-09-29T12:00:00.000Z", inputSummary: "fixture", findings: [], error: "request timeout after 300s" }] }), OPTIONS);
    expect(output).toContain("cached tokens: unknown");
    expect(output).toContain("token usage: unknown");
    expect(output).toContain("timeout after 300s");
    expect(output).toContain("未报告的用量不按 0");
    expect(output).not.toContain("0 cached tokens");
  });

  it("shows known paid counters alongside partial accounting warnings", () => {
    const output = renderReport(report({ agentRuns: [{ id: "agent_partial", jobId: "job_cli_test", agentName: "Security", status: "failed",
      startedAt: "2026-09-29T12:00:00.000Z", inputSummary: "fixture", findings: [], error: "request timeout after 300s",
      tokenUsage: { cachedTokens: 20, totalTokens: 100, usageStatus: "partial" } }] }), OPTIONS);
    expect(output).toContain("20 cached tokens");
    expect(output).toContain("100 tokens");
    expect(output).toContain("token usage: partial");
    expect(output).toContain("总量可能不完整");
  });
  it("discloses mixed missing and skipped baselines without hiding either", () => {
    const output = renderReport(report({ staticRiskLabel: "skipped / No Baseline" }), OPTIONS);
    expect(output).toContain("No Baseline");
    expect(output).toContain("Skipped");
  });
  it("keeps a risk label visible when the run header is omitted", () => {
    const quiet = renderReport(report({ staticRiskLabel: undefined, riskLevel: "low" }), { ...OPTIONS, header: false });
    expect(quiet).toContain("风险");
    expect(quiet).toContain("低");
    const labeled = renderReport(report({ staticRiskLabel: "Significant Drift" }), { ...OPTIONS, header: false });
    expect(labeled).toContain("Significant Drift");
    expect(labeled).toContain("结论风险带");
  });
  it("shows score, trigger, and corroborating specialists in default text output", () => {
    const output = renderReport(report({ findings: [finding({ score: 8, trigger: "An expired token is submitted", alsoReportedBy: ["Correctness", "Test"] })] }), OPTIONS);
    expect(output).toContain("评分 8/10");
    expect(output).toContain("An expired token is submitted");
    expect(output).toContain("同报: Correctness, Test");
  });
  it("renders a complete clean run as an unqualified success", () => {
    const output = renderReport(report({ coverage: { ...COMPLETE_COVERAGE } }), OPTIONS);
    expect(output).toContain("✓");
    expect(output).toContain("本次审查覆盖完整");
    // The entire point: a complete run has nothing to disclaim.
    expect(output).not.toContain("本次未检查");
    expect(output).not.toContain("[!]");
  });

  it("makes a degraded run with ZERO findings impossible to read as a clean pass", () => {
    const output = renderReport(report({ coverage: { ...DEGRADED_COVERAGE }, findings: [] }), OPTIONS);
    // No findings, but the reader must not conclude "nothing wrong here".
    expect(output).toContain("[!]");
    expect(output).toContain("未能覆盖");
    expect(output).toContain("不代表已检查且通过");
    expect(output).not.toContain("本次审查覆盖完整");
  });

  it("keeps the two independent risk measures apart", () => {
    const output = renderReport(report({ coverage: { ...COMPLETE_COVERAGE } }), OPTIONS);
    // riskLevel (static analysis) and riskBand (findings severities) disagree
    // on purpose here; merging them into one number would hide that.
    expect(output).toContain("静态分析评分");
    expect(output).toContain("结论风险带");
    expect(output).toContain("两者独立");
  });

  it("omits the risk band as '未记录' rather than inventing one", () => {
    const output = renderReport(report({ riskBand: undefined, coverage: { ...COMPLETE_COVERAGE } }), OPTIONS);
    expect(output).toContain("未记录");
  });

  it("prints the file:line locator a reader can act on", () => {
    const output = renderReport(
      report({ findings: [finding()], coverage: { ...COMPLETE_COVERAGE } }),
      OPTIONS
    );
    expect(output).toContain("apps/cli/src/main.ts:120-140");
    expect(output).toContain("发现 1 项");
  });

  it("puts off-diff findings only in a trailing pre-existing appendix", () => {
    const output = renderReport(report({ findings: [], preExistingIssues: [finding({ id: "old" })], coverage: { ...COMPLETE_COVERAGE } }), OPTIONS);
    expect(output).toContain("Pre-existing issues (1)");
    expect(output).toContain("（无 findings）");
    expect(output.indexOf("Pre-existing issues")).toBeGreaterThan(output.indexOf("agent 执行"));
  });

  it("hides reasoning behind verbose and truncates behind limit", () => {
    const findings = [finding({ id: "f1" }), finding({ id: "f2" }), finding({ id: "f3" })];
    const quiet = renderReport(report({ findings, coverage: { ...COMPLETE_COVERAGE } }), { ...OPTIONS, limit: 1 });
    expect(quiet).toContain("另有 2 项");
    expect(quiet).not.toContain("A failed render leaves the tree mounted but stale.");

    const verbose = renderReport(report({ findings, coverage: { ...COMPLETE_COVERAGE } }), {
      ...OPTIONS,
      verbose: true
    });
    expect(verbose).toContain("A failed render leaves the tree mounted but stale.");
  });
});

describe("collectConstraints", () => {
  it("reports nothing for a complete run", () => {
    expect(collectConstraints(report({ coverage: { ...COMPLETE_COVERAGE } }))).toEqual([]);
  });

  it("reports every failed agent as its own loud entry", () => {
    const constraints = collectConstraints(report({ coverage: { ...DEGRADED_COVERAGE } }));
    const codes = constraints.map(entry => entry.code);
    expect(codes).toContain("AGENT_FAILED");
    expect(codes).toContain("SYNTHESIZER_FAILED");
    expect(constraints.every(entry => entry.message.length > 0)).toBe(true);
  });

  it("treats a missing coverage block as unknown, not as complete", () => {
    const output = renderReport(report({ coverage: undefined }), OPTIONS);
    // Absence of a coverage record is not evidence of a complete review, so the
    // green "complete" claim must not appear.
    expect(output).not.toContain("本次审查覆盖完整");
    expect(output).toContain("未记录覆盖范围");
    expect(collectConstraints(report({ coverage: undefined }))).toEqual([]);
  });

  it("reports a capability leak when issued and revoked counts diverge", () => {
    expect(capabilityConstraints({ capabilitiesIssued: 4, capabilitiesRevoked: 4 })).toEqual([]);
    const leaked = capabilityConstraints({ capabilitiesIssued: 4, capabilitiesRevoked: 3 });
    expect(leaked).toHaveLength(1);
    expect(leaked[0]?.code).toBe("CAPABILITY_LEAK");
    expect(leaked[0]?.message).toContain("3");
  });
});

describe("exitCodeFor", () => {
  it("returns 0 when the review ran and nothing met the threshold", () => {
    const constraints = collectConstraints(report({ coverage: { ...COMPLETE_COVERAGE } }));
    expect(exitCodeFor(report({ coverage: { ...COMPLETE_COVERAGE } }), constraints, DEFAULT_THRESHOLD)).toBe(0);
  });

  it("returns 1 when a finding meets the threshold", () => {
    const withFinding = report({ findings: [finding({ severity: "critical" })] });
    expect(exitCodeFor(withFinding, [], DEFAULT_THRESHOLD)).toBe(1);
  });

  it("does not fail the build on info-only findings at the default threshold", () => {
    const infoOnly = report({ findings: [finding({ severity: "info" })] });
    expect(exitCodeFor(infoOnly, [], DEFAULT_THRESHOLD)).toBe(0);
  });

  it("returns 1 for info findings when the threshold is explicitly info", () => {
    const infoOnly = report({ findings: [finding({ severity: "info" })] });
    expect(exitCodeFor(infoOnly, [], "info")).toBe(1);
  });

  it("returns 2 when coverage was lost, so a gate cannot trust the run", () => {
    const constraints = collectConstraints(report({ coverage: { ...DEGRADED_COVERAGE } }));
    // No findings met the threshold, yet the run is not trustworthy.
    expect(exitCodeFor(report({ coverage: { ...DEGRADED_COVERAGE } }), constraints, DEFAULT_THRESHOLD)).toBe(2);
  });
});
