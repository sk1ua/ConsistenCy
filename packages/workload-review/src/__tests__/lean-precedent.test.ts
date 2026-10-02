import { afterEach, describe, expect, it } from "vitest";
import type { PRReviewContext, ReviewFinding } from "@consistency/schema";
import { verifyPrecedent } from "../agents/precedent.js";
import { buildAgentPrompt } from "../agents/prompts.js";
import { applyFindingScoreFilter } from "../synthesis/finding-score.js";
import { ReviewWorkload } from "../index.js";
import { cleanupTmpDirs, makeDeterministicStage, makeFixtureRepo, TestModelDriver, TestPersistence } from "./fixtures.js";

afterEach(cleanupTmpDirs);

const SIBLING = "export function sibling() { return input; }";

function finding(extra: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: extra.id ?? "consistency-1",
    agent: "Consistency",
    title: extra.title ?? "New helper diverges from an existing call",
    severity: "medium",
    confidence: "likely",
    file: extra.file ?? "src/new.ts",
    startLine: extra.startLine ?? 1,
    endLine: extra.endLine ?? 1,
    evidence: extra.evidence ?? "The changed helper does not follow the cited call.",
    reasoning: extra.reasoning ?? "The changed call does not follow the cited precedent.",
    recommendation: extra.recommendation ?? "Use the existing helper.",
    trigger: extra.trigger ?? "when the new helper is called",
    tags: extra.tags,
    precedent: extra.precedent,
  };
}

function context(extra: Partial<PRReviewContext> = {}): PRReviewContext {
  return {
    jobId: "lean", source: "local_git", repositoryFullName: "test/example",
    baseSha: "base", headSha: "head", projectMetadata: {}, workspacePath: "unused",
    changedFiles: [{ path: "src/new.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }],
    diff: "",
    fileContents: {
      "src/new.ts": "export function changed() { return 1; }\nexport function sibling() { return input; }\n",
      "src/old.ts": `${SIBLING}\n`,
    },
    baseFileContents: { "src/base.ts": `${SIBLING}\n` },
    ...extra,
  };
}

describe("lean Consistency precedent", () => {
  it("verifies a quote in the same file, another changed file, or base content", () => {
    const sameFile = verifyPrecedent(finding({
      precedent: { file: "src/new.ts", line: 2, quote: "export function sibling()" },
    }), context());
    const otherFile = verifyPrecedent(finding({
      precedent: { file: "src/old.ts", line: 1, quote: SIBLING },
    }), context());
    const baseline = verifyPrecedent(finding({
      precedent: { file: "src/base.ts", line: 1, quote: "  export   function sibling() { return input; }  " },
    }), context());
    expect([sameFile, otherFile, baseline]).toEqual(["verified", "verified", "verified"]);
  });

  it("rejects a missing citation, a short quote, a distant line, and the criticized lines", () => {
    const lines = context();
    expect(verifyPrecedent(finding(), lines)).toBe("missing");
    expect(verifyPrecedent(finding({
      precedent: { file: "src/old.ts", line: 1, quote: "return;" },
    }), lines)).toBe("unverified");
    expect(verifyPrecedent(finding({
      precedent: { file: "src/old.ts", line: 1, quote: "export function missing()" },
    }), lines)).toBe("unverified");
    expect(verifyPrecedent(finding({
      precedent: { file: "src/old.ts", line: 4, quote: SIBLING },
    }), lines)).toBe("unverified");
    expect(verifyPrecedent(finding({
      startLine: 1, endLine: 2,
      precedent: { file: "src/new.ts", line: 1, quote: "export function changed()" },
    }), lines)).toBe("unverified");
  });

  it("verifies a quote in a CRLF file", () => {
    const crlf = context({
      fileContents: { "src/old.ts": `${SIBLING}\r\nexport function tail() { return 0; }\r\n` },
    });
    expect(verifyPrecedent(finding({
      precedent: { file: "src/old.ts", line: 1, quote: SIBLING },
    }), crlf)).toBe("verified");
  });

  it("keeps the default Consistency prompt byte-for-byte unless lean asks for a citation", () => {
    const plain = buildAgentPrompt("Consistency", context(), undefined, [], "en-US");
    const explicit = buildAgentPrompt("Consistency", context(), undefined, [], "en-US", undefined, undefined, 3, false, false);
    expect(explicit.userPrompt).toBe(plain.userPrompt);
    expect(plain.userPrompt).toContain("existing repository precedent");
    expect(plain.userPrompt).not.toContain("Every finding MUST cite a precedent");
    const cited = buildAgentPrompt("Consistency", context(), undefined, [], "en-US", undefined, undefined, 3, false, true);
    expect(cited.systemPrompt).toContain("Every finding MUST cite a precedent: set `precedent` to {\"file\", \"line\", \"quote\"}");
    expect(cited.userPrompt).not.toContain("Every finding MUST cite a precedent");
  });

  it("caps an unverified Consistency score at 3 only for the v2 rubric", () => {
    const unverified = finding({ id: "loose", tags: ["note"] });
    const verified = finding({ id: "tight", tags: ["precedent:verified"] });
    const scores = [
      { id: "loose", score: 9, reason: "Looks like a convention break." },
      { id: "tight", score: 9, reason: "The cited precedent verifies." },
    ];
    expect(applyFindingScoreFilter([unverified], scores).findings[0]?.score).toBe(9);
    const capped = applyFindingScoreFilter([unverified, verified], scores, { capUnverifiedConsistency: true, minScore: 5 });
    expect(capped.findings.map(item => item.id)).toEqual(["tight"]);
  });

  it("keeps only a verifiable Consistency finding and tags it", async () => {
    const repo = makeFixtureRepo();
    const verified = finding({
      id: "verified", file: "src/index.ts", startLine: 1, endLine: 1, tags: ["convention"],
      precedent: { file: "src/index.ts", line: 3, quote: "export const fine = 1;" },
    });
    const unverified = finding({ id: "unverified", file: "src/index.ts", startLine: 1, endLine: 1 });
    const driver = new TestModelDriver({ findingsByAgent: {
      Correctness: [{
        id: "correctness-1", agent: "Correctness", title: "Changed return drops the parsed request",
        severity: "medium", confidence: "likely", file: "src/index.ts", startLine: 2, endLine: 2,
        evidence: "The changed function returns before using the parsed request.",
        reasoning: "Callers lose the request that the previous return preserved.",
        recommendation: "Return the parsed request.", trigger: "when the changed function runs",
      }],
      Consistency: [verified, unverified],
    } });
    const persistence = new TestPersistence();
    const result = await new ReviewWorkload({
      context: repo.context, snapshot: repo.snapshot, deterministic: makeDeterministicStage(),
      modelDriver: driver, persistence, reportLanguage: "en-US",
      publicationPolicy: "disabled", accessMode: "local_git", lean: true,
    }).run();
    const consistency = result.report.findings.filter(item => item.agent === "Consistency");
    expect(consistency.map(item => item.id)).toEqual(["verified"]);
    expect(consistency[0]?.tags).toEqual(["convention", "precedent:verified"]);
    expect(persistence.agentRuns.find(run => run.agentName === "Consistency")?.inputSummary)
      .toContain("1 finding(s) rejected: unverifiable precedent");
    expect(driver.requests.find(request => request.agent === "Consistency")?.systemPrompt)
      .toContain("Every finding MUST cite a precedent");
    expect(driver.requests.find(request => request.agent === "Consistency")?.systemPrompt)
      .not.toContain("An empty findings list is welcome");
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
