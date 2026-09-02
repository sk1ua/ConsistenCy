import { createHash } from "node:crypto";
import type { AppConfig } from "../../config/env";
import type { ReviewModelOverride } from "@consistency/schema";
import { PiRuntimeProvider } from "./piProvider";
import { configuredProviderIds, hasCatalogProvider } from "./piCatalog";
import type { LLMProvider } from "./types";

export class ReviewModelResolutionError extends Error {
  constructor(message: string, readonly code: "LLM_NOT_CONFIGURED" | "LLM_PROVIDER_NOT_CONFIGURED" | "INVALID_REVIEW_MODEL") {
    super(message);
    this.name = "ReviewModelResolutionError";
  }
}

export type ResolvedReviewModel = {
  provider: string;
  /** Empty string lets the Pi runtime pick the provider's first available model. */
  model: string;
};

export function resolveReviewModel(options: {
  config: AppConfig;
  override?: ReviewModelOverride;
}): ResolvedReviewModel {
  const provider = (options.override?.provider ?? options.config.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (!provider) {
    throw new ReviewModelResolutionError(
      "尚未配置大语言模型。ConsistenCy 需要配置真实 LLM Provider 后才能执行审查。请前往设置页配置。",
      "LLM_NOT_CONFIGURED"
    );
  }

  const pinnedModel = options.override?.name ?? options.override?.model
    ?? providerModelPin(options.config, provider)
    ?? "";
  return { provider, model: pinnedModel.trim() };
}

/** Provider-specific model pin from server-side environment configuration. */
function providerModelPin(config: AppConfig, provider: string): string | undefined {
  if (provider === "deepseek") return config.DEEPSEEK_MODEL;
  if (provider === "openai") return config.OPENAI_MODEL;
  if (provider === "anthropic") return config.ANTHROPIC_MODEL;
  return config.LLM_MODEL;
}

export function providerUnconfiguredError(provider: string): ReviewModelResolutionError {
  return new ReviewModelResolutionError(
    `${provider} 尚未配置 API 密钥，无法执行审查。请在设置页配置该服务商的密钥。`,
    "LLM_PROVIDER_NOT_CONFIGURED"
  );
}

const piProviders = new Map<string, PiRuntimeProvider>();

/**
 * One provider adapter per (provider, model, key-fingerprint). The underlying
 * Pi runtime is shared (see piCatalog.ts); adapters only pin the selection.
 * With no pinned model the runtime selects the provider's first authenticated
 * catalog model.
 */
function piProvider(config: AppConfig, provider: string, model: string): PiRuntimeProvider {
  const key = [
    provider,
    model,
    createHash("sha256").update(JSON.stringify([config.LLM_PROVIDER ?? "", config.LLM_API_KEY ?? "", config.DEEPSEEK_API_KEY ?? "", config.OPENAI_API_KEY ?? "", config.ANTHROPIC_API_KEY ?? ""])).digest("hex").slice(0, 16)
  ].join("|");
  const existing = piProviders.get(key);
  if (existing) return existing;
  const created = PiRuntimeProvider.fromShared(config, provider, model || undefined);
  piProviders.set(key, created);
  return created;
}

export function createLLMProvider(config: AppConfig): LLMProvider | undefined {
  const provider = config.LLM_PROVIDER?.trim().toLowerCase();
  if (!provider) return undefined;
  return piProvider(config, provider, resolveReviewModel({ config }).model);
}

export function createReviewLLMProvider(
  config: AppConfig,
  resolved?: { provider?: string; model?: string }
): LLMProvider | undefined {
  const provider = (resolved?.provider ?? config.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (!provider) return undefined;
  const model = resolved?.model ?? providerModelPin(config, provider) ?? "";
  return piProvider(config, provider, model);
}

/** Honest readiness: a provider counts as configured only when a key exists
 *  in ConsistenCy settings/env or Pi's catalog actually lists it. */
export async function isProviderConfigured(config: AppConfig, provider: string): Promise<boolean> {
  const normalized = provider.trim().toLowerCase();
  if (configuredProviderIds(config).includes(normalized)) return true;
  return hasCatalogProvider(config, normalized);
}
