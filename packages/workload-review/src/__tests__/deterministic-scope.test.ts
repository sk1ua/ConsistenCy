/**
 * Step 5 — deterministic findings are scoped to the change.
 */

import { describe, expect, it } from "vitest";
import type { DomainAnalyzeSuccess } from "@consistency/schema";
import {
  DETERMINISTIC_SCOPE_PADDING,
  findingLineReference,
  scopeDeterministicFindings
} from "../index.js";

function result(findings: string[], path = "mycli/commands/run.py"): DomainAnalyzeSuccess {
  return {
    id: "req_1",
    ok: true,
    files: [{
      path,
      riskScore: 0.7,
      riskLabel: "Moderate Drift",
      riskColor: "ORANGE",
      signals: {},
      findings,
      confidence: 0.9
    }]
  };
}

const changed = new Map([["mycli/commands/run.py", [{ start: 120, end: 126 }]]]);

describe("scopeDeterministicFindings", () => {
  it("keeps findings anchored within five lines of the change and drops the rest", () => {
    const scoped = scopeDeterministicFindings(result([
      "[rule] (line 121) inside the hunk",
      `[rule] (line ${126 + DETERMINISTIC_SCOPE_PADDING}) at the padding edge`,
      `[rule] (line ${126 + DETERMINISTIC_SCOPE_PADDING + 1}) one line past the edge`,
      "[rule] (line 326) far away in the same file"
    ]), changed);

    expect(scoped.files[0]!.findings).toEqual([
      "[rule] (line 121) inside the hunk",
      `[rule] (line ${126 + DETERMINISTIC_SCOPE_PADDING}) at the padding edge`
    ]);
    // The risk score is what the engine measured; scoping bounds reporting only.
    expect(scoped.files[0]!.riskScore).toBe(0.7);
  });

  it("keeps an unanchored finding only for a file that is part of the change", () => {
    const anchored = scopeDeterministicFindings(result(["[ORANGE] Significant Drift (score=0.702)"]), changed);
    expect(anchored.files[0]!.findings).toHaveLength(1);

    const untouchedFile = scopeDeterministicFindings(
      result(["[ORANGE] Significant Drift (score=0.702)"], "mycli/untouched.py"),
      changed
    );
    expect(untouchedFile.files[0]!.findings).toEqual([]);
  });

  it("scope=all restores the unscoped engine output", () => {
    const findings = ["[rule] (line 121) inside the hunk", "[rule] (line 326) far away"];
    const scoped = scopeDeterministicFindings(result(findings), changed, "all");
    expect(scoped.files[0]!.findings).toEqual(findings);
  });

  it("extracts the first line reference only when one is present", () => {
    expect(findingLineReference("[rule] (line 42) excerpt")).toBe(42);
    expect(findingLineReference("Line 7: something")).toBe(7);
    expect(findingLineReference("[ORANGE] Significant Drift (score=0.702)")).toBeUndefined();
  });
});
