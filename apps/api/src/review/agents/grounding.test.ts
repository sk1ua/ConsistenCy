import { describe, expect, it } from "vitest";
import type { DomainAnalyzeSuccess, PRReviewContext, ReviewFinding } from "@consistency/schema";
import { buildGroundingContext, changedLineRanges, groundFindings } from "./grounding";

const PATCH = [
  "@@ -10,3 +10,5 @@ export function createHttpServer() {",
  "   const app = express();",
  "+  app.post(\"/admin\", handler);",
  "+  app.get(\"/health\", healthHandler);",
  "   return app;"
].join("\n");

const context: PRReviewContext = {
  jobId: "job-1",
  source: "github_pr",
  repositoryFullName: "sk1ua/ConsistenCy",
  pullRequestNumber: 34,
  baseSha: "base123",
  headSha: "head456",
  changedFiles: [
    { path: "apps/api/src/http.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: PATCH },
    { path: "apps/api/src/quiet.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: PATCH }
  ],
  diff: PATCH,
  fileContents: {
    "apps/api/src/http.ts": Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"),
    "apps/api/src/quiet.ts": Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n")
  },
  baseFileContents: {},
  projectMetadata: {},
  workspacePath: "C:/workspace/job-1"
};

const deterministic: DomainAnalyzeSuccess = {
  id: "req-1",
  ok: true,
  files: [
    {
      path: "apps/api/src/http.ts",
      riskScore: 0.6,
      riskLabel: "Moderate",
      riskColor: "ORANGE",
      signals: {},
      findings: ["Unguarded management route"],
      confidence: 0.8
    },
    {
      path: "apps/api/src/quiet.ts",
      riskScore: 0,
      riskLabel: "None",
      riskColor: "GREEN",
      signals: {},
      findings: [],
      confidence: 0.9
    }
  ]
};

const base = {
  id: "finding-1",
  agent: "Security" as const,
  title: "Unguarded management route",
  severity: "high" as const,
  evidence: "The route is registered without an authorization guard.",
  reasoning: "Untrusted clients may invoke management operations.",
  recommendation: "Require a bearer token."
};

function confirmed(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    ...base,
    confidence: "confirmed",
    file: "apps/api/src/http.ts",
    startLine: 11,
    endLine: 12,
    ...overrides
  } as ReviewFinding;
}

const grounding = buildGroundingContext(context, deterministic);

describe("changedLineRanges", () => {
  it("extracts new-side ranges from hunk headers", () => {
    expect(changedLineRanges(PATCH)).toEqual([{ start: 10, end: 14 }]);
  });

  it("handles an omitted length and a missing patch", () => {
    expect(changedLineRanges("@@ -1 +7 @@")).toEqual([{ start: 7, end: 7 }]);
    expect(changedLineRanges(undefined)).toEqual([]);
    expect(changedLineRanges("no hunks here")).toEqual([]);
  });

  it("collects every hunk in a multi-hunk patch", () => {
    const ranges = changedLineRanges("@@ -1,2 +1,2 @@\n@@ -50,1 +60,3 @@");
    expect(ranges).toEqual([{ start: 1, end: 2 }, { start: 60, end: 62 }]);
  });
});

describe("groundFindings", () => {
  it("accepts a confirmed finding anchored in a changed hunk with engine support", () => {
    const result = groundFindings([confirmed()], grounding);

    expect(result.rejected).toHaveLength(0);
    expect(result.downgraded).toHaveLength(0);
    expect(result.findings[0]?.confidence).toBe("confirmed");
  });

  it("rejects a finding about a file outside the change", () => {
    const result = groundFindings([confirmed({ file: "apps/api/src/imaginary.ts" })], grounding);

    expect(result.findings).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/not part of this change/);
  });

  it("rejects a citation past the end of the file", () => {
    const result = groundFindings([confirmed({ startLine: 9_000, endLine: 9_001 })], grounding);

    expect(result.findings).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/which has 40 lines/);
  });

  it("downgrades a confirmed finding anchored outside the changed hunks", () => {
    // Line 2 is real but untouched by this diff, so the claim is not confirmed.
    const result = groundFindings([confirmed({ startLine: 2, endLine: 2 })], grounding);

    expect(result.findings[0]?.confidence).toBe("likely");
    expect(result.downgraded[0]?.reason).toMatch(/outside the changed hunks/);
  });

  it("downgrades a confirmed finding the engine did not corroborate", () => {
    const result = groundFindings(
      [confirmed({ file: "apps/api/src/quiet.ts", startLine: 11, endLine: 11 })],
      grounding
    );

    expect(result.findings[0]?.confidence).toBe("likely");
    expect(result.downgraded[0]?.reason).toMatch(/No deterministic signal/);
  });

  it("preserves every other field when downgrading", () => {
    const original = confirmed({ startLine: 2, endLine: 2, tags: ["auth"] });
    const [downgraded] = groundFindings([original], grounding).findings;

    expect(downgraded).toMatchObject({
      id: original.id,
      title: original.title,
      severity: "high",
      file: "apps/api/src/http.ts",
      startLine: 2,
      endLine: 2,
      tags: ["auth"]
    });
  });

  it("lets likely and hypothesis findings through without corroboration", () => {
    const likely: ReviewFinding = { ...base, confidence: "likely", file: "apps/api/src/quiet.ts" };
    const hypothesis: ReviewFinding = {
      ...base,
      confidence: "hypothesis",
      file: "apps/api/src/quiet.ts",
      uncertainty: "Deployment-level authentication was not visible."
    };

    const result = groundFindings([likely, hypothesis], grounding);
    expect(result.findings).toHaveLength(2);
    expect(result.downgraded).toHaveLength(0);
  });

  it("still rejects an unanchored likely finding", () => {
    const result = groundFindings(
      [{ ...base, confidence: "likely", file: "nope.ts" } as ReviewFinding],
      grounding
    );
    expect(result.findings).toHaveLength(0);
  });

  it("reports a decision for every input finding", () => {
    const findings = [confirmed(), confirmed({ file: "ghost.ts" }), confirmed({ startLine: 2, endLine: 2 })];
    const result = groundFindings(findings, grounding);

    expect(result.decisions).toHaveLength(3);
    expect(result.decisions.map(decision => decision.outcome))
      .toEqual(["accepted", "rejected", "downgraded"]);
  });

  it("treats an absent deterministic result as no corroboration", () => {
    const withoutEngine = buildGroundingContext(context, undefined);
    const result = groundFindings([confirmed()], withoutEngine);

    expect(result.findings[0]?.confidence).toBe("likely");
  });

  it("does not count a zero-risk file with no findings as corroboration", () => {
    const facts = grounding.files.get("apps/api/src/quiet.ts");
    expect(facts?.hasDeterministicSignal).toBe(false);
  });
});
