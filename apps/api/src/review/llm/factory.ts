import type { AppConfig } from "../../config/env";
import type { ReviewModelOverride } from "@consistency/schema";
import { DeepSeekProvider } from "./deepseekProvider";
import { OpenAIProvider } from "./openaiProvider";
import type { LLMProvider } from "./types";

export class ReviewModelResolutionError extends Error {
  constructor(message: string, readonly code: "LLM_NOT_CONFIGURED" | "LLM_PROVIDER_NOT_CONFIGURED" | "INVALID_REVIEW_MODEL") {
    super(message);
    this.name = "ReviewModelResolutionError";
  }
}

export type ResolvedReviewModel = {
  provider: "deepseek" | "openai";
  model: string;
};

export function resolveReviewModel(options: {
  config: AppConfig;
  override?: ReviewModelOverride;
}): ResolvedReviewModel {
  const providerName = options.override?.provider ?? options.config.LLM_PROVIDER;
  if (!providerName) {
    throw new ReviewModelResolutionError(
      "尚未配置大语言模型。ConsistenCy 需要配置真实 LLM Provider (DeepSeek 或 OpenAI) 后才能执行审查。请前往设置页配置。",
      "LLM_NOT_CONFIGURED"
    );
  }

  if (providerName === "deepseek") {
    if (!options.config.DEEPSEEK_API_KEY) {
      throw new ReviewModelResolutionError(
        "DeepSeek API 密钥未配置，无法使用 DeepSeek 执行审查。请在设置页配置密钥或选择已配置的提供商。",
        "LLM_PROVIDER_NOT_CONFIGURED"
      );
    }
    const model = options.override?.name ?? options.override?.model ?? options.config.DEEPSEEK_MODEL;
    if (!model || typeof model !== "string" || !model.trim()) {
      throw new ReviewModelResolutionError("DeepSeek model name must not be empty", "INVALID_REVIEW_MODEL");
    }
    return { provider: "deepseek", model: model.trim() };
  }

  if (providerName === "openai") {
    if (!options.config.OPENAI_API_KEY) {
      throw new ReviewModelResolutionError(
        "OpenAI API 密钥未配置，无法使用 OpenAI 执行审查。请在设置页配置密钥或选择已配置的提供商。",
        "LLM_PROVIDER_NOT_CONFIGURED"
      );
    }
    const model = options.override?.name ?? options.override?.model ?? options.config.OPENAI_MODEL;
    if (!model || typeof model !== "string" || !model.trim()) {
      throw new ReviewModelResolutionError("OpenAI model name must not be empty", "INVALID_REVIEW_MODEL");
    }
    return { provider: "openai", model: model.trim() };
  }

  throw new ReviewModelResolutionError(`Unsupported provider: ${providerName}`, "INVALID_REVIEW_MODEL");
}

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

export function createReviewLLMProvider(
  config: AppConfig,
  resolved?: { provider?: "deepseek" | "openai"; model?: string }
): LLMProvider | undefined {
  const providerName = resolved?.provider ?? config.LLM_PROVIDER;
  if (providerName === "deepseek" && config.DEEPSEEK_API_KEY) {
    return new DeepSeekProvider({
      apiKey: config.DEEPSEEK_API_KEY,
      baseUrl: config.DEEPSEEK_BASE_URL,
      model: resolved?.model ?? config.DEEPSEEK_MODEL
    });
  }
  if (providerName === "openai" && config.OPENAI_API_KEY) {
    return new OpenAIProvider({
      apiKey: config.OPENAI_API_KEY,
      model: resolved?.model ?? config.OPENAI_MODEL
    });
  }
  return undefined;
}
