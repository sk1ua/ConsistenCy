import { OpenAICompatibleProvider } from "./openAICompatibleProvider";

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(options: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    fetch?: typeof fetch;
  }) {
    super({
      name: "deepseek",
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? "https://api.deepseek.com",
      model: options.model ?? "deepseek-v4-flash",
      fetch: options.fetch,
      extraBody: { thinking: { type: "disabled" } }
    });
  }
}
