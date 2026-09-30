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

  it("step 3: four specialists describing one hunk in different words collapse to a single finding", () => {
    const specialist = (
      agent: ReviewFinding["agent"],
      id: string,
      title: string,
      severity: ReviewFinding["severity"],
      confidence: ReviewFinding["confidence"],
      startLine: number,
      endLine: number
    ): ReviewFinding => {
      const common = {
        id,
        agent,
        title,
        severity,
        file: "mycli/commands/run.py",
        startLine,
        endLine,
        evidence: `${agent} evidence for lines ${startLine}-${endLine}.`,
        reasoning: `${agent} reasoning about the changed hunk.`,
        recommendation: `${agent} recommendation.`
      };
      if (confidence === "confirmed") return { ...common, confidence };
      if (confidence === "likely") return { ...common, confidence };
      return { ...common, confidence, uncertainty: "The call site was not supplied." };
    };

    // The mycli shape: one six-line change, four specialists, four wordings,
    // and one Test finding that merely restates somebody else's problem.
    const merged = deduplicateAndSortFindings([
      specialist("Security", "f-security", "Shell injection in the new flag handler", "high", "confirmed", 120, 124),
      specialist("Correctness", "f-correctness", "Unquoted argument reaches subprocess", "medium", "likely", 126, 128),
      specialist("Maintainability", "f-maintainability", "The new helper mixes parsing with execution", "low", "likely", 122, 122),
      specialist("Test", "f-test", "The new branch has no coverage", "medium", "hypothesis", 127, 127)
    ]);

    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0]!.id).toBe("f-security");
    expect(merged.findings[0]!.alsoReportedBy).toEqual(["Correctness", "Maintainability", "Test"]);
    expect(merged.duplicates.map(finding => finding.id).sort())
      .toEqual(["f-correctness", "f-maintainability", "f-test"]);
  });

  it("step 3: only line ranges within three lines of each other, on the same file, are grouped", () => {
    const base: ReviewFinding = { ...confirmedHigh, id: "f-a", title: "First defect", startLine: 10, endLine: 12 };
    const exactlyThree: ReviewFinding = {
      ...base, id: "f-within", agent: "Test", title: "Defect three lines past the hunk", startLine: 15, endLine: 15
    };
    const fourLinesAway: ReviewFinding = {
      ...base, id: "f-beyond", agent: "Correctness", title: "Defect four lines past the hunk", startLine: 16, endLine: 16
    };
    const otherFile: ReviewFinding = {
      ...base, id: "f-other", agent: "Style", title: "Defect on another file", file: "mycli/other.py"
    };

    // The boundary is inclusive: a range exactly three lines past the hunk merges.
    const boundary = deduplicateAndSortFindings([base, exactlyThree]);
    expect(boundary.findings.map(finding => finding.id)).toEqual(["f-a"]);
    expect(boundary.findings[0]!.alsoReportedBy).toEqual(["Test"]);
    expect(boundary.duplicates.map(finding => finding.id)).toEqual(["f-within"]);

    // Four lines away, and another file at the same lines, stay separate.
    const separate = deduplicateAndSortFindings([base, fourLinesAway, otherFile]);
    expect(separate.findings.map(finding => finding.id)).toEqual(["f-a", "f-beyond", "f-other"]);
    expect(separate.findings.every(finding => finding.alsoReportedBy === undefined)).toBe(true);
    expect(separate.duplicates).toEqual([]);
  });

  it("step 3: does not merge findings on adjacent lines if their topic/rule does not match, and preserves mergedFindings", () => {
    const f1: ReviewFinding = {
      ...confirmedHigh,
      id: "f-sql",
      title: "SQL injection in query builder",
      evidence: "Raw string concatenation in SQL statement",
      startLine: 10,
      endLine: 12
    };
    const f2: ReviewFinding = {
      ...confirmedHigh,
      id: "f-style",
      title: "Variable naming convention violated",
      evidence: "CamelCase variable naming in python code",
      startLine: 11,
      endLine: 11
    };
    const f3: ReviewFinding = {
      ...confirmedHigh,
      id: "f-sql-duplicate",
      agent: "Correctness",
      title: "Unescaped user parameter in database query",
      evidence: "User parameter passed directly to database without sanitization",
      startLine: 11,
      endLine: 13
    };

    // f1 and f2 are on line 10-12 and 11, but f2 is style while f1 is SQL injection -> no topic overlap, should NOT merge
    const resDifferent = deduplicateAndSortFindings([f1, f2]);
    expect(resDifferent.findings).toHaveLength(2);
    expect(resDifferent.findings.map(f => f.id)).toEqual(["f-sql", "f-style"]);

    // f1 and f3 have topic overlap (database, query, sql) -> should merge into 1 finding
    const resSameTopic = deduplicateAndSortFindings([f1, f3]);
    expect(resSameTopic.findings).toHaveLength(1);
    expect(resSameTopic.findings[0]!.mergedFindings).toBeDefined();
    expect(resSameTopic.findings[0]!.mergedFindings).toHaveLength(1);
  });
});
