import { describe, expect, it } from "vitest";
import {
  mergeTokenUsage,
  promptTokensForAgentRuns,
  recordTokenUsageOnError,
  tokenUsageFromError
} from "./token-usage";

describe("token usage accounting", () => {
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
