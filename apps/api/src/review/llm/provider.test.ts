import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadEnv } from "../../config/env";
import { createLLMProvider } from "./factory";
import { MockLLMProvider } from "./mockProvider";

describe("LLM providers", () => {
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
