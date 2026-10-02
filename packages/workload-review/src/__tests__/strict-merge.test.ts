import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "@consistency/schema";
import { buildReviewReport, deduplicateAndSortFindings } from "../synthesis/report.js";

function finding(extra: Partial<ReviewFinding> & Pick<ReviewFinding, "id" | "agent" | "title" | "startLine" | "endLine">): ReviewFinding {
  const base: ReviewFinding = {
    severity: "medium",
    confidence: "likely",
    file: "statsmodels/tests/test_x.py",
    evidence: "`test_x` remains `thread_unsafe` after the migration.",
    reasoning: "The changed test does not follow the surrounding migration.",
    recommendation: "Update the changed test.",
    trigger: "when the changed test runs",
    id: extra.id,
    agent: extra.agent,
    title: extra.title,
    startLine: extra.startLine,
    endLine: extra.endLine,
  };
  return {
    ...base,
    ...extra,
    confidence: "likely",
    startLine: extra.startLine,
    endLine: extra.endLine,
  };
}

describe("strict cross-agent merge", () => {
  const correctness = finding({
    id: "correctness",
    agent: "Correctness",
    title: "test_x lost its @pytest.mark.slow marker",
    startLine: 268,
    endLine: 269,
    evidence: "`test_x` dropped `@pytest.mark.slow` and is now `thread_unsafe`.",
  });
  const consistency = finding({
    id: "consistency",
    agent: "Consistency",
    title: "test_x still uses global np.random.seed despite file-wide RandomState migration",
    startLine: 269,
    endLine: 275,
    evidence: "`test_x` still calls `np.random.seed` and stays `thread_unsafe`.",
  });

  it("keeps the current cross-agent merge unless strict mode is set", () => {
    expect(deduplicateAndSortFindings([correctness, consistency], true).findings).toHaveLength(1);
    expect(deduplicateAndSortFindings([correctness, consistency], true, { strictCrossAgent: true }).findings).toHaveLength(2);
  });

  it("still merges near-duplicate titles from different specialists", () => {
    const repeated = finding({
      id: "repeated",
      agent: "Consistency",
      title: "test_x lost its @pytest.mark.slow marker during migration",
      startLine: 268,
      endLine: 269,
      evidence: "The slow marker is gone from test_x.",
    });
    expect(deduplicateAndSortFindings([correctness, repeated], true, { strictCrossAgent: true }).findings).toHaveLength(1);
  });

  it("keeps same-specialist neighboring findings together in both modes", () => {
    const neighbor = finding({
      id: "neighbor",
      agent: "Correctness",
      title: "test_x lost its pytest mark slow marker and timeout",
      startLine: 270,
      endLine: 272,
      evidence: "`test_x` dropped `@pytest.mark.slow` and is now `thread_unsafe` without its timeout.",
    });
    expect(deduplicateAndSortFindings([correctness, neighbor], true).findings).toHaveLength(1);
    expect(deduplicateAndSortFindings([correctness, neighbor], true, { strictCrossAgent: true }).findings).toHaveLength(1);
  });

  it("does not merge the distinct claims again while building the report", () => {
    const report = buildReviewReport({
      jobId: "job_merge",
      repositoryFullName: "owner/repo",
      baseSha: "base",
      headSha: "head",
      summary: "Two distinct claims remain.",
      findings: [correctness, consistency],
      agentRuns: [],
      score: 80,
      riskLevel: "low",
      strictCrossAgentMerge: true,
    });
    expect(report.findings).toHaveLength(2);
    expect(report.duplicates).toBeUndefined();
  });
});
