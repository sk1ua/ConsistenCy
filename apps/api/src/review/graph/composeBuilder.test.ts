import { describe, expect, it } from "vitest";
import type { DomainFileResult, ReviewFinding } from "@consistency/schema";
import { buildComposeReviewFileResults } from "./composeBuilder";

describe("buildComposeReviewFileResults", () => {
  it("truncates findings to 500 chars and enforces global max 20 findings quota across all files", () => {
    const deterministicFiles: DomainFileResult[] = Array.from({ length: 5 }, (_, i) => ({
      path: `src/file_${i}.ts`,
      riskScore: Number((0.8 - i * 0.1).toFixed(1)),
      riskLabel: "high",
      riskColor: "RED",
      signals: {},
      findings: [
        `Static finding 1 for file_${i}: ${"A".repeat(800)}`,
        `Static finding 2 for file_${i}: ${"B".repeat(800)}`
      ],
      confidence: 0.9
    }));

    const llmFindings: ReviewFinding[] = Array.from({ length: 15 }, (_, i) => ({
      id: `f_${i}`,
      agent: "Security" as const,
      title: `LLM finding ${i}`,
      severity: "high" as const,
      confidence: "confirmed" as const,
      file: `src/file_${i % 5}.ts`,
      startLine: 1,
      endLine: 1,
      evidence: "evidence",
      reasoning: `Long reasoning ${"C".repeat(800)}`,
      recommendation: "Fix"
    }));

    const results = buildComposeReviewFileResults(deterministicFiles, llmFindings, {
      maxFindingsTotal: 20,
      maxFindingChars: 500
    });

    expect(results).toHaveLength(5);

    const totalFindingsCount = results.reduce((sum, f) => sum + f.findings.length, 0);
    expect(totalFindingsCount).toBe(20);

    for (const fileResult of results) {
      for (const finding of fileResult.findings) {
        expect(finding.length).toBeLessThanOrEqual(500);
      }
    }

    expect(results[0]!.risk_score).toBe(0.8);
    expect(results[4]!.risk_score).toBe(0.4);
  });

  it("preserves risk_score and produces empty findings array for files exceeding global quota", () => {
    const deterministicFiles: DomainFileResult[] = [
      {
        path: "src/heavy.ts",
        riskScore: 0.95,
        riskLabel: "critical",
        riskColor: "RED",
        signals: {},
        findings: Array.from({ length: 25 }, (_, i) => `Heavy static finding ${i}`),
        confidence: 0.95
      },
      {
        path: "src/light.ts",
        riskScore: 0.3,
        riskLabel: "low",
        riskColor: "GREEN",
        signals: {},
        findings: ["Light static finding"],
        confidence: 0.8
      }
    ];

    const results = buildComposeReviewFileResults(deterministicFiles, []);

    expect(results).toHaveLength(2);
    expect(results[0]!.findings).toHaveLength(20);
    expect(results[1]!.findings).toHaveLength(0);
    expect(results[1]!.risk_score).toBe(0.3);
  });
});
