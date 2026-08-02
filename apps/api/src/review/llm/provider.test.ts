import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadEnv } from "../../config/env";
import { createLLMProvider } from "./factory";
import { DeepSeekProvider } from "./deepseekProvider";
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

  it("repairs one invalid JSON response and records token usage", async () => {
    const requests: Array<{ headers: HeadersInit; body: string }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ headers: init?.headers ?? {}, body: String(init?.body) });
      const attempt = requests.length;
      return new Response(JSON.stringify({
        choices: [{ message: { content: attempt === 1 ? "not-json" : JSON.stringify({ value: "fixed" }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new DeepSeekProvider({ apiKey: "deepseek-only-key", fetch: fetchMock as typeof fetch });

    const result = await provider.invokeWithSchema({
      schema: z.object({ value: z.string() }).strict(),
      schemaName: "repair-test",
      systemPrompt: "Return JSON",
      userPrompt: "Produce a value"
    });

    expect(result.data).toEqual({ value: "fixed" });
    expect(result.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]?.headers)).toContain("deepseek-only-key");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" },
      response_format: { type: "json_object" }
    });
  });

  it("selects providers without mixing API keys", () => {
    const deepseek = createLLMProvider(loadEnv({ DEEPSEEK_API_KEY: "deepseek-key" }));
    const openai = createLLMProvider(loadEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "openai-key" }));
    expect(deepseek.name).toBe("deepseek");
    expect(openai.name).toBe("openai");
  });

  it("normalizes OpenAI-compatible SSE deltas and usage into Notebook stream events", async () => {
    const fetchMock = vi.fn(async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hello " } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "evidence" } }] })}`,
      `data: ${JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}`,
      "data: [DONE]"
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const provider = new DeepSeekProvider({ apiKey: "stream-key", fetch: fetchMock as typeof fetch });
    const events = [] as Array<{ kind: string; [key: string]: unknown }>;
    for await (const event of provider.stream!({ systemPrompt: "system", userPrompt: "question" })) events.push(event);
    expect(events.filter(event => event.kind === "text_delta").map(event => event.text).join("")).toBe("hello evidence");
    expect(events.find(event => event.kind === "usage")).toMatchObject({ usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } });
    expect(events.at(-1)).toEqual({ kind: "completed" });
  });
});
