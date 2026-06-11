import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "@consistency/schema";
import { deduplicateAndSortFindings, scoreFindings } from "./reportBuilder";

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
    const findings = deduplicateAndSortFindings([hypothesis, confirmedHigh]);
    expect(findings).toEqual([confirmedHigh]);

    const duplicateLikely: ReviewFinding = {
      ...confirmedHigh,
      id: "finding-likely",
      agent: "Correctness",
      confidence: "likely"
    };
    expect(deduplicateAndSortFindings([duplicateLikely, confirmedHigh])).toEqual([confirmedHigh]);
  });

  it("scores confirmed and likely findings without charging hypotheses", () => {
    expect(scoreFindings([confirmedHigh])).toBe(80);
    expect(scoreFindings([{ ...confirmedHigh, confidence: "likely" }])).toBe(90);
    expect(scoreFindings([{
      ...confirmedHigh,
      confidence: "hypothesis",
      startLine: undefined,
      endLine: undefined,
      uncertainty: "Runtime controls were not visible."
    }])).toBe(100);
  });
});
