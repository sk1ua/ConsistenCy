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
