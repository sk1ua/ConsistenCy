import { afterEach, describe, expect, it } from "vitest";
import type { TokenUsage } from "@consistency/schema";
import { ReviewWorkload, type ModelDriver } from "../index.js";
import { cleanupTmpDirs, makeDeterministicStage, makeFixtureRepo, TestModelDriver, TestPersistence } from "./fixtures.js";

afterEach(cleanupTmpDirs);

/**
 * A provider that reports what it already billed together with a transport
 * failure. The retest found such calls vanishing from both the log and the
 * report: paid tokens were dropped with the error.
 */
function paidFailure(message: string, tokenUsage: TokenUsage): Error & { tokenUsage: TokenUsage } {
  const error = new Error(message) as Error & { tokenUsage: TokenUsage };
  error.tokenUsage = tokenUsage;
  return error;
}

function runOptions(repo: ReturnType<typeof makeFixtureRepo>, driver: ModelDriver, persistence: TestPersistence) {
  return {
    snapshot: repo.snapshot,
    context: repo.context,
    modelDriver: driver,
    deterministic: makeDeterministicStage(),
    persistence,
    reportLanguage: "en-US" as const,
    publicationPolicy: "disabled" as const,
    accessMode: "local_git" as const,
  };
}

describe("failed call telemetry", () => {
  it("persists the paid usage of a failed specialist and counts it in promptTokens", async () => {
    const repo = makeFixtureRepo();
    const inner = new TestModelDriver();
    const persistence = new TestPersistence();
    const driver: ModelDriver = {
      provider: inner.provider,
      model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: request => request.agent === "Security"
        ? Promise.reject(paidFailure("security backend offline", { inputTokens: 300, cachedTokens: 100, outputTokens: 7 }))
        : inner.invokeAgentFindings(request),
      invokeSummary: request => inner.invokeSummary(request),
    };

    const result = await new ReviewWorkload(runOptions(repo, driver, persistence)).run();

    const failed = persistence.agentRuns.find(run => run.agentName === "Security");
    expect(failed?.status).toBe("failed");
    expect(failed?.tokenUsage).toEqual({ inputTokens: 300, cachedTokens: 100, outputTokens: 7 });
    expect(result.report.coverage?.failedAgents).toContain("Security");
    // Only the failed Security call reported an input side; the fixture Planner
    // and Synthesizer report totalTokens alone, which carry no prompt split.
    expect(result.report.promptTokens).toBe(400);
    expect(result.report.agentRuns.find(run => run.agentName === "Security")?.tokenUsage)
      .toEqual({ inputTokens: 300, cachedTokens: 100, outputTokens: 7 });
  });

  it("persists the paid usage of a failed planner", async () => {
    const repo = makeFixtureRepo();
    const inner = new TestModelDriver();
    const persistence = new TestPersistence();
    const driver: ModelDriver = {
      provider: inner.provider,
      model: inner.model,
      invokeStructured: request => request.schemaName === "review-plan"
        ? Promise.reject(paidFailure("planner backend offline", { inputTokens: 120, cachedTokens: 30 }))
        : inner.invokeStructured(request),
      invokeAgentFindings: request => inner.invokeAgentFindings(request),
      invokeSummary: request => inner.invokeSummary(request),
    };

    const result = await new ReviewWorkload(runOptions(repo, driver, persistence)).run();

    const planner = persistence.agentRuns.find(run => run.agentName === "Planner");
    expect(planner?.status).toBe("failed");
    expect(planner?.tokenUsage).toEqual({ inputTokens: 120, cachedTokens: 30 });
    expect(result.report.coverage?.plannerFailed).toBe(true);
    expect(result.report.promptTokens).toBe(150);
  });

  it("persists the paid usage of a failed synthesizer", async () => {
    const repo = makeFixtureRepo();
    const inner = new TestModelDriver();
    const persistence = new TestPersistence();
    const driver: ModelDriver = {
      provider: inner.provider,
      model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: request => inner.invokeAgentFindings(request),
      invokeSummary: () => Promise.reject(paidFailure("summary backend offline", { inputTokens: 2000, cachedTokens: 500 })),
    };

    const result = await new ReviewWorkload(runOptions(repo, driver, persistence)).run();

    const synthesizer = persistence.agentRuns.find(run => run.agentName === "Synthesizer");
    expect(synthesizer?.status).toBe("failed");
    expect(synthesizer?.tokenUsage).toEqual({ inputTokens: 2000, cachedTokens: 500 });
    expect(result.report.coverage?.synthesizerFailed).toBe(true);
    expect(result.report.promptTokens).toBe(2500);
  });

  it("omits promptTokens rather than inventing zero when no call reported an input side", async () => {
    const repo = makeFixtureRepo();
    const inner = new TestModelDriver();
    const persistence = new TestPersistence();
    const driver: ModelDriver = {
      provider: inner.provider,
      model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: request => inner.invokeAgentFindings(request),
      invokeSummary: request => inner.invokeSummary(request),
    };

    const result = await new ReviewWorkload(runOptions(repo, driver, persistence)).run();

    expect(persistence.agentRuns.every(run => run.tokenUsage?.inputTokens === undefined)).toBe(true);
    expect(result.report.promptTokens).toBeUndefined();
  });
});
