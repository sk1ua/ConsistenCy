import { describe, expect, it } from "vitest";
import { repoHealthMetricsSchema, type ReviewReport } from "@consistency/schema";
import { computeHealthMetrics, riskIndexFromScore, summariseReviewHistory } from "./metrics";

function report(score: number, severities: string[] = []): ReviewReport {
  return {
    jobId: `job-${score}`,
    repositoryFullName: "sk1ua/ConsistenCy",
    pullRequestNumber: 1,
    baseSha: "base123",
    headSha: "head456",
    summary: "Summary",
    score,
    riskLevel: "medium",
    agentRuns: [],
    findings: severities.map((severity, index) => ({
      id: `finding-${index}`,
      agent: "Security" as const,
      title: "Issue",
      severity: severity as ReviewReport["findings"][number]["severity"],
      confidence: "likely" as const,
      file: "apps/api/src/http.ts",
      evidence: "Evidence",
      reasoning: "Reasoning",
      recommendation: "Recommendation"
    })),
    createdAt: "2026-08-05T00:00:00.000Z"
  };
}

const churn = { windowDays: 14, commits: 20, linesChanged: 1400, filesTouched: 30 };

describe("riskIndexFromScore", () => {
  it("inverts a quality score so higher always means worse", () => {
    expect(riskIndexFromScore(100)).toBe(0);
    expect(riskIndexFromScore(0)).toBe(1);
    expect(riskIndexFromScore(74)).toBeCloseTo(0.26, 4);
  });

  it("clamps scores outside the documented range", () => {
    expect(riskIndexFromScore(120)).toBe(0);
    expect(riskIndexFromScore(-20)).toBe(1);
  });
});

describe("summariseReviewHistory", () => {
  it("returns zeroed debt and no indices with no history", () => {
    expect(summariseReviewHistory([])).toEqual({ unsettledSecurityDebt: 0 });
  });

  it("averages the recent window and the one before it", () => {
    const snapshot = summariseReviewHistory(
      [report(80), report(80), report(40), report(40)],
      2
    );
    expect(snapshot.riskIndex).toBeCloseTo(0.2, 4);
    expect(snapshot.previousRiskIndex).toBeCloseTo(0.6, 4);
  });

  it("counts only critical and high findings, and only from the latest report", () => {
    const snapshot = summariseReviewHistory([
      report(70, ["critical", "high", "medium", "low", "info"]),
      report(70, ["critical", "critical", "critical"])
    ]);
    // Older findings were either fixed or restated by the newer report.
    expect(snapshot.unsettledSecurityDebt).toBe(2);
  });
});

describe("computeHealthMetrics", () => {
  it("produces a schema-valid metrics block", () => {
    const metrics = computeHealthMetrics({
      churn,
      history: summariseReviewHistory([report(74)]),
      filesTracked: 302,
      computedAt: new Date("2026-08-05T12:00:00.000Z")
    });

    expect(() => repoHealthMetricsSchema.parse(metrics)).not.toThrow();
    expect(metrics.churnRate).toBe(100);
    expect(metrics.filesTracked).toBe(302);
    expect(metrics.riskIndex).toBeCloseTo(0.26, 4);
  });

  it("reports an unreviewed repository as flat rather than inventing a score", () => {
    const metrics = computeHealthMetrics({
      churn,
      history: summariseReviewHistory([]),
      filesTracked: 10,
      computedAt: new Date("2026-08-05T12:00:00.000Z")
    });
    expect(metrics.riskIndex).toBe(0);
    expect(metrics.riskIndexTrend).toBe(0);
  });

  it("reports a negative trend when risk is falling", () => {
    const metrics = computeHealthMetrics({
      churn,
      history: { riskIndex: 0.2, previousRiskIndex: 0.6, unsettledSecurityDebt: 0 },
      filesTracked: 10,
      computedAt: new Date("2026-08-05T12:00:00.000Z")
    });
    expect(metrics.riskIndexTrend).toBeCloseTo(-0.4, 4);
  });

  it("keeps the trend within the schema's bounds", () => {
    const metrics = computeHealthMetrics({
      churn,
      history: { riskIndex: 1, previousRiskIndex: 0, unsettledSecurityDebt: 0 },
      filesTracked: 10,
      computedAt: new Date("2026-08-05T12:00:00.000Z")
    });
    expect(metrics.riskIndexTrend).toBe(1);
    expect(() => repoHealthMetricsSchema.parse(metrics)).not.toThrow();
  });

  it("never divides by a zero-day window", () => {
    const metrics = computeHealthMetrics({
      churn: { ...churn, windowDays: 0 },
      history: { unsettledSecurityDebt: 0 },
      filesTracked: 0,
      computedAt: new Date("2026-08-05T12:00:00.000Z")
    });
    expect(Number.isFinite(metrics.churnRate)).toBe(true);
    expect(metrics.windowDays).toBe(1);
  });
});
