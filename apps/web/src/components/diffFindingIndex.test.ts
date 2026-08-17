import type { ReviewFinding } from "@consistency/schema";
import { describe, expect, it } from "vitest";
import { buildFindingIndex, findingsForFile, findingsForLine } from "./diffFindingIndex";

function finding(id: string, file: string, startLine?: number, endLine?: number): ReviewFinding {
  const base = {
    id,
    agent: "Security",
    title: id,
    severity: "high",
    file,
    evidence: "Evidence",
    reasoning: "Reasoning",
    recommendation: "Recommendation"
  } as const;
  return startLine === undefined
    ? { ...base, confidence: "hypothesis", uncertainty: "File-level lead" }
    : { ...base, confidence: "confirmed", startLine, endLine: endLine ?? startLine };
}

describe("diff finding index", () => {
  it("indexes file and line ranges once for direct lookup", () => {
    const first = finding("first", "src/a.ts", 10, 12);
    const second = finding("second", "src/a.ts", 12, 12);
    const fileLevel = finding("file", "src/a.ts");
    const index = buildFindingIndex([first, second, fileLevel]);

    expect(findingsForFile(index, "src/a.ts")).toEqual([first, second, fileLevel]);
    expect(findingsForLine(index, "src/a.ts", 11)).toEqual([first]);
    expect(findingsForLine(index, "src/a.ts", 12)).toEqual([first, second]);
    expect(findingsForLine(index, "src/other.ts", 12)).toEqual([]);
  });

  it("keeps pathological ranges bounded while preserving lookup behavior", () => {
    const wide = finding("wide", "src/large.ts", 1, 6_010);
    const index = buildFindingIndex([wide]);

    expect(index.byLine.get("src/large.ts")).toBeUndefined();
    expect(findingsForLine(index, "src/large.ts", 6_000)).toEqual([wide]);
    expect(findingsForLine(index, "src/large.ts", 6_100)).toEqual([]);
  });
});
