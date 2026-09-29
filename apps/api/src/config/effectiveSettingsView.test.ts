import { describe, expect, it } from "vitest";
import { resolveEffectiveSettings, STANDARD_SETTING_DEFINITIONS } from "./effectiveSettings";
import { toEffectiveSettingsView } from "./effectiveSettingsView";

/**
 * H09: the renderer-facing projection of the H07 effective configuration.
 * Pins the per-field source/lock/restart truth, secret presence-only
 * semantics, and the local-path boundary.
 */

const FILE_SETTINGS = {
  LLM_PROVIDER: "deepseek",
  DEEPSEEK_MODEL: "deepseek-chat",
  DEEPSEEK_API_KEY: "sk-file-stored",
  GITHUB_APP_ID: "123456"
};

function view(env: NodeJS.ProcessEnv = {}, file: Record<string, unknown> = FILE_SETTINGS) {
  return toEffectiveSettingsView(resolveEffectiveSettings({ env, file, definitions: STANDARD_SETTING_DEFINITIONS }));
}

describe("toEffectiveSettingsView", () => {
  it("resolves source precedence env > file > default per field", () => {
    const result = view({
      DEEPSEEK_MODEL: "env-model",
      CONSISTENCY_WORKER_CONCURRENCY: "3"
    });

    expect(result.items.provider).toMatchObject({ source: "file", configured: true, lockedByEnv: false, value: "deepseek" });
    expect(result.items.deepseekModel).toMatchObject({ source: "env", configured: true, lockedByEnv: true, value: "env-model" });
    expect(result.items.deepseekApiKey!).toMatchObject({ source: "file", configured: true, isSecret: true, lockedByEnv: false });
    expect(result.items.openaiApiKey!).toMatchObject({ source: "default", configured: false, isSecret: true });
    expect(result.items.workerConcurrency).toMatchObject({ source: "env", lockedByEnv: true, value: 3, restartRequired: true });
    // Unset non-secret field falls back to its definition default.
    expect(result.items.webUrl).toMatchObject({ source: "default", configured: true, value: "http://127.0.0.1:5173" });
  });

  it("never carries a plaintext value for secret fields", () => {
    const result = view();
    for (const [key, item] of Object.entries(result.items)) {
      if (item.isSecret) {
        expect(item.value, `secret ${key} must not expose a value`).toBeUndefined();
        expect(item.configured, `secret ${key} still reports presence`).toBeDefined();
      }
    }
    expect(result.items.deepseekApiKey!.configured).toBe(true);
    expect(result.items.openaiApiKey!.configured).toBe(false);
  });

  it("keeps local filesystem paths server-side (presence metadata only)", () => {
    const result = view();
    for (const key of ["databasePath", "workspaceRoot", "localReviewRoots"]) {
      expect(result.items[key]!.value, `${key} value must stay server-side`).toBeUndefined();
    }
    expect(result.items.databasePath!.configured).toBe(true);
  });

  it("groups items by category for the settings sections", () => {
    const result = view();
    const llmKeys = result.groups.llm.map(item => item.key);
    expect(llmKeys).toContain("provider");
    expect(llmKeys).toContain("deepseekApiKey");
    expect(result.groups.github.map(item => item.key)).toContain("appId");
    expect(result.groups.runtime.map(item => item.key)).toContain("workerConcurrency");
    expect(result.groups.general.map(item => item.key)).toContain("reportLanguage");
    expect(result.items.provider).toEqual(result.groups.llm.find(item => item.key === "provider"));
  });

  it("reports env-overridden variables and restart-required keys", () => {
    const result = view({ DEEPSEEK_API_KEY: "sk-env", DEEPSEEK_MODEL: "env-model" });
    expect(result.overriddenByEnvironment).toContain("DEEPSEEK_API_KEY");
    expect(result.overriddenByEnvironment).toContain("DEEPSEEK_MODEL");
    expect(result.overriddenByEnvironment).not.toContain("LLM_PROVIDER");
    expect(result.restartRequiredKeys).toContain("workerConcurrency");
    expect(result.restartRequiredKeys).toContain("webUrl");
    expect(result.restartRequiredKeys).toContain("databasePath");
    expect(result.restartRequiredKeys).not.toContain("reportLanguage");
  });
});
