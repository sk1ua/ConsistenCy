import { describe, expect, it } from "vitest";
import {
  mergeTokenUsage,
  markTokenUsageIncomplete,
  tokenUsageStatus,
  tokenUsageNotesForAgentRuns,
  promptTokensForAgentRuns,
  recordTokenUsageOnError,
  tokenUsageFromError
} from "./token-usage";

describe("token usage accounting", () => {
  it("marks known counters partial without making wholly unknown usage numeric", () => {
    expect(markTokenUsageIncomplete(undefined)).toBeUndefined();
    expect(markTokenUsageIncomplete({})).toBeUndefined();
    expect(markTokenUsageIncomplete({ cacheReadStatus: "unavailable_or_zero" })).toBeUndefined();
    expect(markTokenUsageIncomplete({ inputTokens: 10 })).toEqual({ inputTokens: 10, usageStatus: "partial" });
    expect(mergeTokenUsage({ inputTokens: 10, usageStatus: "partial" }, { cachedTokens: 2 })).toEqual({ inputTokens: 10, cachedTokens: 2, usageStatus: "partial" });
    expect(tokenUsageStatus(undefined)).toBe("unknown");
    expect(tokenUsageStatus({ cacheReadStatus: "reported" })).toBe("unknown");
    expect(tokenUsageStatus({ inputTokens: 0 })).toBe("reported");
    expect(tokenUsageStatus({ inputTokens: 10, usageStatus: "partial" })).toBe("partial");
  });

  it("annotates incomplete LLM accounting, excluding deterministic and skipped runs", () => {
    const notes = tokenUsageNotesForAgentRuns([
      { agentName: "DeterministicAnalyzer", status: "succeeded" },
      { agentName: "ArchitectureAuditor", status: "skipped" },
      { agentName: "Security", status: "failed" },
      { agentName: "Synthesizer", status: "failed", tokenUsage: { inputTokens: 3, usageStatus: "partial" } },
      { agentName: "Correctness", status: "succeeded", tokenUsage: { totalTokens: 1 } }
    ]);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("unknown for Security");
    expect(notes[0]).toContain("not counted as zero");
    expect(notes[1]).toContain("partial for Synthesizer");
    expect(notes.join(" ")).not.toContain("DeterministicAnalyzer");
    expect(notes.join(" ")).not.toContain("ArchitectureAuditor");
    expect(tokenUsageNotesForAgentRuns([{ agentName: "Security", status: "failed" }], "zh-CN")[0]).toContain("未报告的用量不按 0");
  });
  it("sums only the counters either side actually reported", () => {
    expect(mergeTokenUsage({ inputTokens: 10, cachedTokens: 20 }, { inputTokens: 5 }))
      .toEqual({ inputTokens: 15, cachedTokens: 20 });
    expect(mergeTokenUsage(undefined, { outputTokens: 3 })).toEqual({ outputTokens: 3 });
    expect(mergeTokenUsage({ outputTokens: 3 }, undefined)).toEqual({ outputTokens: 3 });
    expect(mergeTokenUsage(undefined, undefined)).toBeUndefined();
  });

  it("never invents a counter neither side reported", () => {
    expect(mergeTokenUsage({ cachedTokens: 4 }, {})).toEqual({ cachedTokens: 4 });
    expect(mergeTokenUsage({}, {})).toEqual({});
  });

  it("reports cacheReadStatus as reported when either side reported it", () => {
    expect(mergeTokenUsage(
      { cacheReadStatus: "unavailable_or_zero" },
      { cacheReadStatus: "reported" }
    )).toEqual({ cacheReadStatus: "reported" });
  });

  it("reads usage off a typed provider error without changing its identity", () => {
    const error = new Error("Pi LLM request failed") as Error & { tokenUsage?: unknown };
    error.tokenUsage = { inputTokens: 7, cachedTokens: 2 };
    expect(tokenUsageFromError(error)).toEqual({ inputTokens: 7, cachedTokens: 2 });
    expect(tokenUsageFromError(new Error("no usage"))).toBeUndefined();
    expect(tokenUsageFromError("not an error")).toBeUndefined();
    expect(tokenUsageFromError(null)).toBeUndefined();
    expect(tokenUsageFromError({ tokenUsage: { inputTokens: "7" } })).toBeUndefined();
    expect(tokenUsageFromError({ tokenUsage: {} })).toBeUndefined();
  });

  it("records usage on a frozen cancellation reason without mutating it", () => {
    const reason = Object.freeze(new Error("aborted"));
    recordTokenUsageOnError(reason, { inputTokens: 3 });
    expect(tokenUsageFromError(reason)).toEqual({ inputTokens: 3 });
    expect(Object.isFrozen(reason)).toBe(true);
    expect("tokenUsage" in reason).toBe(false);
  });

  it("sums prompt tokens from input plus cached across successful and failed runs", () => {
    expect(promptTokensForAgentRuns([
      { tokenUsage: { inputTokens: 100, cachedTokens: 40 } },
      { tokenUsage: { inputTokens: 50 } },
      { tokenUsage: { totalTokens: 999 } },
      {}
    ])).toBe(190);
  });

  it("falls back to a provider-reported promptTokens and stays undefined when unknown", () => {
    expect(promptTokensForAgentRuns([{ tokenUsage: { promptTokens: 12 } }])).toBe(12);
    expect(promptTokensForAgentRuns([{ tokenUsage: { totalTokens: 10 } }])).toBeUndefined();
    expect(promptTokensForAgentRuns([])).toBeUndefined();
  });
});
