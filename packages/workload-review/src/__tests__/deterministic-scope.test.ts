/**
 * Step 5 — deterministic findings are scoped to the change.
 */

import { describe, expect, it } from "vitest";
import type { DomainAnalyzeSuccess } from "@consistency/schema";
import {
  DETERMINISTIC_SCOPE_PADDING,
  findingLineReference,
  scopeDeterministicFindings,
  scopeEvidenceInputs,
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
  it("keeps file-scoped signals for changed files without added-line ranges", () => {
    const changedWithoutLines = new Map<string, { start: number; end: number }[]>([
      ["mycli/commands/run.py", []]
    ]);
    const scoped = scopeDeterministicFindings(result([
      "Unanchored security signal on module",
      "[rule] (line 12) outside known changed ranges"
    ]), changedWithoutLines);
    expect(scoped.files[0]!.findings).toEqual(["Unanchored security signal on module"]);
    const inputs = [
      { location: { path: "mycli/commands/run.py" } },
      { location: { path: "mycli/commands/run.py", startLine: 12 } },
      { location: { path: "mycli/untouched.py" } }
    ];
    expect(scopeEvidenceInputs(inputs, changedWithoutLines)).toEqual([inputs[0]]);
  });
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
    const anchored = scopeDeterministicFindings(result(["Unanchored security signal on module"]), changed);
    expect(anchored.files[0]!.findings).toHaveLength(1);

    const untouchedFile = scopeDeterministicFindings(
      result(["Unanchored security signal on module"], "mycli/untouched.py"),
      changed
    );
    expect(untouchedFile.files[0]!.findings).toEqual([]);
  });

  it("scope=all restores the unscoped engine output, but still drops status boilerplate", () => {
    const findings = ["[rule] (line 121) inside the hunk", "[rule] (line 326) far away"];
    const scoped = scopeDeterministicFindings(result(findings), changed, "all");
    expect(scoped.files[0]!.findings).toEqual(findings);

    const withBoilerplate = scopeDeterministicFindings(
      result([...findings, "[GREEN] Consistent (score=0.000)", "Too few functions to detect duplication"]),
      changed,
      "all"
    );
    expect(withBoilerplate.files[0]!.findings).toEqual(findings);
  });

  it("extracts the line reference supporting line N, @LNN, and LNN formats", () => {
    expect(findingLineReference("[rule] (line 42) excerpt")).toBe(42);
    expect(findingLineReference("Line 7: something")).toBe(7);
    expect(findingLineReference("func@L336")).toBe(336);
    expect(findingLineReference("issue at L125 in helper")).toBe(125);
    expect(findingLineReference("[ORANGE] Significant Drift (score=0.702)")).toBeUndefined();
  });

  it("scopes EvidenceInputs (PR-4 style/secret evidence)", () => {
    const inputs = [
      { location: { path: "mycli/commands/run.py", startLine: 122 } },
      { location: { path: "mycli/commands/run.py", startLine: 180 } },
      { location: { path: "mycli/untouched.py", startLine: 10 } },
    ];
    const scoped = scopeEvidenceInputs(inputs, changed, "diff");
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.location.startLine).toBe(122);

    const all = scopeEvidenceInputs(inputs, changed, "all");
    expect(all).toHaveLength(3);
  });
});
