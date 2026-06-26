import type { AppConfig } from "../../config/env";
import { DeepSeekProvider } from "./deepseekProvider";
import { MockLLMProvider } from "./mockProvider";
import { OpenAIProvider } from "./openaiProvider";
import type { LLMProvider } from "./types";

export function createLLMProvider(config: AppConfig): LLMProvider {
  if (config.LLM_PROVIDER === "deepseek") {
    return new DeepSeekProvider({
      apiKey: config.DEEPSEEK_API_KEY!,
      baseUrl: config.DEEPSEEK_BASE_URL,
      model: config.DEEPSEEK_MODEL
    });
  }
  if (config.LLM_PROVIDER === "openai") {
    return new OpenAIProvider({ apiKey: config.OPENAI_API_KEY!, model: config.OPENAI_MODEL });
  }
  return new MockLLMProvider();
}
