import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewFinding, TokenUsage } from "@consistency/schema";
import { ReviewWorkload, type ModelDriver, type ReviewWorkloadOptions } from "../index.js";
import {
  agreeFindings,
  buildGeneralistPrompt,
  generalistJaccard,
  parseGeneralistFindings,
  runGeneralistAgreement,
  type GeneralistRawFinding,
} from "../agents/generalist.js";
import {
  cleanupTmpDirs, makeDeterministicStage, makeFixtureRepo, TestModelDriver, TestPersistence,
  type FixtureRepo,
} from "./fixtures.js";

afterEach(cleanupTmpDirs);

function raw(partial: Partial<GeneralistRawFinding> & Pick<GeneralistRawFinding, "file" | "title">): GeneralistRawFinding {
  return { message: "Change this before merging.", ...partial };
}

function workload(repo: FixtureRepo, driver: ModelDriver, extra: Partial<ReviewWorkloadOptions> = {}): ReviewWorkloadOptions {
  return {
    context: repo.context, snapshot: repo.snapshot, deterministic: makeDeterministicStage(),
    modelDriver: driver, persistence: new TestPersistence(), reportLanguage: "en-US",
    publicationPolicy: "disabled", accessMode: "local_git", lean: true, leanReviewer: true, ...extra,
  };
}

describe("agreeFindings", () => {
  const first = raw({ file: "src/index.ts", title: "Missing guard", line_start: 10, line_end: 12 });

  it("agrees on an overlapping range and a range exactly three lines away", () => {
    const overlap = raw({ file: "src/index.ts", title: "Different wording", line_start: 12, line_end: 14 });
    const boundary = raw({ file: "src/index.ts", title: "Boundary", line_start: 15, line_end: 15 });
    expect(agreeFindings([first], [overlap]).map(item => item.id)).toEqual(["generalist-1"]);
    expect(agreeFindings([first], [boundary])).toHaveLength(1);
    expect(agreeFindings([first], [raw({ file: "src/index.ts", title: "Too far", line_start: 16, line_end: 16 })])).toEqual([]);
  });

  it("does not agree across files or when either finding lacks line numbers", () => {
    expect(agreeFindings([first], [raw({ file: "src/other.ts", title: "Same place", line_start: 10, line_end: 12 })])).toEqual([]);
    expect(agreeFindings([first], [raw({ file: "src/index.ts", title: "No lines" })])).toEqual([]);
    expect(agreeFindings([raw({ file: "src/index.ts", title: "No lines" })], [first])).toEqual([]);
  });

  it("matches each second finding at most once, in first-sample order", () => {
    const shared = raw({ file: "src/index.ts", title: "Shared", line_start: 10, line_end: 12 });
    const agreed = agreeFindings([first, raw({ file: "src/index.ts", title: "Also nearby", line_start: 11, line_end: 11 })], [shared]);
    expect(agreed.map(item => item.title)).toEqual(["Missing guard"]);
    expect(agreed[0]).toMatchObject({ agent: "Generalist", source: "generalist", support: 2, startLine: 10, endLine: 12 });
  });

  it("can switch to title-token agreement without exposing an env switch", () => {
    const titled = raw({ file: "src/index.ts", title: "missing public guard", line_start: 40, line_end: 40 });
    const match = raw({ file: "src/index.ts", title: "Missing guard", line_start: 90, line_end: 90 });
    expect(agreeFindings([titled], [match], "title")).toHaveLength(1);
    expect(agreeFindings([titled], [match], "range")).toEqual([]);
  });
});

describe("generalist sampling", () => {
  it("computes jaccard from the agreed count", () => {
    expect(generalistJaccard(5, 6, 3)).toBeCloseTo(3 / 8);
    expect(generalistJaccard(0, 0, 0)).toBe(0);
  });

  it("truncates the user message the same way specialist diff sections do", () => {
    const prompt = buildGeneralistPrompt(`${"x".repeat(80_010)}`);
    expect(prompt.userPrompt.startsWith("DIFF\n")).toBe(true);
    expect(prompt.userPrompt.length).toBe("DIFF\n".length + 80_000);
  });

  it("returns no findings and a failure summary when either call fails", async () => {
    let calls = 0;
    const result = await runGeneralistAgreement("diff", () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({ content: JSON.stringify({ findings: [raw({ file: "a.ts", title: "Kept", line_start: 1, line_end: 1 })] }) })
        : Promise.reject(new Error("transport failed"));
    });
    expect(result.findings).toEqual([]);
    expect(result.summary).toBe("generalist sample failed");
    expect(result.failed).toBe(true);
  });

  it("treats an unparseable sample as a failed sample", async () => {
    const result = await runGeneralistAgreement("diff", () => Promise.resolve({ content: "not json" }));
    expect(result.findings).toEqual([]);
    expect(result.summary).toBe("generalist sample failed");
  });

  it("sends two byte-identical requests and keeps only the agreed finding", async () => {
    const requests: Array<{ systemPrompt: string; userPrompt: string }> = [];
    const a = { findings: [raw({ file: "src/index.ts", title: "Missing guard", line_start: 2, line_end: 2 })] };
    const b = { findings: [
      raw({ file: "src/index.ts", title: "Other wording", line_start: 3, line_end: 3 }),
      raw({ file: "src/index.ts", title: "Unmatched", line_start: 40, line_end: 40 }),
    ] };
    let calls = 0;
    const result = await runGeneralistAgreement("diff --git a/src/index.ts b/src/index.ts", request => {
      requests.push(request);
      calls += 1;
      return Promise.resolve({ content: JSON.stringify(calls === 1 ? a : b), tokenUsage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } satisfies TokenUsage });
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(result.findings).toHaveLength(1);
    expect(result.summary).toBe("generalist: a=1 b=2 agreed=1 J=0.50");
    expect(parseGeneralistFindings("```json\n{\"findings\":[]}\n```")).toEqual([]);
  });
});

describe("lean generalist workload", () => {
  it("adds exactly two generalist calls and reports the agreed finding", async () => {
    const repo = makeFixtureRepo();
    const inner = new TestModelDriver({
      findingsByAgent: { Correctness: [], Consistency: [], Maintainability: [] },
      generalist: { content: JSON.stringify({ findings: [raw({ file: "src/index.ts", title: "Missing guard", line_start: 1, line_end: 1 })] }) },
    });
    const driver: ModelDriver = {
      provider: inner.provider,
      model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: request => inner.invokeAgentFindings(request),
      invokeSummary: request => inner.invokeSummary(request),
      invokeRaw: request => inner.invokeRaw!(request),
    };
    const persistence = new TestPersistence();
    const result = await new ReviewWorkload(workload(repo, driver, { leanGeneralist: true, persistence })).run();
    const generalistRequests = inner.requests.filter(request => request.schemaName === "generalist-findings");
    expect(generalistRequests).toHaveLength(2);
    expect(generalistRequests[0]?.systemPrompt).toBe(generalistRequests[1]?.systemPrompt);
    expect(generalistRequests[0]?.userPrompt).toBe(generalistRequests[1]?.userPrompt);
    const reported = result.report.findings.find(item => item.agent === "Generalist");
    expect(reported).toMatchObject({ source: "generalist", support: 2, file: "src/index.ts" });
    expect(persistence.agentRuns.find(run => run.agentName === "Generalist")?.inputSummary).toContain("J=1.00");
    expect(result.report.coverage?.outcome).toBe("complete");
  });

  it("does not degrade the run when the generalist sample fails", async () => {
    const repo = makeFixtureRepo();
    const inner = new TestModelDriver({ generalist: { fail: true } });
    const driver: ModelDriver = {
      provider: inner.provider, model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: request => inner.invokeAgentFindings(request),
      invokeSummary: request => inner.invokeSummary(request),
      invokeRaw: request => inner.invokeRaw!(request),
    };
    const result = await new ReviewWorkload(workload(repo, driver, { leanGeneralist: true })).run();
    expect(result.report.findings.filter(item => item.agent === "Generalist")).toEqual([]);
    expect(result.report.coverage?.outcome).toBe("complete");
    expect(result.report.agentRuns.find(run => run.agentName === "Generalist")?.inputSummary).toContain("generalist sample failed");
  });

  it("keeps the specialist finding and records the higher support when they overlap", async () => {
    const repo = makeFixtureRepo();
    const specialist = {
      id: "specialist-1",
      agent: "Correctness" as const,
      title: "Changed return loses the request",
      severity: "high" as const,
      confidence: "likely" as const,
      file: "src/index.ts",
      startLine: 1,
      endLine: 1,
      evidence: "The changed function returns without the parsed request.",
      reasoning: "Callers cannot retrieve the request that was previously returned.",
      recommendation: "Return the parsed request.",
      trigger: "when the caller parses a request",
    };
    const inner = new TestModelDriver({
      findingsByAgent: { Correctness: [specialist] },
      generalist: { content: JSON.stringify({ findings: [raw({ file: "src/index.ts", title: "Missing guard", line_start: 1, line_end: 1 })] }) },
    });
    const driver: ModelDriver = {
      provider: inner.provider, model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: request => inner.invokeAgentFindings(request),
      invokeSummary: request => inner.invokeSummary(request),
      invokeRaw: request => inner.invokeRaw!(request),
    };
    const result = await new ReviewWorkload(workload(repo, driver, { leanGeneralist: true })).run();
    const kept = result.report.findings.filter(item => item.file === "src/index.ts" && item.startLine === 1);
    expect(kept.map(item => item.agent)).toEqual(["Correctness"]);
    expect(kept[0]?.support).toBe(2);
    expect(kept[0]?.source).toBeUndefined();
  });

  it("does not call the generalist outside lean mode", async () => {
    const repo = makeFixtureRepo();
    const inner = new TestModelDriver({ generalist: { content: "{\"findings\":[]}" } });
    const driver: ModelDriver = {
      provider: inner.provider, model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: request => inner.invokeAgentFindings(request),
      invokeSummary: request => inner.invokeSummary(request),
      invokeRaw: request => inner.invokeRaw!(request),
    };
    await new ReviewWorkload(workload(repo, driver, { lean: false, leanGeneralist: true })).run();
    expect(inner.requests.filter(request => request.schemaName === "generalist-findings")).toEqual([]);
  });

  it("warns and ignores second-sample union when vote is also set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo = makeFixtureRepo();
    let calls = 0;
    const inner = new TestModelDriver();
    const driver: ModelDriver = {
      provider: inner.provider, model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: async request => {
        calls += 1;
        return inner.invokeAgentFindings(request);
      },
      invokeSummary: request => inner.invokeSummary(request),
    };
    await new ReviewWorkload(workload(repo, driver, {
      lean: true,
      leanReviewer: true,
      leanVote: true,
      leanSecondSample: ["Maintainability"],
    })).run();
    expect(warn).toHaveBeenCalledOnce();
    expect(inner.requests.filter(request => request.schemaName === "findings")).toHaveLength(7);
    expect(calls).toBe(7);
    warn.mockRestore();
  });
});
