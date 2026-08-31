import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "@consistency/schema";
import { buildReviewReport, deduplicateAndSortFindings } from "./reportBuilder";

const confirmedHigh: ReviewFinding = {
  id: "finding-high",
  agent: "Security",
  title: "Webhook signature is not verified",
  severity: "high",
  confidence: "confirmed",
  file: "apps/api/src/http.ts",
  startLine: 10,
  endLine: 12,
  evidence: "The handler accepts the body without checking x-hub-signature-256.",
  reasoning: "An attacker can forge webhook requests.",
  recommendation: "Verify the HMAC before parsing the payload."
};

describe("reportBuilder", () => {
  it("deduplicates by location and title while keeping stronger confidence", () => {
    const hypothesis: ReviewFinding = {
      ...confirmedHigh,
      id: "finding-hypothesis",
      agent: "Correctness",
      confidence: "hypothesis",
      startLine: undefined,
      endLine: undefined,
      uncertainty: "The deployment boundary was not supplied."
    };
    const { findings, duplicates } = deduplicateAndSortFindings([hypothesis, confirmedHigh]);
    expect(findings).toEqual([confirmedHigh]);
    expect(duplicates).toEqual([hypothesis]);

    const duplicateLikely: ReviewFinding = {
      ...confirmedHigh,
      id: "finding-likely",
      agent: "Correctness",
      confidence: "likely"
    };
    const exact = deduplicateAndSortFindings([duplicateLikely, confirmedHigh]);
    expect(exact.findings).toEqual([confirmedHigh]);
    expect(exact.duplicates).toEqual([duplicateLikely]);
  });

  it("merges near-duplicate titles from different agents on the same file", () => {
    const styleVariant: ReviewFinding = {
      ...confirmedHigh,
      id: "finding-style",
      agent: "Style",
      title: "Route complexity in api contract acceptance test.ts",
      severity: "medium",
      confidence: "likely"
    };
    const correctnessVariant: ReviewFinding = {
      ...confirmedHigh,
      id: "finding-correctness",
      agent: "Correctness",
      title: "Route complexity in api contract acceptance test file",
      severity: "medium",
      confidence: "confirmed"
    };
    const distinct: ReviewFinding = {
      ...confirmedHigh,
      id: "finding-distinct",
      agent: "Test",
      title: "Missing coverage for webhook delivery deduplication",
      file: "apps/api/src/trigger/webhook.test.ts",
      severity: "medium"
    };

    const { findings, duplicates } = deduplicateAndSortFindings([styleVariant, correctnessVariant, distinct]);
    expect(findings).toHaveLength(2);
    expect(findings.map(f => f.id)).not.toContain("finding-style");
    expect(duplicates.map(f => f.id)).toEqual(["finding-style"]);
    expect(findings.some(f => f.id === "finding-distinct")).toBe(true);
  });

  it("normalizes Unicode titles and keeps the highest severity survivor", () => {
    const chineseHigh: ReviewFinding = {
      ...confirmedHigh,
      id: "finding-cn-high",
      title: "路由 复杂度 需要审查",
      severity: "high",
      confidence: "hypothesis",
      startLine: undefined,
      endLine: undefined,
      uncertainty: "Line context is incomplete."
    };
    const chineseCritical: ReviewFinding = {
      ...confirmedHigh,
      id: "finding-cn-critical",
      title: "路由复杂度需要审查",
      severity: "critical",
      confidence: "likely",
      startLine: undefined,
      endLine: undefined
    };
    const result = deduplicateAndSortFindings([chineseHigh, chineseCritical]);
    expect(result.findings).toEqual([chineseCritical]);
    expect(result.duplicates).toEqual([chineseHigh]);

    const chineseDistinct: ReviewFinding = {
      ...confirmedHigh,
      id: "finding-cn-distinct",
      title: "用户输入导致权限绕过",
      severity: "high",
      confidence: "hypothesis",
      startLine: undefined,
      endLine: undefined,
      uncertainty: "Line context is incomplete."
    };
    const distinctResult = deduplicateAndSortFindings([chineseCritical, chineseDistinct]);
    expect(distinctResult.findings).toHaveLength(2);
    expect(distinctResult.duplicates).toHaveLength(0);
  });

  it("derives riskBand from the final findings' severity distribution", () => {
    const medium: ReviewFinding = { ...confirmedHigh, severity: "medium" };
    const reportHigh = buildReviewReport({
      jobId: "job-1",
      repositoryFullName: "sk1ua/ConsistenCy",
      baseSha: "base",
      headSha: "head",
      summary: "Canonical report",
      agentRuns: [],
      findings: [confirmedHigh, medium],
      score: 90,
      riskLevel: "low"
    });
    // riskLevel is the deterministic score band; riskBand is the findings verdict.
    expect(reportHigh.riskLevel).toBe("low");
    expect(reportHigh.riskBand).toBe("high");

    const reportNone = buildReviewReport({
      jobId: "job-2",
      repositoryFullName: "sk1ua/ConsistenCy",
      baseSha: "base",
      headSha: "head",
      summary: "Canonical report",
      agentRuns: [],
      findings: [],
      score: 90,
      riskLevel: "low"
    });
    expect(reportNone.riskBand).toBe("none");
  });

  it("builds review report requiring mandatory score and riskLevel", () => {
    const report = buildReviewReport({
      jobId: "job-1",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 1,
      baseSha: "base",
      headSha: "head",
      summary: "Canonical report",
      agentRuns: [],
      findings: [confirmedHigh],
      score: 42,
      riskLevel: "high"
    });

    expect(report.score).toBe(42);
    expect(report.riskLevel).toBe("high");
    expect(report.findings).toEqual([confirmedHigh]);
  });
});
