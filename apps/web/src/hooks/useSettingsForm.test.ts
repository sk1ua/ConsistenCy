import { describe, expect, it } from "vitest";
import type { HealthResponse, SettingsSnapshot } from "../api/client";
import {
  buildSettingsPatch,
  computeReadiness,
  emptySecrets,
  keepSecrets,
  secretValue,
  withDesktopCredentialStatus,
  type SecretDrafts,
  type ClearSecrets,
  type SecretName
} from "./useSettingsForm";

const baseSettings: SettingsSnapshot = {
  llm: {
    provider: "deepseek",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-chat",
    openaiModel: "",
    deepseekApiKeyConfigured: true,
    openaiApiKeyConfigured: false
  },
  github: {
    appId: "123456",
    privateKeyConfigured: true,
    webhookSecretConfigured: true,
    publicReadTokenConfigured: false
  },
  runtime: {
    storage: { kind: "file", configured: true },
    workspace: { configured: true },
    localReview: { configured: false, rootCount: 0 },
    workerConcurrency: 1,
    workerPollIntervalMs: 500,
    webUrl: "http://127.0.0.1:5173",
    apiTokenConfigured: false
  },
  overriddenByEnvironment: [],
  restartRequired: false
};

const LLM_KEY_DEEPSEEK: SecretName = "deepseekApiKey";
const LLM_KEY_OPENAI: SecretName = "openaiApiKey";
const GH_KEY_PRIVATE: SecretName = "privateKey";
const GH_KEY_WEBHOOK: SecretName = "webhookSecret";
const GH_KEY_TOKEN: SecretName = "publicReadToken";

describe("secretValue", () => {
  it("returns null when clear is true regardless of value", () => {
    expect(secretValue("some-secret", true)).toBe(null);
    expect(secretValue("", true)).toBe(null);
  });

  it("returns undefined when value is empty and not clearing", () => {
    expect(secretValue("", false)).toBe(undefined);
    expect(secretValue("   ", false)).toBe(undefined);
  });

  it("returns the trimmed value when a replacement is entered", () => {
    expect(secretValue("  replacement-value  ", false)).toBe("replacement-value");
  });
});

describe("buildSettingsPatch", () => {
  it("omits secret fields from the patch body when a bridge is available", () => {
    const patch = buildSettingsPatch(baseSettings, emptySecrets, keepSecrets, true);
    const llmKeys = Object.keys(patch.llm ?? {});
    const ghKeys = Object.keys(patch.github ?? {});
    expect(llmKeys).not.toContain(LLM_KEY_DEEPSEEK);
    expect(llmKeys).not.toContain(LLM_KEY_OPENAI);
    expect(ghKeys).not.toContain(GH_KEY_PRIVATE);
    expect(ghKeys).not.toContain(GH_KEY_WEBHOOK);
    expect(ghKeys).not.toContain(GH_KEY_TOKEN);
  });

  it("includes secret values in the patch body when no bridge is available", () => {
    const secrets: SecretDrafts = { ...emptySecrets, [LLM_KEY_DEEPSEEK]: "replacement-value" };
    const patch = buildSettingsPatch(baseSettings, secrets, keepSecrets, false);
    expect((patch.llm as Record<string, unknown>)[LLM_KEY_DEEPSEEK]).toBe("replacement-value");
    expect((patch.github as Record<string, unknown>)[GH_KEY_PRIVATE]).toBe(undefined);
  });

  it("sends null for cleared secrets when no bridge is available", () => {
    const clearSecrets: ClearSecrets = { ...keepSecrets, [GH_KEY_WEBHOOK]: true };
    const patch = buildSettingsPatch(baseSettings, emptySecrets, clearSecrets, false);
    expect((patch.github as Record<string, unknown>)[GH_KEY_WEBHOOK]).toBe(null);
  });
});

describe("computeReadiness", () => {
  const health: HealthResponse = {
    ok: true,
    service: "consistency-api",
    database: { ok: true },
    worker: { running: true, activeJobs: 0, concurrency: 1 },
    llmProvider: "deepseek",
    publicPrAccessMode: "anonymous",
    configuration: {
      githubAppConfigured: true,
      webhookSecretConfigured: true,
      publicReadTokenConfigured: false,
      storage: { kind: "file", configured: true },
      workerConcurrency: 1
    }
  };

  it("marks llm ready when provider has a configured key", () => {
    const r = computeReadiness(baseSettings, baseSettings, emptySecrets, keepSecrets, health);
    expect(r.llmReady).toBe(true);
  });

  it("marks llm not ready when provider is none", () => {
    const noneSettings = { ...baseSettings, llm: { ...baseSettings.llm, provider: "none" as const } };
    const r = computeReadiness(noneSettings, noneSettings, emptySecrets, keepSecrets, health);
    expect(r.llmReady).toBe(false);
  });

  it("reports readiness count out of 3", () => {
    const r = computeReadiness(baseSettings, baseSettings, emptySecrets, keepSecrets, health);
    expect(r.readiness.total).toBe(3);
    expect(r.readiness.complete).toBeGreaterThanOrEqual(1);
  });
});

describe("withDesktopCredentialStatus", () => {
  it("OR-merges desktop credential booleans onto the settings snapshot", () => {
    const status = {
      DEEPSEEK_API_KEY: true,
      OPENAI_API_KEY: false,
      GITHUB_PRIVATE_KEY: true,
      GITHUB_WEBHOOK_SECRET: false,
      GITHUB_PUBLIC_READ_TOKEN: true
    };
    const result = withDesktopCredentialStatus(baseSettings, status);
    expect(result.llm.deepseekApiKeyConfigured).toBe(true);
    expect(result.llm.openaiApiKeyConfigured).toBe(false);
    expect(result.github.privateKeyConfigured).toBe(true);
    expect(result.github.webhookSecretConfigured).toBe(true);
    expect(result.github.publicReadTokenConfigured).toBe(true);
  });
});
