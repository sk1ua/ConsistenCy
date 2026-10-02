import { afterEach, describe, expect, it } from "vitest";
import { reviewFindingSchema, type PRReviewContext, type ReviewFinding } from "@consistency/schema";
import { hasSpecificChangedCoverageTarget, isMissingCoverageFinding } from "../agents/test-coverage.js";
import { buildAgentPrompt } from "../agents/prompts.js";
import { ReviewWorkload } from "../index.js";
import { cleanupTmpDirs, makeDeterministicStage, makeFixtureRepo, TestModelDriver, TestPersistence } from "./fixtures.js";

afterEach(cleanupTmpDirs);

function context(): PRReviewContext {
  return {
    jobId: "coverage-job", source: "local_git", repositoryFullName: "test/example",
    baseSha: "base", headSha: "head", projectMetadata: {}, baseFileContents: {}, workspacePath: "unused-fixture-workspace",
    changedFiles: [{ path: "packet.py", status: "modified", additions: 1, deletions: 1, changes: 2,
      patch: "@@ -1,4 +1,4 @@\n def decode_packet(payload):\n     if payload is None:\n-        return None\n+        return b''\n     return payload" }],
    diff: "", fileContents: { "packet.py": "def decode_packet(payload):\n    if payload is None:\n        return b''\n    return payload\n\ndef legacy_packet(payload):\n    return payload" },
  };
}

function gap(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return reviewFindingSchema.parse({ id: "coverage-a", agent: "Test", title: "Missing null-input coverage for decode_packet", severity: "medium", confidence: "likely",
    file: "packet.py", startLine: 3, endLine: 3,
    evidence: "The modified `decode_packet` function has no test for null payloads.",
    reasoning: "The new empty-byte return for null input has no regression coverage.",
    recommendation: "Assert decode_packet(None) returns empty bytes.", trigger: "when payload is null", ...overrides });
}

describe("Test missing-coverage gate", () => {
  it("accepts a named, visibly modified function and a specific missing input scenario", () => {
    expect(isMissingCoverageFinding(gap())).toBe(true);
    expect(hasSpecificChangedCoverageTarget(gap(), context())).toBe(true);
  });

  it("accepts an exact changed branch without requiring a function-name citation", () => {
    expect(hasSpecificChangedCoverageTarget(gap({ title: "Untested null branch", startLine: 2, endLine: 2,
      evidence: "The `if payload is None` branch has no test.", reasoning: "Its empty-byte return is newly modified." }), context())).toBe(true);
  });

  it("rejects generic integration-test advice, unknown names and untouched functions", () => {
    expect(hasSpecificChangedCoverageTarget(gap({ title: "Add integration tests", evidence: "Add tests for this module.",
      reasoning: "Improve coverage in the project." }), context())).toBe(false);
    expect(hasSpecificChangedCoverageTarget(gap({ title: "Uncovered ghost", evidence: "No test for `ghost_packet`.",
      reasoning: "The new return needs coverage." }), context())).toBe(false);
    expect(hasSpecificChangedCoverageTarget(gap({ title: "Uncovered legacy_packet", evidence: "No test for `legacy_packet`.",
      reasoning: "This function has no null-input coverage.", startLine: 7, endLine: 7 }), context())).toBe(false);
  });

  it("rejects absent and generic triggering scenarios even for a touched function", () => {
    for (const trigger of [undefined, "any input", "when coverage is missing", "missing tests", "when this function is called", "if users use this code"]) {
      expect(hasSpecificChangedCoverageTarget(gap({ trigger }), context())).toBe(false);
    }
    expect(hasSpecificChangedCoverageTarget(gap({ baselineAssessment: { behaviorUnchanged: true,
      baseStartLine: 3, baseEndLine: 3, reason: "Unchanged behavior." } }), context())).toBe(false);
  });

  it("does not classify an actually failing assertion as a missing-coverage suggestion", () => {
    expect(isMissingCoverageFinding(gap({ title: "Assertion accepts an incorrect sentinel", evidence: "The equality assertion always succeeds.",
      reasoning: "A failed decoder is treated as successful." }))).toBe(false);
  });

  it("persists and reports at most one actionable coverage gap across the PR", async () => {
    const repo = makeFixtureRepo();
    const persistence = new TestPersistence();
    const gaps = ["null input", "zero count", "invalid parameter"].map((scenario, index) => gap({
      id: `coverage-${index}`, file: "src/index.ts", startLine: 1, endLine: 1,
      title: `Untested risky ${scenario}`, evidence: `The changed risky function lacks a test for ${scenario}.`,
      reasoning: `A ${scenario} regression would not be detected.`, trigger: `when invoked with ${scenario}`,
    }));
    const driver = new TestModelDriver({ findingsByAgent: { Test: gaps } });
    const result = await new ReviewWorkload({ snapshot: repo.snapshot, context: repo.context, modelDriver: driver,
      deterministic: makeDeterministicStage(), persistence, reportLanguage: "en-US", publicationPolicy: "disabled", accessMode: "local_git" }).run();
    expect(persistence.agentRuns.find(run => run.agentName === "Test")?.findings).toHaveLength(1);
    expect(result.report.findings.filter(finding => finding.agent === "Test")).toHaveLength(1);
    expect(result.report.preExistingIssues?.filter(finding => finding.agent === "Test") ?? []).toHaveLength(0);
  });

  it("states the mandatory scope, scenario and one-per-PR cap in the Test role tail", () => {
    const prompt = buildAgentPrompt("Test", context(), undefined, [], "en-US").userPrompt;
    expect(prompt).toContain("PR-new or PR-modified function");
    expect(prompt).toContain("explicit input or failure scenario");
    expect(prompt).toContain("ONE missing-coverage finding for the entire PR");
  });
});
