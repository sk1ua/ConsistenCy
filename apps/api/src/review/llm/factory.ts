import { createHash } from "node:crypto";
import type { AppConfig } from "../../config/env";
import type { ReviewModelOverride } from "@consistency/schema";
import { PiRuntimeProvider } from "./piProvider";
import { configuredProviderIds, hasCatalogProvider } from "./piCatalog";
import { buildLlmProfileChain, computeLlmConfigRevision } from "./profiles";
import { RoutedLLMProvider } from "./routing";
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

  // Canonical field is `model`. Legacy `name` remains accepted for older
  // clients; when both are present, `model` wins.
  const pinnedModel = options.override?.model ?? options.override?.name
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
    config.piModelsPath ?? "",
    config.piConfigDir,
    config.CONSISTENCY_LLM_TEMPERATURE ?? "",
    config.CONSISTENCY_LLM_BASE_URL ?? (provider === "deepseek" ? config.DEEPSEEK_BASE_URL ?? "" : ""),
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

/** Single-profile creation: one Pi adapter per (provider, model, key-fingerprint). */
function createSingleProfileLLMProvider(config: AppConfig, profile: { provider: string; model?: string }): LLMProvider {
  return piProvider(config, profile.provider, profile.model ?? "");
}

/**
 * Review provider for one run. Without a user-configured fallback chain this
 * is the unchanged single-profile Pi adapter. When `LLM_FALLBACK_CHAIN` is
 * configured, the run gets a routed provider: the selected profile first,
 * then at most two bounded, shared-budget fallbacks; cancellation never
 * falls back; exhaustion returns the canonical LLM_NO_AVAILABLE_PROFILE
 * error; and the route record keeps the selected and actually-used models
 * visible for the run.
 */
export function createReviewLLMProvider(
  config: AppConfig,
  resolved?: { provider?: string; model?: string }
): LLMProvider | undefined {
  const provider = (resolved?.provider ?? config.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (!provider) return undefined;
  const model = resolved?.model ?? providerModelPin(config, provider) ?? "";
  const chain = buildLlmProfileChain({ config, selected: { provider, model } });
  // No user-configured fallbacks → unchanged single-profile behavior.
  if (!chain.fallbackConfigured || !chain.selected) {
    return createSingleProfileLLMProvider(config, { provider, model });
  }
  return new RoutedLLMProvider({
    selected: chain.selected,
    chain: chain.chain,
    configRevision: computeLlmConfigRevision(config, chain.candidates),
    spawn: profile => createSingleProfileLLMProvider(config, profile)
  });
}

/** Honest readiness: a provider counts as configured only when a key exists
 *  in ConsistenCy settings/env or Pi's catalog actually lists it. */
export async function isProviderConfigured(config: AppConfig, provider: string): Promise<boolean> {
  const normalized = provider.trim().toLowerCase();
  if (configuredProviderIds(config).includes(normalized)) return true;
  return hasCatalogProvider(config, normalized);
}
