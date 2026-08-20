import type { AppConfig } from "../../config/env";
import { DeepSeekProvider } from "./deepseekProvider";
import { OpenAIProvider } from "./openaiProvider";
import type { LLMProvider } from "./types";

export function createLLMProvider(config: AppConfig): LLMProvider | undefined {
  if (config.LLM_PROVIDER === "deepseek" && config.DEEPSEEK_API_KEY) {
    return new DeepSeekProvider({
      apiKey: config.DEEPSEEK_API_KEY,
      baseUrl: config.DEEPSEEK_BASE_URL,
      model: config.DEEPSEEK_MODEL
    });
  }
  if (config.LLM_PROVIDER === "openai" && config.OPENAI_API_KEY) {
    return new OpenAIProvider({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL });
  }
  return undefined;
}
