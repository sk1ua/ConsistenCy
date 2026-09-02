import { join } from "node:path";
import { createHash } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../../config/env";

/**
 * Single shared Pi runtime for the whole API process. Pi's built-in catalog is
 * the only model source (modelsPath: null detaches from any user-level
 * ~/.pi/models.json), catalog network refresh stays disabled, and provider API
 * keys configured through ConsistenCy settings are injected in-memory via
 * setRuntimeApiKey (non-persistent overlay; never written to disk). Providers
 * without an injected key still resolve auth through Pi's own environment
 * convention at request time.
 *
 * The same runtime answers catalog queries (providers/models for the Web UI)
 * and executes review/Notebook/Copilot completions, matching Pi's intended
 * "one Models collection, many providers" usage.
 */
export interface PiKeyInjection {
  providerId: string;
  apiKey: string;
}

export function managedKeyInjections(config: AppConfig): PiKeyInjection[] {
  const injections: PiKeyInjection[] = [];
  if (config.LLM_PROVIDER && config.LLM_API_KEY) {
    injections.push({ providerId: config.LLM_PROVIDER.toLowerCase(), apiKey: config.LLM_API_KEY });
  }
  if (config.DEEPSEEK_API_KEY) injections.push({ providerId: "deepseek", apiKey: config.DEEPSEEK_API_KEY });
  if (config.OPENAI_API_KEY) injections.push({ providerId: "openai", apiKey: config.OPENAI_API_KEY });
  if (config.ANTHROPIC_API_KEY) injections.push({ providerId: "anthropic", apiKey: config.ANTHROPIC_API_KEY });
  return injections;
}

function keysFingerprint(config: AppConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(managedKeyInjections(config).map(({ providerId, apiKey }) => [providerId, createHash("sha256").update(apiKey).digest("hex")])) + `|${config.LLM_PROVIDER ?? ""}`)
    .digest("hex");
}

let sharedRuntime: Promise<ModelRuntime> | undefined;
let sharedFingerprint: string | undefined;

export function piRuntime(config: AppConfig): Promise<ModelRuntime> {
  const fingerprint = keysFingerprint(config);
  if (sharedRuntime && sharedFingerprint === fingerprint) return sharedRuntime;
  sharedRuntime = ModelRuntime.create({
    authPath: join(config.piConfigDir, "runtime-auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false
  }).then(async runtime => {
    for (const { providerId, apiKey } of managedKeyInjections(config)) {
      await runtime.setRuntimeApiKey(providerId, apiKey);
    }
    return runtime;
  });
  sharedFingerprint = fingerprint;
  return sharedRuntime;
}

/** Reset the shared runtime (used by tests). */
export function resetPiRuntime(): void {
  sharedRuntime = undefined;
  sharedFingerprint = undefined;
}

export interface PiCatalogProvider {
  id: string;
  label: string;
  modelCount: number;
  models: Array<{ id: string; name: string }>;
}

const MAX_MODELS_PER_PROVIDER = 200;

export async function piCatalog(config: AppConfig): Promise<PiCatalogProvider[]> {
  const runtime = await piRuntime(config);
  const providers = runtime
    .getProviders()
    .map(provider => ({
      id: provider.id,
      label: provider.name || provider.id,
      models: runtime.getModels(provider.id).map(model => ({ id: model.id, name: model.name || model.id }))
    }))
    .filter(provider => provider.models.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
  return providers.map(provider => ({
    id: provider.id,
    label: provider.label,
    modelCount: provider.models.length,
    models: provider.models.slice(0, MAX_MODELS_PER_PROVIDER)
  }));
}

export async function hasCatalogProvider(config: AppConfig, providerId: string): Promise<boolean> {
  const runtime = await piRuntime(config);
  return runtime.getModels(providerId).length > 0;
}

/** Provider ids whose API key is present in ConsistenCy settings/env. */
export function configuredProviderIds(config: AppConfig): string[] {
  const ids = new Set<string>();
  if (config.DEEPSEEK_API_KEY) ids.add("deepseek");
  if (config.OPENAI_API_KEY) ids.add("openai");
  if (config.ANTHROPIC_API_KEY) ids.add("anthropic");
  if (config.LLM_API_KEY && config.LLM_PROVIDER) ids.add(config.LLM_PROVIDER.toLowerCase());
  return [...ids];
}
