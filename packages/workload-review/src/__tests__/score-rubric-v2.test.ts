import { afterEach, describe, expect, it } from "vitest";
import type { ReviewFinding } from "@consistency/schema";
import { isGenericCoverageFinding } from "../agents/test-coverage.js";
import {
  applyFindingScoreFilter,
  FINDING_SCORE_INSTRUCTION,
  FINDING_SCORE_INSTRUCTION_V2,
  numberedChangedLines,
} from "../synthesis/finding-score.js";
import { ReviewWorkload } from "../index.js";
import { cleanupTmpDirs, makeDeterministicStage, makeFixtureRepo, TestModelDriver, TestPersistence } from "./fixtures.js";

afterEach(cleanupTmpDirs);

function finding(id: string, extra: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id, agent: "Test", title: extra.title ?? "Add tests", severity: "low", confidence: "likely",
    file: "src/index.ts", startLine: 1, endLine: 1,
    evidence: extra.evidence ?? "Add tests for this module.", reasoning: extra.reasoning ?? "Coverage would be higher.",
    recommendation: extra.recommendation ?? "Add a test.", trigger: extra.trigger,
  };
}

describe("v2 scoring rubric", () => {
  it("keeps the default instruction free of the v2 rules", () => {
    expect(FINDING_SCORE_INSTRUCTION).not.toContain("numbered changed-code");
    expect(FINDING_SCORE_INSTRUCTION_V2).toContain("existing repository convention");
    expect(FINDING_SCORE_INSTRUCTION_V2).toContain("at most 4");
  });

  it("numbers only changed lines and keeps an added file whole", () => {
    const numbered = numberedChangedLines([
      { path: "src/app.py", status: "modified", patch: "@@ -2,1 +2,1 @@\n-old\n+return None\n" },
      { path: "src/new.py", status: "added" },
    ], {
      "src/app.py": "def run():\n    return None\n    untouched()\n",
      "src/new.py": "def added():\n    return 1\n",
    });
    expect(numbered).toContain("FILE src/app.py\n2:     return None");
    expect(numbered).not.toContain("untouched");
    expect(numbered).toContain("1: def added():\n2:     return 1");
  });

  it("raises the per-file cap only when the caller sets 4", () => {
    const findings = [1, 2, 3, 4].map(index => finding(`f${index}`, { title: `Defect ${index}`, evidence: "The changed branch returns the wrong value." }));
    expect(applyFindingScoreFilter(findings, [], { maxPerFile: 3 }).findings).toHaveLength(3);
    expect(applyFindingScoreFilter(findings, [], { maxPerFile: 4 }).findings).toHaveLength(4);
  });

  it("recognizes a generic coverage suggestion and keeps a specific scenario", () => {
    expect(isGenericCoverageFinding(finding("generic"))).toBe(true);
    expect(isGenericCoverageFinding(finding("specific", {
      title: "Missing null coverage for decode_packet",
      evidence: "The changed `decode_packet` has no test.",
      trigger: "when payload is null",
    }))).toBe(false);
  });

  it("omits numbered changed code unless the v2 rubric is enabled", async () => {
    const repo = makeFixtureRepo();
    const plain = new TestModelDriver();
    await new ReviewWorkload({
      context: repo.context, snapshot: repo.snapshot, deterministic: makeDeterministicStage(),
      modelDriver: plain, persistence: new TestPersistence(), reportLanguage: "en-US",
      publicationPolicy: "disabled", accessMode: "local_git",
    }).run();
    const plainSummary = plain.requests.find(request => request.schemaName === "review-summary")?.userPrompt ?? "";
    expect(plainSummary).not.toContain("changedCode");

    const v2 = new TestModelDriver();
    await new ReviewWorkload({
      context: repo.context, snapshot: repo.snapshot, deterministic: makeDeterministicStage(),
      modelDriver: v2, persistence: new TestPersistence(), reportLanguage: "en-US",
      publicationPolicy: "disabled", accessMode: "local_git", scoreRubricV2: true,
    }).run();
    const v2Request = v2.requests.find(request => request.schemaName === "review-summary");
    expect(v2Request?.userPrompt).toContain("changedCode");
    expect(v2Request?.systemPrompt).toContain("existing repository convention");
  });
});
