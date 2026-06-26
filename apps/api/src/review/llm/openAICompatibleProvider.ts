import { BaseLLMProvider, parseTokenUsage } from "./provider";
import type { LLMProvider } from "./types";

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
}
