/**
 * Step 4 end-to-end: the synthesizer's EXISTING summary call carries the
 * per-finding scores, and the configured floor/caps reach the durable report.
 *
 * The fixture driver double follows the same "no new call" contract the real
 * provider path has: exactly one summary invocation per review run.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { FindingScore, ReviewFinding, TokenUsage } from "@consistency/schema";
import { parseReviewReport } from "@consistency/schema";
import {
  ReviewWorkload,
  type ModelDriver,
  type ReviewWorkloadOptions
} from "../index.js";
import {
  TestModelDriver,
  TestPersistence,
  cleanupTmpDirs,
  makeDeterministicStage,
  makeFixtureRepo,
  securityFinding
} from "./fixtures.js";

afterEach(cleanupTmpDirs);

function rig(
  driver: ModelDriver,
  options: Partial<ReviewWorkloadOptions> = {}
): { workload: ReviewWorkload; persistence: TestPersistence } {
  const repo = makeFixtureRepo();
  const persistence = new TestPersistence();
  return {
    persistence,
    workload: new ReviewWorkload({
      snapshot: repo.snapshot,
      context: repo.context,
      modelDriver: driver,
      deterministic: makeDeterministicStage(),
      persistence,
      reportLanguage: "en-US",
      publicationPolicy: "github_comment",
      accessMode: "github_app",
      ...options
    })
  };
}

/** One scored specialist finding, plus a summary call that returns `score`. */
function driverWithScore(score: number): { driver: ModelDriver; summaryCalls: () => number } {
  const finding: ReviewFinding = { ...securityFinding(), id: "scored-finding", title: "Naming preference in the new helper" };
  const inner = new TestModelDriver({ findingsByAgent: { Security: [finding] } });
  const scores: FindingScore[] = [{ id: finding.id, score, reason: "rubric reason" }];
  const driver: ModelDriver = {
    provider: inner.provider,
    model: inner.model,
    invokeStructured: (request) => inner.invokeStructured(request),
    invokeAgentFindings: (request) => inner.invokeAgentFindings(request),
    invokeSummary: async (request) => {
      const result = await inner.invokeSummary(request);
      return {
        data: { summary: result.data.summary, scores },
        tokenUsage: (result.tokenUsage ?? { totalTokens: 1 }) satisfies TokenUsage
      };
    }
  };
  return { driver, summaryCalls: () => inner.invocations.filter(entry => entry.schemaName === "review-summary").length };
}

describe("synthesis scoring (step 4)", () => {
  it("preserves both missing and skipped baseline labels in the report", async () => {
    const { workload } = rig(new TestModelDriver(), {
      deterministic: makeDeterministicStage({ analyzeFiles: [
        { path: "src/index.ts", riskScore: 0, riskLabel: "skipped", riskColor: "GREY", signals: {}, findings: [], confidence: 0 },
        { path: "other.ts", riskScore: 0, riskLabel: "No Baseline", riskColor: "GREY", signals: {}, findings: [], confidence: 0 }
      ] })
    });
    const result = await workload.run();
    expect(result.report.staticRiskLabel).toContain("skipped");
    expect(result.report.staticRiskLabel).toContain("No Baseline");
  });
  it("sends deduplicated appendix issues for scoring and filters their low scores", async () => {
    const repo = makeFixtureRepo();
    const content = repo.context.fileContents["src/index.ts"]!;
    const appendixFinding: ReviewFinding = { ...securityFinding(), id: "old-issue", confidence: "likely", startLine: 3, endLine: 3, baselineAssessment: { baseStartLine: 3, baseEndLine: 3, behaviorUnchanged: true, reason: "Initializer behavior is unchanged" } };
    const inner = new TestModelDriver({ findingsByAgent: { Security: [appendixFinding] } });
    let scoredIds: string[] = [];
    const driver: ModelDriver = {
      provider: inner.provider, model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: request => inner.invokeAgentFindings(request),
      invokeSummary: async request => {
        const payload = JSON.parse(request.userPrompt) as { preExistingIssues: ReviewFinding[] };
        scoredIds = payload.preExistingIssues.map(f => f.id);
        return { data: { summary: "No new defects", scores: [{ id: "old-issue", score: 2, reason: "Low impact" }] } };
      }
    };
    const context = { ...repo.context, baseFileContents: { "src/index.ts": content }, changedFiles: repo.context.changedFiles.map(f => f.path === "src/index.ts" ? { ...f, patch: "@@ -1 +1 @@\n-old\n+new" } : f) };
    const result = await new ReviewWorkload({ snapshot: repo.snapshot, context, modelDriver: driver, deterministic: makeDeterministicStage(), persistence: new TestPersistence(), reportLanguage: "en-US", publicationPolicy: "github_comment", accessMode: "github_app" }).run();
    expect(scoredIds).toEqual(["old-issue"]);
    expect(result.report.preExistingIssues ?? []).toHaveLength(0);
    expect(result.report.filteredFindingCount).toBe(1);
    expect(result.report.filteredBreakdown?.lowScore).toBe(1);
  });
  it("scores through the single summary call and withholds a finding below the floor", async () => {
    const { driver, summaryCalls } = driverWithScore(1);
    const { workload } = rig(driver);

    const result = await workload.run();

    // The score came back with the one summary call the synthesizer already made.
    expect(summaryCalls()).toBe(1);
    expect(result.report.findings).toHaveLength(0);
    expect(result.report.filteredFindingCount).toBe(1);
    expect(parseReviewReport(JSON.parse(JSON.stringify(result.report)))).toBeTruthy();
  });

  it("keeps a high-scoring finding, attaches its score, and reports nothing filtered", async () => {
    const { driver, summaryCalls } = driverWithScore(9);
    const { workload } = rig(driver);

    const result = await workload.run();

    expect(summaryCalls()).toBe(1);
    expect(result.report.findings.map(entry => entry.id)).toEqual(["scored-finding"]);
    expect(result.report.findings[0]!.score).toBe(9);
    expect(result.report.findings[0]!.scoreReason).toBe("rubric reason");
    expect(result.report.filteredFindingCount).toBeUndefined();
  });

  it("applies the configured floor instead of the default", async () => {
    const { driver } = driverWithScore(4);
    const { workload } = rig(driver, { minFindingScore: 3 });

    const result = await workload.run();

    expect(result.report.findings.map(entry => entry.id)).toEqual(["scored-finding"]);
    expect(result.report.filteredFindingCount).toBeUndefined();
  });
});
