import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tokenUsageFromError, type TokenUsage } from "@consistency/schema";
import type { ModelDriver } from "@consistency/workload-review";
import { BaseLLMProvider } from "./provider";
import { LlmProviderError, transportFailureReason } from "./errors";
import { logger } from "../../config/logger";
import { withModelCallLogging } from "../workloadRuntime";

const request = { schema: z.object({ value: z.string() }), schemaName: "test", systemPrompt: "test", userPrompt: "test" };

describe("transport accounting honesty", () => {
  it("keeps unknown transport usage absent and logs null rather than zero", async () => {
    class UnknownProvider extends BaseLLMProvider {
      readonly name = "fixture";
      protected async complete(): Promise<never> {
        throw new LlmProviderError("Pi LLM request failed", { kind: "network" }, { failureReason: "timeout after 300s" });
      }
    }
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const error = await new UnknownProvider().invokeWithSchema(request).catch((error: unknown) => error);
      expect(tokenUsageFromError(error)).toBeUndefined();
      expect((error as Error).message).toContain("timeout after 300s");
      expect(log).toHaveBeenCalledTimes(2);
      for (const [entry] of log.mock.calls) {
        expect(entry).toMatchObject({ inputTokens: null, outputTokens: null, cachedTokens: null, promptTokens: null, usageStatus: "unknown", cacheReadStatus: "unknown" });
      }
    } finally { log.mockRestore(); }
  });

  it("marks a paid repair after an unknown attempt as partial without inflating counters", async () => {
    class RepairProvider extends BaseLLMProvider {
      readonly name = "fixture";
      calls = 0;
      protected async complete() {
        this.calls += 1;
        return this.calls === 1 ? { content: "invalid" } : {
          content: '{"value":"ok"}', tokenUsage: { inputTokens: 37, cachedTokens: 5, outputTokens: 3, totalTokens: 45 }
        };
      }
    }
    const result = await new RepairProvider().invokeWithSchema(request);
    expect(result.tokenUsage).toEqual({ inputTokens: 37, cachedTokens: 5, outputTokens: 3, totalTokens: 45, usageStatus: "partial" });
  });

  it("retains a paid malformed response when the repair fails with unknown usage", async () => {
    class RepairProvider extends BaseLLMProvider {
      readonly name = "fixture";
      calls = 0;
      protected async complete() {
        this.calls += 1;
        if (this.calls === 2) throw new Error("transport unavailable");
        return { content: "invalid", tokenUsage: { inputTokens: 37, cachedTokens: 5 } };
      }
    }
    const error = await new RepairProvider().invokeWithSchema(request).catch((error: unknown) => error);
    expect(tokenUsageFromError(error)).toEqual({ inputTokens: 37, cachedTokens: 5, usageStatus: "partial" });
  });

  it("extracts only bounded timeout/reset/DNS detail across causes", () => {
    expect(transportFailureReason(new Error("timeout after 300 seconds: upstream-private-marker sk-fixture"))).toBe("timeout after 300s");
    expect(transportFailureReason(new Error("request timed out after 300000ms"))).toBe("timeout after 300s");
    expect(transportFailureReason(new Error("generic wrapper", { cause: new Error("connect ECONNRESET credential-marker") }))).toBe("connection reset");
    expect(transportFailureReason(new Error("getaddrinfo ENOTFOUND private.example"))).toBe("DNS lookup failed");
    expect(transportFailureReason(new Error("Bearer credential-marker HTTP private details"))).toBeUndefined();
    const typed = new LlmProviderError("Pi LLM request failed", { kind: "network" }, { cause: new Error("timeout after 300s private-marker") });
    expect(typed.message).toBe("Pi LLM request failed");
    expect(typed.failureReason).toBe("timeout after 300s");
  });

  it.each([undefined, { inputTokens: 9, cachedTokens: 2, outputTokens: 1 }] as Array<TokenUsage | undefined>)("logs aggregate failure usage honestly (%j)", async usage => {
    const error = Object.assign(new Error("request timeout after 300s"), usage ? { tokenUsage: usage } : {});
    const fail = async (): Promise<never> => { throw error; };
    const driver: ModelDriver = { provider: "deepseek", invokeStructured: fail, invokeAgentFindings: fail, invokeSummary: fail };
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      await expect(withModelCallLogging(driver).invokeAgentFindings({ agent: "Security", systemPrompt: "test", userPrompt: "test" })).rejects.toBe(error);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ agent: "Security", status: "failed", reason: "request timeout after 300s",
        inputTokens: usage?.inputTokens ?? null, cachedTokens: usage?.cachedTokens ?? null, outputTokens: usage?.outputTokens ?? null,
        usageStatus: usage ? "reported" : "unknown", cacheReadStatus: usage ? "reported" : "unknown" }), "llm.result");
    } finally { log.mockRestore(); }
  });
});
