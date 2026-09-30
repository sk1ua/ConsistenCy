import { createHash } from "node:crypto";
import {
  LLM_ROUTE_MAX_FALLBACKS,
  type LlmConnectionProfile
} from "@consistency/schema";
import type { AppConfig } from "../../config/env";
import { isProviderCredentialConfigured } from "../../config/settings";

/**
 * H08 — connection profiles (连接档) resolved from the EXISTING settings.
 *
 * The active profile comes from the same settings the review model resolver
 * uses (LLM_PROVIDER + per-provider model pins + DeepSeek base URL). The
 * optional user-configured fallback chain is read from the
 * `LLM_FALLBACK_CHAIN` public setting: an ordered, comma/semicolon/newline
 * separated list of `provider` or `provider:model` entries, e.g.
 * `deepseek:deepseek-chat, openai:gpt-4.1-mini`.
 *
 * Profiles carry configuration metadata only — never API keys. `enabled` is
 * derived honestly: ConsistenCy-managed providers (deepseek/openai/anthropic)
 * are enabled only when a key is present; every other Pi catalog provider
 * authenticates through Pi's environment convention at request time and
 * cannot be verified statically, so it stays enabled and any failure is
 * classified at call time.
 */

export const LLM_FALLBACK_CHAIN_SETTING = "LLM_FALLBACK_CHAIN";

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/i;

export type LlmFallbackEntry = {
  provider: string;
  model?: string;
};

export type LlmProfileChain = {
  /** The user-selected active profile (even when disabled — it is what the run asked for). */
  selected?: LlmConnectionProfile;
  /** Enabled profiles in fallback order; the router only ever walks these. */
  chain: LlmConnectionProfile[];
  /** All candidates (selected + fallbacks) for configRevision pinning. */
  candidates: LlmConnectionProfile[];
  /** True when the user configured at least one non-duplicate fallback entry. */
  fallbackConfigured: boolean;
  /** Raw entries rejected by validation (bad provider id). */
  ignoredEntries: string[];
};

/**
 * Enabled = a credential is present for ConsistenCy-managed providers.
 * Uses the same credential scope as settings and doctor. Other providers stay
 * enabled for Pi to authenticate through its own environment convention.
 */
export function profileEnabled(config: AppConfig, provider: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  if (["deepseek", "openai", "anthropic"].includes(normalizedProvider)) {
    return isProviderCredentialConfigured(normalizedProvider, config);
  }
  return true;
}

/** Endpoint is recorded for contract completeness; DeepSeek is the only settings-backed one today. */
function baseUrlFor(config: AppConfig, provider: string): { baseUrl?: string } {
  if (provider === "deepseek" && config.DEEPSEEK_BASE_URL) {
    return { baseUrl: config.DEEPSEEK_BASE_URL };
  }
  return {};
}

type RawFallbackEntry = {
  provider: string;
  model?: string;
  valid: boolean;
};

function splitLlmFallbackEntries(raw: string | undefined): RawFallbackEntry[] {
  if (!raw || !raw.trim()) return [];
  const entries: RawFallbackEntry[] = [];
  for (const piece of raw.split(/[;,\n]/)) {
    const entry = piece.trim();
    if (!entry) continue;
    const separator = entry.indexOf(":");
    const provider = (separator === -1 ? entry : entry.slice(0, separator)).trim().toLowerCase();
    const model = separator === -1 ? undefined : entry.slice(separator + 1).trim() || undefined;
    const valid = PROVIDER_ID_PATTERN.test(provider);
    entries.push({ provider, ...(model ? { model } : {}), valid });
  }
  return entries;
}

/**
 * Parse the user-configured fallback chain string into valid entries only.
 * Invalid provider ids are dropped; duplicates within the chain are skipped;
 * model ids may contain "/" (e.g. openrouter references) because only the
 * FIRST ":" separates provider from model.
 */
export function parseLlmFallbackEntries(raw: string | undefined): LlmFallbackEntry[] {
  return splitLlmFallbackEntries(raw)
    .filter(entry => entry.valid)
    .filter((entry, index, all) => all.findIndex(other => other.provider === entry.provider && (other.model ?? "") === (entry.model ?? "")) === index)
    .map(({ provider, model }) => ({ provider, ...(model ? { model } : {}) }));
}

function profileKey(profile: { provider: string; model?: string }): string {
  return `${profile.provider.toLowerCase()}|${profile.model ?? ""}`;
}

export function buildLlmProfileChain(options: {
  config: AppConfig;
  selected?: { provider: string; model?: string };
}): LlmProfileChain {
  const config = options.config;
  const selectedInput = options.selected;
  if (!selectedInput || !selectedInput.provider) {
    return { chain: [], candidates: [], fallbackConfigured: false, ignoredEntries: [] };
  }
  const provider = selectedInput.provider.trim().toLowerCase();
  const model = selectedInput.model?.trim() || undefined;
  const selected: LlmConnectionProfile = {
    id: "primary",
    provider,
    ...(model ? { model } : {}),
    ...baseUrlFor(config, provider),
    enabled: profileEnabled(config, provider)
  };

  const ignoredEntries: string[] = [];
  const fallbacks: LlmConnectionProfile[] = [];
  const seen = new Set<string>([profileKey(selected)]);
  let fallbackOrdinal = 0;
  for (const entry of splitLlmFallbackEntries(config.LLM_FALLBACK_CHAIN)) {
    if (!entry.valid) {
      ignoredEntries.push(`${entry.provider}${entry.model ? `:${entry.model}` : ""}`);
      continue;
    }
    const key = profileKey(entry);
    if (seen.has(key)) continue;
    if (fallbacks.length >= LLM_ROUTE_MAX_FALLBACKS) continue;
    seen.add(key);
    fallbackOrdinal += 1;
    fallbacks.push({
      id: `fallback-${fallbackOrdinal}`,
      provider: entry.provider,
      ...(entry.model ? { model: entry.model } : {}),
      ...baseUrlFor(config, entry.provider),
      enabled: profileEnabled(config, entry.provider)
    });
  }

  const candidates = [selected, ...fallbacks];
  const chain = candidates.filter(profile => profile.enabled);
  return {
    selected,
    chain,
    candidates,
    fallbackConfigured: fallbacks.length > 0,
    ignoredEntries
  };
}

/**
 * Routing-relevant configuration revision, fixed when a run starts. Derived
 * from non-secret inputs only: profile coordinates, enabled flags, and API
 * key PRESENCE booleans. Raw keys never enter the hash.
 */
export function computeLlmConfigRevision(config: AppConfig, candidates: readonly LlmConnectionProfile[]): string {
  const fingerprint = {
    v: 2,
    piModelsPath: config.piModelsPath ?? "",
    temperature: config.CONSISTENCY_LLM_TEMPERATURE ?? null,
    profiles: candidates.map(profile => ({
      id: profile.id,
      provider: profile.provider,
      model: profile.model ?? "",
      baseUrl: profile.baseUrl ?? "",
      enabled: profile.enabled
    })),
    keys: {
      deepseek: Boolean(config.DEEPSEEK_API_KEY),
      openai: Boolean(config.OPENAI_API_KEY),
      anthropic: Boolean(config.ANTHROPIC_API_KEY),
      generic: Boolean(config.LLM_API_KEY)
    }
  };
  return `cfgrev-${createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex").slice(0, 16)}`;
}
