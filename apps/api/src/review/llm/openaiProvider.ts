import { OpenAICompatibleProvider } from "./openAICompatibleProvider";

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(options: { apiKey: string; model?: string; fetch?: typeof fetch }) {
    super({
      name: "openai",
      apiKey: options.apiKey,
      baseUrl: "https://api.openai.com/v1",
      model: options.model ?? "gpt-4.1-mini",
      fetch: options.fetch
    });
  }
}
