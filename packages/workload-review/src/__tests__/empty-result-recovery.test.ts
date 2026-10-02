import { afterEach, describe, expect, it } from "vitest";
import { asAgentId } from "@consistency/kernel";
import { ReviewWorkload, type ModelDriver, type ReviewWorkloadOptions } from "../index.js";
import { cleanupTmpDirs, makeDeterministicStage, makeFixtureRepo, securityFinding, TestModelDriver, TestPersistence } from "./fixtures.js";

afterEach(cleanupTmpDirs);

function rig(driver = new TestModelDriver()) {
  const repo = makeFixtureRepo();
  const persistence = new TestPersistence();
  const options: ReviewWorkloadOptions = {
    snapshot: repo.snapshot, context: repo.context, modelDriver: driver,
    deterministic: makeDeterministicStage(), persistence,
    reportLanguage: "en-US", publicationPolicy: "disabled", accessMode: "local_git",
  };
  return { driver, options, persistence };
}

describe("empty specialist recovery", () => {
  it("retries Correctness exactly once without baseline snippets, through a fresh admitted ACB", async () => {
    const { driver, options, persistence } = rig();
    const result = await new ReviewWorkload(options).run();
    const calls = driver.requests.filter(request => request.schemaName === "findings");
    expect(calls).toHaveLength(6); // five enabled specialists + one recovery
    const correctness = calls.filter(request => request.agent === "Correctness");
    expect(correctness).toHaveLength(2);
    expect(correctness[0]!.userPrompt).toContain("BASE FILE src/index.ts");
    expect(correctness[1]!.userPrompt).not.toContain("BASE FILE");
    expect(correctness[1]!.userPrompt).toContain("FILE src/index.ts");
    expect(correctness[1]!.userPrompt).toContain("DIFF");
    for (const call of calls) {
      expect(call.userPrompt).not.toContain("omitted code is unknown");
    }
    expect(correctness[0]!.userPrompt).toContain("judge changed behavior using the diff and current file content");
    const recoveryId = asAgentId("review-correctness-retry:job_workload");
    expect(result.scheduler.getAgent(recoveryId)!.state).toBe("SUCCEEDED");
    expect(result.agentCapabilities.get(recoveryId)!.llm).toBeDefined();
    expect(persistence.agentRuns.filter(run => run.agentName === "Correctness")).toHaveLength(2);
    expect(result.report.agentRuns.filter(run => run.agentName === "Correctness")).toHaveLength(2);
  });

  it("grounds and persists a recovered finding rather than dropping the second pass", async () => {
    const { driver, options } = rig();
    let correctnessCalls = 0;
    const recovery: ModelDriver = {
      provider: driver.provider, model: driver.model,
      invokeStructured: request => driver.invokeStructured(request),
      invokeSummary: request => driver.invokeSummary(request),
      invokeAgentFindings: request => {
        if (request.agent === "Correctness" && ++correctnessCalls === 2) {
          return Promise.resolve({ data: [{ ...securityFinding(), agent: "Correctness" }] });
        }
        return driver.invokeAgentFindings(request);
      },
    };
    const result = await new ReviewWorkload({ ...options, modelDriver: recovery }).run();
    expect(correctnessCalls).toBe(2);
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]!.evidenceIds!.length).toBeGreaterThan(0);
  });

  it("does not retry a nonempty response even when grounding rejects it", async () => {
    const { driver, options } = rig(new TestModelDriver({ findingsByAgent: {
      Security: [{ ...securityFinding(), file: "not-changed.ts" }],
    } }));
    await new ReviewWorkload(options).run();
    expect(driver.requests.filter(request => request.agent === "Correctness")).toHaveLength(1);
  });

  it("does not turn failed calls or a fully skipped plan into empty-result recovery", async () => {
    for (const driver of [new TestModelDriver({ failAgents: ["Security"] }), new TestModelDriver({
      plan: { enabledAgents: [], skippedAgents: ["Security", "Correctness", "Maintainability", "Test", "Style", "ArchitectureAuditor"], riskAreas: [], reason: "No review scopes", focusAreas: [] },
    })]) {
      const { options } = rig(driver);
      await new ReviewWorkload(options).run();
      expect(driver.requests.filter(request => request.agent === "Correctness").length).toBeLessThanOrEqual(1);
    }
  });

  it("does not retry documentation-only or comment-only diffs", async () => {
    for (const [path, patch] of [["README.md", "@@ -1 +1 @@\n-old\n+new"], ["src/index.ts", "@@ -1 +1 @@\n-// old\n+// new"]]) {
      const { driver, options } = rig();
      await new ReviewWorkload({ ...options, context: { ...options.context,
        changedFiles: [{ path: path!, status: "modified", additions: 1, deletions: 1, changes: 2, patch }],
        diff: `diff --git a/${path} b/${path}\n${patch}`, fileContents: { [path!]: "new" }, baseFileContents: { [path!]: "old" },
      } }).run();
      expect(driver.requests.filter(request => request.agent === "Correctness")).toHaveLength(1);
    }
  });
});
