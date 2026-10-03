/**
 * Step 4 — post-deduplication scoring and filtering.
 *
 * The filter is pure, so these tests pin the three configured bounds (score
 * floor, per-file cap, total cap) without a provider.
 */

import { describe, expect, it } from "vitest";
import type { FindingScore, ReviewFinding } from "@consistency/schema";
import {
  applyFindingScoreFilter,
  DEFAULT_MAX_FINDINGS_PER_FILE,
  DEFAULT_MAX_REPORTED_FINDINGS,
  DEFAULT_MIN_FINDING_SCORE
} from "../index.js";

function finding(overrides: Partial<ReviewFinding> & { id: string }): ReviewFinding {
  return {
    agent: "Security",
    title: `Finding ${overrides.id}`,
    severity: "medium",
    confidence: "likely",
    file: "mycli/commands/run.py",
    startLine: 10,
    endLine: 10,
    evidence: "A concrete input reaches this path.",
    reasoning: "The changed line does not guard it.",
    recommendation: "Guard the input.",
    ...overrides
  } as ReviewFinding;
}

function scoresFor(findings: readonly ReviewFinding[], score: (index: number) => number): FindingScore[] {
  return findings.map((finding, index) => ({ id: finding.id, score: score(index), reason: "rubric reason" }));
}

describe("applyFindingScoreFilter", () => {
  it("withholds findings below the score floor, keeps the score and its reason, and counts what it dropped", () => {
    const findings = [finding({ id: "a" }), finding({ id: "b" }), finding({ id: "c" })];
    const scores: FindingScore[] = [
      { id: "a", score: 9, reason: "concrete failure triggered by the new flag" },
      { id: "b", score: DEFAULT_MIN_FINDING_SCORE - 1, reason: "naming preference" },
      { id: "c", score: DEFAULT_MIN_FINDING_SCORE, reason: "exactly at the floor" }
    ];

    const result = applyFindingScoreFilter(findings, scores);

    expect(result.findings.map(entry => entry.id)).toEqual(["a", "c"]);
    expect(result.filteredCount).toBe(1);
    expect(result.findings[0]!.score).toBe(9);
    expect(result.findings[0]!.scoreReason).toBe("concrete failure triggered by the new flag");
    expect(result.findings[1]!.score).toBe(DEFAULT_MIN_FINDING_SCORE);
  });

  it("never drops a finding the provider left unscored", () => {
    const result = applyFindingScoreFilter(
      [finding({ id: "scored" }), finding({ id: "unscored" })],
      [{ id: "scored", score: 1, reason: "style only" }]
    );

    expect(result.findings.map(entry => entry.id)).toEqual(["unscored"]);
    expect(result.findings[0]!.score).toBeUndefined();
    expect(result.filteredCount).toBe(1);
  });

  it("caps each file at three findings and keeps the highest-scoring ones", () => {
    const findings = [0, 1, 2, 3, 4].map(index =>
      finding({ id: `f-${index}`, startLine: 10 + index, endLine: 10 + index })
    );
    const scores = scoresFor(findings, index => 10 - index);

    const result = applyFindingScoreFilter(findings, scores);

    expect(result.findings.map(entry => entry.id)).toEqual(["f-0", "f-1", "f-2"]);
    expect(result.filteredCount).toBe(2);
    expect(DEFAULT_MAX_FINDINGS_PER_FILE).toBe(3);
  });

  it("caps the main list at the configured total, and both caps can be relaxed", () => {
    const findings = Array.from({ length: 12 }, (_, index) =>
      finding({ id: `g-${index}`, file: `mycli/f${index}.py` })
    );
    const scores = scoresFor(findings, () => 10);

    const capped = applyFindingScoreFilter(findings, scores);
    expect(capped.findings).toHaveLength(DEFAULT_MAX_REPORTED_FINDINGS);
    expect(capped.filteredCount).toBe(12 - DEFAULT_MAX_REPORTED_FINDINGS);

    const relaxed = applyFindingScoreFilter(findings, scores, { maxReported: 12, maxPerFile: 12 });
    expect(relaxed.findings).toHaveLength(12);
    expect(relaxed.filteredCount).toBe(0);
  });

  it("keeps an agreed finding below the floor unless the synthesizer scored it zero", () => {
    const agreed = finding({ id: "agreed", source: "generalist", support: 2, agent: "Generalist" });
    const specialist = finding({ id: "specialist", support: 1, file: "mycli/other.py" });
    const kept = applyFindingScoreFilter(
      [agreed, specialist],
      [{ id: "agreed", score: 3, reason: "reproduced" }, { id: "specialist", score: 4, reason: "below floor" }]
    );
    expect(kept.findings.map(entry => entry.id)).toEqual(["agreed"]);
    expect(kept.breakdown).toMatchObject({ lowScore: 1 });

    const zero = applyFindingScoreFilter(
      [agreed],
      [{ id: "agreed", score: 0, reason: "not a defect" }],
      { recordWithheld: true }
    );
    expect(zero.findings).toEqual([]);
    expect(zero.withheld).toEqual([{ stage: "low-score", finding: expect.objectContaining({ source: "generalist", support: 2, score: 0 }) }]);
  });

  it("still applies per-file and total caps to agreed findings and prefers higher support on a tie", () => {
    const agreed = [0, 1, 2].map(index => finding({
      id: `agreed-${index}`, source: "generalist", support: 2, agent: "Generalist", startLine: 10 + index, endLine: 10 + index,
    }));
    const cappedFile = applyFindingScoreFilter(agreed, scoresFor(agreed, () => 9), { maxPerFile: 2, maxReported: 8 });
    expect(cappedFile.findings.map(entry => entry.id)).toEqual(["agreed-0", "agreed-1"]);
    expect(cappedFile.breakdown).toMatchObject({ capPerFile: 1 });

    const many = Array.from({ length: 4 }, (_, index) => finding({
      id: `total-${index}`, source: "generalist", support: 2, agent: "Generalist", file: `mycli/f${index}.py`,
    }));
    const cappedTotal = applyFindingScoreFilter(many, scoresFor(many, () => 9), { maxReported: 2, maxPerFile: 4 });
    expect(cappedTotal.findings).toHaveLength(2);
    expect(cappedTotal.breakdown).toMatchObject({ capTotal: 2 });

    const tied = [
      finding({ id: "low-support", support: 1 }),
      finding({ id: "high-support", support: 2, file: "mycli/other.py" }),
    ];
    const tie = applyFindingScoreFilter(tied, scoresFor(tied, () => 8), { maxReported: 1, maxPerFile: 4 });
    expect(tie.findings.map(entry => entry.id)).toEqual(["high-support"]);
  });

  it("still bounds the main list when the provider returns no scores at all", () => {
    const findings = Array.from({ length: 10 }, (_, index) =>
      finding({ id: `h-${index}`, file: `mycli/g${index}.py` })
    );

    const result = applyFindingScoreFilter(findings, []);

    expect(result.findings).toHaveLength(DEFAULT_MAX_REPORTED_FINDINGS);
    expect(result.filteredCount).toBe(2);
  });
});
