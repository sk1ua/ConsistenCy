import { describe, expect, it, vi } from "vitest";
import { BaseLLMProvider } from "./provider";
import { logger } from "../../config/logger";
import { z } from "zod";
import { loadEnv } from "../../config/env";
import { createLLMProvider } from "./factory";
import { MockLLMProvider } from "./mockProvider";

describe("LLM providers", () => {
  it("counts malformed-response tokens and logs both attempts once", async () => {
    class RetryingProvider extends BaseLLMProvider {
      readonly name = "test";
      calls = 0;
      protected async complete() {
        this.calls += 1;
        return { content: this.calls === 1 ? "invalid" : '{"value":"ok"}', tokenUsage: { inputTokens: 10, cachedTokens: 20, outputTokens: 3, totalTokens: 33 } };
      }
    }
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const result = await new RetryingProvider().invokeWithSchema({ schema: z.object({ value: z.string() }), schemaName: "test", systemPrompt: "test", userPrompt: "test" });
      expect(result.tokenUsage).toMatchObject({ inputTokens: 20, cachedTokens: 40, outputTokens: 6, totalTokens: 66 });
      expect(log).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenNthCalledWith(1, expect.objectContaining({ attempt: 1, status: "failed", promptTokens: 30 }), "llm.invoke");
      expect(log).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 2, status: "completed", promptTokens: 30 }), "llm.invoke");
    } finally { log.mockRestore(); }
  });

  it("logs both transport failures including the repair attempt", async () => {
    class FailingProvider extends BaseLLMProvider {
      readonly name = "test";
      protected async complete(): Promise<never> { throw new Error("transport unavailable"); }
    }
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      await expect(new FailingProvider().invokeWithSchema({ schema: z.object({ value: z.string() }), schemaName: "test", systemPrompt: "test", userPrompt: "test" })).rejects.toThrow("after one repair attempt");
      expect(log).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 2, status: "failed", inputTokens: null }), "llm.invoke");
    } finally { log.mockRestore(); }
  });
  it("keeps paid usage from a failed transport call and names the agent and sanitized reason", async () => {
    class PaidFailureProvider extends BaseLLMProvider {
      readonly name = "test";
      protected async complete(): Promise<never> {
        // A provider that reports usage alongside a transport failure: the
        // tokens were really spent and must not be dropped with the error.
        const error = new Error("upstream 500 for sk-abcdefghijklmnopqrstuvwxyz0123") as Error & { tokenUsage?: unknown };
        error.tokenUsage = { inputTokens: 9, cachedTokens: 1, outputTokens: 2 };
        throw error;
      }
    }
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const failure = await new PaidFailureProvider().invokeWithSchema({
        schema: z.object({ value: z.string() }),
        schemaName: "review-findings",
        agent: "Security",
        systemPrompt: "test",
        userPrompt: "test"
      }).then(() => undefined, (error: unknown) => error as { tokenUsage?: unknown });
      // Both attempts were billed: 9+9 input, 1+1 cached, 2+2 output.
      expect(failure?.tokenUsage).toMatchObject({ inputTokens: 18, cachedTokens: 2, outputTokens: 4 });
      expect(log).toHaveBeenNthCalledWith(1, expect.objectContaining({
        agent: "Security", status: "failed", inputTokens: 9, cachedTokens: 1, promptTokens: 10
      }), "llm.invoke");
      const logged = log.mock.calls[0]?.[0] as { reason?: string };
      expect(logged.reason).toContain("upstream 500");
      expect(logged.reason).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    } finally { log.mockRestore(); }
  });

  it("names the Planner and Synthesizer agents on the failed schema paths", async () => {
    class SummaryFailureProvider extends BaseLLMProvider {
      readonly name = "test";
      protected async complete(): Promise<never> { throw new Error("summary transport down"); }
    }
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      await expect(new SummaryFailureProvider().invokeWithSchema({
        schema: z.object({ summary: z.string() }),
        schemaName: "review-summary",
        systemPrompt: "test",
        userPrompt: "test"
      })).rejects.toThrow("after one repair attempt");
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ agent: "Synthesizer", status: "failed", reason: "summary transport down" }),
        "llm.invoke"
      );
      await expect(new SummaryFailureProvider().invokeWithSchema({
        schema: z.object({ plan: z.string() }),
        schemaName: "review-plan",
        systemPrompt: "test",
        userPrompt: "test"
      })).rejects.toThrow("after one repair attempt");
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ agent: "Planner", status: "failed" }),
        "llm.invoke"
      );
    } finally { log.mockRestore(); }
  });

  it("uses deterministic structured output in mock mode", async () => {
    const provider = new MockLLMProvider({ custom: { value: "mock" } });
    const result = await provider.invokeWithSchema({
      schema: z.object({ value: z.string() }).strict(),
      schemaName: "custom",
      systemPrompt: "Return a value",
      userPrompt: "Test"
    });
    expect(result.data).toEqual({ value: "mock" });
  });

  it("selects providers without mixing API keys", () => {
    const deepseek = createLLMProvider(loadEnv({ DEEPSEEK_API_KEY: "deepseek-key" }));
    const openai = createLLMProvider(loadEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "openai-key" }));
    const anthropic = createLLMProvider(loadEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "anthropic-key" }));
    expect(deepseek?.name).toBe("deepseek");
    expect(openai?.name).toBe("openai");
    expect(anthropic?.name).toBe("anthropic");
  });

  it("fails closed when a provider is selected without its credential", () => {
    expect(() => loadEnv({ LLM_PROVIDER: "Bad Id!" })).toThrow();
    expect(createLLMProvider(loadEnv({}))).toBeUndefined();
  });
});
