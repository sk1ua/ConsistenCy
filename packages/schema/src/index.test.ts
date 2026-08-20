import { describe, expect, it } from "vitest";
import {
  agentRunSchema,
  errorResponseSchema,
  prReviewContextSchema,
  reviewFindingSchema,
  reviewPlanSchema,
  reviewReportSchema,
  riskLevelForScore
} from "./index";

const sampleReport = {
  jobId: "job-sample-1",
  repositoryFullName: "sk1ua/ConsistenCy",
  pullRequestNumber: 34,
  baseSha: "8b3fabb",
  headSha: "2894e50",
  summary: "Sample review report.",
  score: 74,
  riskLevel: "medium" as const,
  agentRuns: [
    {
      id: "run-security-1",
      jobId: "job-sample-1",
      agentName: "Security",
      status: "succeeded" as const,
      startedAt: "2026-06-10T15:00:00.000Z",
      finishedAt: "2026-06-10T15:00:01.000Z",
      inputSummary: "Reviewed API changes.",
      findings: [
        {
          id: "finding-1",
          agent: "Security",
          title: "API auth check",
          severity: "medium" as const,
          confidence: "hypothesis" as const,
          file: "apps/api/src/http.ts",
          evidence: "No guard in excerpt.",
          reasoning: "Management routes need token.",
          recommendation: "Add bearer token.",
          uncertainty: "Proxy config not visible.",
          tags: ["api", "auth"]
        }
      ]
    }
  ],
  findings: [
    {
      id: "finding-1",
      agent: "Security",
      title: "API auth check",
      severity: "medium" as const,
      confidence: "hypothesis" as const,
      file: "apps/api/src/http.ts",
      evidence: "No guard in excerpt.",
      reasoning: "Management routes need token.",
      recommendation: "Add bearer token.",
      uncertainty: "Proxy config not visible.",
      tags: ["api", "auth"]
    }
  ],
  createdAt: "2026-06-10T15:00:02.000Z"
};

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
    expect(agentRunSchema.parse(sampleReport.agentRuns[0]).status).toBe("succeeded");
    expect(reviewReportSchema.parse(sampleReport).score).toBe(74);
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
      baseFileContents: { "apps/api/src/http.ts": "" },
      projectMetadata: { "package.json": "{}" },
      workspacePath: "C:/workspace/job-1"
    }).changedFiles).toHaveLength(1);
  });
});
