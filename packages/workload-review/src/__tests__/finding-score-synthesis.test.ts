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
