import { describe, expect, it } from "vitest";
import type { PRReviewContext, ReviewFinding } from "@consistency/schema";
import { hasRepositoryPrecedent } from "../agents/precedent.js";
import { buildAgentPrompt } from "../agents/prompts.js";
import { ReviewWorkload } from "../index.js";
import { cleanupTmpDirs, makeDeterministicStage, makeFixtureRepo, TestModelDriver, TestPersistence } from "./fixtures.js";
import { afterEach } from "vitest";

afterEach(cleanupTmpDirs);

function finding(evidence: string, file = "src/new.ts"): ReviewFinding {
  return {
    id: "consistency-1", agent: "Consistency", title: "New helper diverges from an existing call",
    severity: "medium", confidence: "likely", file, startLine: 1, endLine: 1,
    evidence, reasoning: "The changed call does not follow the cited precedent.",
    recommendation: "Use the existing helper.", trigger: "when the new helper is called",
  };
}

function context(): PRReviewContext {
  return {
    jobId: "lean", source: "local_git", repositoryFullName: "test/example",
    baseSha: "base", headSha: "head", projectMetadata: {}, workspacePath: "unused",
    changedFiles: [{ path: "src/new.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }],
    diff: "", fileContents: {
      "src/new.ts": "export function parse_request() { return handle_request(); }\n",
      "src/old.ts": "export function parse_request() { return input; }\n",
    },
    baseFileContents: { "src/old.ts": "export function parse_request() { return input; }\n" },
  };
}

describe("lean Consistency precedent", () => {
  it("keeps a finding that cites an identifier already used outside the change", () => {
    expect(hasRepositoryPrecedent(finding("Diverges from existing `parse_request` in src/old.ts."), context())).toBe(true);
  });

  it("rejects a finding whose cited identifier exists only in the changed lines", () => {
    expect(hasRepositoryPrecedent(finding("Introduces `brand_new_helper` without a sibling."), context())).toBe(false);
  });

  it("rejects a finding that cites no code identifier", () => {
    expect(hasRepositoryPrecedent(finding("This should be more consistent."), context())).toBe(false);
  });

  it("tells the Consistency specialist to cite an existing precedent", () => {
    const prompt = buildAgentPrompt("Consistency", context(), undefined, [], "en-US").userPrompt;
    expect(prompt).toContain("existing repository precedent");
    expect(prompt).toContain("Consistency");
  });

  it("runs only Correctness and Consistency and does not call the Planner when lean", async () => {
    const repo = makeFixtureRepo();
    const driver = new TestModelDriver({ findingsByAgent: { Correctness: [{
      id: "correctness-1", agent: "Correctness", title: "Changed return drops the parsed request",
      severity: "medium", confidence: "likely", file: "src/index.ts", startLine: 1, endLine: 1,
      evidence: "The changed function returns before using the parsed request.",
      reasoning: "Callers lose the request that the previous return preserved.",
      recommendation: "Return the parsed request.", trigger: "when the changed function runs",
    }] } });
    await new ReviewWorkload({
      context: repo.context, snapshot: repo.snapshot, deterministic: makeDeterministicStage(),
      modelDriver: driver, persistence: new TestPersistence(), reportLanguage: "en-US",
      publicationPolicy: "disabled", accessMode: "local_git", lean: true,
    }).run();
    expect(driver.requests.some(request => request.schemaName === "review-plan")).toBe(false);
    const agents = driver.requests.filter(request => request.schemaName === "findings").map(request => request.agent);
    expect(agents).toEqual(["Correctness", "Consistency"]);
  });
});
