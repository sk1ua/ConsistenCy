import { BaseLLMProvider, parseTokenUsage } from "./provider";
import type { LLMProvider, LLMStreamRequest } from "./types";
import type { LLMStreamEvent } from "@consistency/schema";

type FetchLike = typeof fetch;

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export class OpenAICompatibleProvider extends BaseLLMProvider {
  readonly name: LLMProvider["name"];
  override readonly model: string;

  constructor(private readonly options: {
    name: "deepseek" | "openai";
    apiKey: string;
    baseUrl: string;
    model: string;
    fetch?: FetchLike;
    extraBody?: Record<string, unknown>;
  }) {
    super();
    this.name = options.name;
    this.model = options.model;
  }

  protected override async complete(input: {
    systemPrompt: string;
    userPrompt: string;
    schemaName: string;
    jsonSchema: unknown;
  }) {
    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          { role: "system", content: input.systemPrompt },
          {
            role: "user",
            content: `${input.userPrompt}\n\nJSON schema (${input.schemaName}):\n${JSON.stringify(input.jsonSchema)}`
          }
        ],
        response_format: { type: "json_object" },
        stream: false,
        max_tokens: 4_096,
        ...this.options.extraBody
      })
    });
    if (!response.ok) {
      throw new Error(`${this.name} completion failed with HTTP ${response.status}`);
    }
    const payload = await response.json() as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`${this.name} completion returned empty content`);
    }
    return {
      content,
      tokenUsage: parseTokenUsage({
        inputTokens: payload.usage?.prompt_tokens,
        outputTokens: payload.usage?.completion_tokens,
        totalTokens: payload.usage?.total_tokens
      })
    };
  }

  override async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    const fetchImpl = this.options.fetch ?? fetch;
    try {
      const response = await fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userPrompt }
          ],
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 4_096,
          ...this.options.extraBody
        }),
        signal: request.signal
      });
      if (!response.ok) throw new Error(`${this.name} streaming completion failed with HTTP ${response.status}`);

      if (!response.body) {
        const payload = await response.json() as ChatCompletionResponse;
        const content = payload.choices?.[0]?.message?.content;
        if (!content) throw new Error(`${this.name} streaming completion returned empty content`);
        yield { kind: "text_delta", text: content };
        const usage = parseTokenUsage({
          inputTokens: payload.usage?.prompt_tokens,
          outputTokens: payload.usage?.completion_tokens,
          totalTokens: payload.usage?.total_tokens
        });
        if (usage) yield { kind: "usage", usage };
        yield { kind: "completed" };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const payload = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string | null } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const delta = payload.choices?.[0]?.delta?.content;
          if (delta) yield { kind: "text_delta", text: delta };
          const usage = parseTokenUsage({
            inputTokens: payload.usage?.prompt_tokens,
            outputTokens: payload.usage?.completion_tokens,
            totalTokens: payload.usage?.total_tokens
          });
          if (usage) yield { kind: "usage", usage };
        }
      }
      if (buffer.trim().startsWith("data:")) {
        const data = buffer.slice(5).trim();
        if (data && data !== "[DONE]") {
          const payload = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string | null } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const delta = payload.choices?.[0]?.delta?.content;
          if (delta) yield { kind: "text_delta", text: delta };
          const usage = parseTokenUsage({
            inputTokens: payload.usage?.prompt_tokens,
            outputTokens: payload.usage?.completion_tokens,
            totalTokens: payload.usage?.total_tokens
          });
          if (usage) yield { kind: "usage", usage };
        }
      }
      yield { kind: "completed" };
    } catch (error) {
      yield { kind: "failed", error: error instanceof Error ? error.message : "LLM stream failed" };
    }
  }
}
