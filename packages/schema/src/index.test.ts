import prReportFixture from "../../../tests/fixtures/pr_report_minimal.json" assert { type: "json" };
import { describe, expect, it } from "vitest";
import {
  agentRunSchema,
  demoReviewReport,
  errorResponseSchema,
  jsonSchemas,
  legacyPRReportSchema,
  parseLegacyPRReport,
  prReviewContextSchema,
  reviewFindingSchema,
  reviewPlanSchema,
  reviewReportSchema,
  riskLevelForScore
} from "./index";

const findingBase = {
  id: "finding-1",
  agent: "Security",
  title: "Unsafe API exposure",
  severity: "high",
  file: "apps/api/src/http.ts",
  evidence: "The route is registered without an authorization guard.",
  reasoning: "Untrusted clients may invoke management operations.",
  recommendation: "Require a bearer token for management routes."
} as const;

describe("@consistency/schema", () => {
  it("keeps the Python JSON contracts available at the compatibility boundary", () => {
    expect(jsonSchemas.prReport.title).toBe("ConsistenCy PR risk report");
    expect(parseLegacyPRReport(prReportFixture).base_ref).toBe("base123");
    expect(() => legacyPRReportSchema.parse({ base_ref: "main" })).toThrow();
  });

  it("enforces evidence requirements for confirmed findings", () => {
    const confirmed = reviewFindingSchema.parse({
      ...findingBase,
      confidence: "confirmed",
      startLine: 94,
      endLine: 100
    });
    expect(confirmed.confidence).toBe("confirmed");
    expect(() => reviewFindingSchema.parse({ ...findingBase, confidence: "confirmed" })).toThrow();
    expect(() => reviewFindingSchema.parse({
      ...findingBase,
      confidence: "confirmed",
      startLine: 100,
      endLine: 94
    })).toThrow();
  });

  it("requires explicit uncertainty for hypotheses", () => {
    const hypothesis = reviewFindingSchema.parse({
      ...findingBase,
      confidence: "hypothesis",
      uncertainty: "Deployment-level authentication was not visible."
    });
    expect(hypothesis.startLine).toBeUndefined();
    expect(() => reviewFindingSchema.parse({ ...findingBase, confidence: "hypothesis" })).toThrow();
  });

  it("parses plans, agent runs, reports, and API errors", () => {
    expect(reviewPlanSchema.parse({
      enabledAgents: ["Security", "Correctness"],
      skippedAgents: ["Style"],
      riskAreas: ["webhook"],
      reason: "The PR changes request handling."
    }).enabledAgents).toHaveLength(2);
    expect(agentRunSchema.parse(demoReviewReport.agentRuns[0]).status).toBe("succeeded");
    expect(reviewReportSchema.parse(demoReviewReport).score).toBe(74);
    expect(errorResponseSchema.parse({ error: { code: "NOT_FOUND", message: "Missing" } }).error.code).toBe("NOT_FOUND");
  });

  it("maps quality scores to risk levels", () => {
    expect(riskLevelForScore(39)).toBe("critical");
    expect(riskLevelForScore(40)).toBe("high");
    expect(riskLevelForScore(60)).toBe("medium");
    expect(riskLevelForScore(80)).toBe("low");
  });

  it("parses PR review contexts used by the TypeScript workflow", () => {
    expect(prReviewContextSchema.parse({
      jobId: "job-1",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 34,
      baseSha: "base123",
      headSha: "head456",
      changedFiles: [{
        path: "apps/api/src/http.ts",
        status: "modified",
        additions: 4,
        deletions: 1,
        changes: 5
      }],
      diff: "diff --git a/apps/api/src/http.ts b/apps/api/src/http.ts",
      fileContents: { "apps/api/src/http.ts": "export {};" },
      projectMetadata: { "package.json": "{}" },
      workspacePath: "C:/workspace/job-1"
    }).changedFiles).toHaveLength(1);
  });
});
