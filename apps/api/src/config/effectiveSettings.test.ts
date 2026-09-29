import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isRestartRequired,
  isSecretSetting,
  resolveEffectiveSetting,
  resolveEffectiveSettings
} from "./effectiveSettings";
import { SettingsStore } from "./settings";

describe("effectiveSettings", () => {
  const tempDirectories: string[] = [];

  afterEach(() => {
    for (const dir of tempDirectories.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempStore(): SettingsStore {
    const dir = mkdtempSync(join(tmpdir(), "consistency-effective-settings-"));
    tempDirectories.push(dir);
    return new SettingsStore(dir);
  }

  describe("Precedence: env > file > default (Requirement 1)", () => {
    it("selects environment variable value over file and default with source 'env'", () => {
      const item = resolveEffectiveSetting("workerConcurrency", {
        env: { CONSISTENCY_WORKER_CONCURRENCY: "8" },
        file: { workerConcurrency: 4 },
        defaults: { workerConcurrency: 1 }
      });

      expect(item.value).toBe(8);
      expect(item.source).toBe("env");
      expect(item.overriddenByEnv).toBe(true);
      expect(item.readOnly).toBe(true);
    });

    it("selects file value over default when env is not set with source 'file'", () => {
      const item = resolveEffectiveSetting("workerConcurrency", {
        env: {},
        file: { workerConcurrency: 4 },
        defaults: { workerConcurrency: 1 }
      });

      expect(item.value).toBe(4);
      expect(item.source).toBe("file");
      expect(item.overriddenByEnv).toBe(false);
      expect(item.readOnly).toBe(false);
      expect(item.editable).toBe(true);
    });

    it("falls back to default when neither env nor file is provided with source 'default'", () => {
      const item = resolveEffectiveSetting("workerConcurrency", {
        env: {},
        file: {},
        defaults: { workerConcurrency: 1 }
      });

      expect(item.value).toBe(1);
      expect(item.source).toBe("default");
      expect(item.overriddenByEnv).toBe(false);
      expect(item.readOnly).toBe(false);
      expect(item.editable).toBe(true);
    });

    it("treats empty or whitespace-only env values as unset (falls through to file)", () => {
      const item = resolveEffectiveSetting("webUrl", {
        env: { CONSISTENCY_WEB_URL: "   " },
        file: { webUrl: "https://file.example.com" }
      });

      expect(item.value).toBe("https://file.example.com");
      expect(item.source).toBe("file");
      expect(item.overriddenByEnv).toBe(false);
      expect(item.readOnly).toBe(false);
    });

    it("treats empty or whitespace-only file values as unset (falls through to default)", () => {
      const item = resolveEffectiveSetting("databasePath", {
        env: {},
        file: { databasePath: "   " }
      });

      expect(item.value).toBe(".consistency/consistency.db");
      expect(item.source).toBe("default");
      expect(item.overriddenByEnv).toBe(false);
      expect(item.readOnly).toBe(false);
    });

    it("handles zero and boolean false correctly without treating them as unset", () => {
      const zeroItem = resolveEffectiveSetting("testZero", {
        env: {},
        file: { testZero: 0 },
        definitions: [{
          key: "testZero",
          envVar: "TEST_ZERO",
          type: "number",
          defaultValue: 99
        }]
      });
      expect(zeroItem.value).toBe(0);
      expect(zeroItem.source).toBe("file");
      expect(zeroItem.configured).toBe(true);

      const falseItem = resolveEffectiveSetting("testFalse", {
        env: { TEST_FALSE: "false" },
        definitions: [{
          key: "testFalse",
          envVar: "TEST_FALSE",
          type: "boolean",
          defaultValue: true
        }]
      });
      expect(falseItem.value).toBe(false);
      expect(falseItem.source).toBe("env");
      expect(falseItem.configured).toBe(true);
    });
  });

  describe("UI immutability for environment hard-overrides (Requirement 2)", () => {
    it("marks settings hard-overridden by env as readOnly: true and editable: false", () => {
      const result = resolveEffectiveSettings({
        env: {
          CONSISTENCY_WORKER_CONCURRENCY: "4",
          DATABASE_PATH: "/custom/path/db.sqlite"
        },
        file: {
          workerConcurrency: 2,
          databasePath: "/file/path/db.sqlite"
        }
      });

      const concurrency = result.items.workerConcurrency!;
      expect(concurrency.source).toBe("env");
      expect(concurrency.overriddenByEnv).toBe(true);
      expect(concurrency.lockedByEnv).toBe(true);
      expect(concurrency.readOnly).toBe(true);
      expect(concurrency.editable).toBe(false);

      const dbPath = result.items.databasePath!;
      expect(dbPath.source).toBe("env");
      expect(dbPath.overriddenByEnv).toBe(true);
      expect(dbPath.readOnly).toBe(true);
      expect(dbPath.editable).toBe(false);
    });

    it("leaves file-sourced and default-sourced settings editable", () => {
      const result = resolveEffectiveSettings({
        env: {},
        file: {
          webUrl: "http://file-origin:3000"
        }
      });

      const webUrl = result.items.webUrl!;
      expect(webUrl.source).toBe("file");
      expect(webUrl.overriddenByEnv).toBe(false);
      expect(webUrl.lockedByEnv).toBe(false);
      expect(webUrl.readOnly).toBe(false);
      expect(webUrl.editable).toBe(true);

      const concurrency = result.items.workerConcurrency!;
      expect(concurrency.source).toBe("default");
      expect(concurrency.overriddenByEnv).toBe(false);
      expect(concurrency.readOnly).toBe(false);
      expect(concurrency.editable).toBe(true);
    });

    it("populates overriddenByEnvironment list sorted by envVar name", () => {
      const result = resolveEffectiveSettings({
        env: {
          CONSISTENCY_WORKER_CONCURRENCY: "6",
          CONSISTENCY_WEB_URL: "http://override.local",
          DEEPSEEK_API_KEY: "secret-key"
        }
      });

      expect(result.overriddenByEnvironment).toEqual([
        "CONSISTENCY_WEB_URL",
        "CONSISTENCY_WORKER_CONCURRENCY",
        "DEEPSEEK_API_KEY"
      ]);
    });
  });

  describe("Restart required flags (Requirement 3)", () => {
    it("marks workerConcurrency, webUrl, and databasePath with restartRequired: true", () => {
      const concurrency = resolveEffectiveSetting("workerConcurrency");
      expect(concurrency.restartRequired).toBe(true);

      const webUrl = resolveEffectiveSetting("webUrl");
      expect(webUrl.restartRequired).toBe(true);

      const databasePath = resolveEffectiveSetting("databasePath");
      expect(databasePath.restartRequired).toBe(true);
    });

    it("marks other process-critical infrastructure fields with restartRequired: true", () => {
      expect(isRestartRequired("workerConcurrency")).toBe(true);
      expect(isRestartRequired("CONSISTENCY_WORKER_CONCURRENCY")).toBe(true);
      expect(isRestartRequired("runtime.workerConcurrency")).toBe(true);
      expect(isRestartRequired("webUrl")).toBe(true);
      expect(isRestartRequired("CONSISTENCY_WEB_URL")).toBe(true);
      expect(isRestartRequired("databasePath")).toBe(true);
      expect(isRestartRequired("DATABASE_PATH")).toBe(true);
      expect(isRestartRequired("workspaceRoot")).toBe(true);
      expect(isRestartRequired("localReviewRoots")).toBe(true);
      expect(isRestartRequired("workerPollIntervalMs")).toBe(true);
      expect(isRestartRequired("port")).toBe(true);
      expect(isRestartRequired("host")).toBe(true);
      expect(isRestartRequired("apiToken")).toBe(true);
      expect(isRestartRequired("provider")).toBe(true);
      expect(isRestartRequired("githubAppId")).toBe(true);
      expect(isRestartRequired("privateKey")).toBe(true);
    });

    it("marks non-restart fields (e.g. reportLanguage) with restartRequired: false", () => {
      expect(isRestartRequired("reportLanguage")).toBe(false);
      expect(isRestartRequired("CONSISTENCY_REPORT_LANGUAGE")).toBe(false);
      expect(isRestartRequired("theme")).toBe(false);

      const item = resolveEffectiveSetting("reportLanguage");
      expect(item.restartRequired).toBe(false);
    });

    it("includes all restart-requiring keys in restartRequiredKeys", () => {
      const result = resolveEffectiveSettings();
      expect(result.restartRequiredKeys).toContain("workerConcurrency");
      expect(result.restartRequiredKeys).toContain("webUrl");
      expect(result.restartRequiredKeys).toContain("databasePath");
      expect(result.restartRequiredKeys).toContain("provider");
      expect(result.restartRequiredKeys).not.toContain("reportLanguage");
    });
  });

  describe("Sensitive fields security and non-leakage (Requirement 4)", () => {
    it("identifies all sensitive credential keys correctly via isSecretSetting", () => {
      expect(isSecretSetting("DEEPSEEK_API_KEY")).toBe(true);
      expect(isSecretSetting("OPENAI_API_KEY")).toBe(true);
      expect(isSecretSetting("ANTHROPIC_API_KEY")).toBe(true);
      expect(isSecretSetting("LLM_API_KEY")).toBe(true);
      expect(isSecretSetting("llmApiKey")).toBe(true);
      expect(isSecretSetting("GITHUB_PRIVATE_KEY")).toBe(true);
      expect(isSecretSetting("GITHUB_WEBHOOK_SECRET")).toBe(true);
      expect(isSecretSetting("GITHUB_PUBLIC_READ_TOKEN")).toBe(true);
      expect(isSecretSetting("CONSISTENCY_API_TOKEN")).toBe(true);
      expect(isSecretSetting("llmApiKey")).toBe(true);
      expect(isSecretSetting("privateKey")).toBe(true);
      expect(isSecretSetting("apiToken")).toBe(true);

      // Non-secrets must return false
      expect(isSecretSetting("workerConcurrency")).toBe(false);
      expect(isSecretSetting("databasePath")).toBe(false);
      expect(isSecretSetting("webUrl")).toBe(false);
      expect(isSecretSetting("provider")).toBe(false);
      expect(isSecretSetting("appId")).toBe(false);
    });

    it("returns configured: true and source, but NEVER returns plaintext for env secrets", () => {
      const plaintextSecret = "sk-super-secret-production-key-12345";
      const item = resolveEffectiveSetting("deepseekApiKey", {
        env: { DEEPSEEK_API_KEY: plaintextSecret }
      });

      expect(item.isSecret).toBe(true);
      expect(item.configured).toBe(true);
      expect(item.source).toBe("env");
      expect(item.readOnly).toBe(true);
      expect(item.overriddenByEnv).toBe(true);
      expect(item.value).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(item, "value")).toBe(false);

      const serialized = JSON.stringify(item);
      expect(serialized).not.toContain(plaintextSecret);
    });

    it("returns configured: true and source, but NEVER returns plaintext for file secrets", () => {
      const plaintextSecret = "file-secret-key-abcdef987654";
      const item = resolveEffectiveSetting("openaiApiKey", {
        env: {},
        file: { openaiApiKey: plaintextSecret }
      });

      expect(item.isSecret).toBe(true);
      expect(item.configured).toBe(true);
      expect(item.source).toBe("file");
      expect(item.readOnly).toBe(false);
      expect(item.editable).toBe(true);
      expect(item.value).toBeUndefined();

      const serialized = JSON.stringify(item);
      expect(serialized).not.toContain(plaintextSecret);
    });

    it("returns configured: false when secret is unset", () => {
      const item = resolveEffectiveSetting("anthropicApiKey", {
        env: {},
        file: {}
      });

      expect(item.isSecret).toBe(true);
      expect(item.configured).toBe(false);
      expect(item.source).toBe("default");
      expect(item.value).toBeUndefined();
    });

    it("ensures JSON.stringify of full effectiveSettings never leaks secrets", () => {
      const secrets = {
        DEEPSEEK_API_KEY: "sk-ds-leaktarg1",
        OPENAI_API_KEY: "sk-oa-leaktarg2",
        GITHUB_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA0leaktarg3\n-----END RSA PRIVATE KEY-----",
        GITHUB_WEBHOOK_SECRET: "whsec-leaktarg4",
        CONSISTENCY_API_TOKEN: "token-leaktarg5"
      };

      const result = resolveEffectiveSettings({
        env: secrets
      });

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("leaktarg1");
      expect(serialized).not.toContain("leaktarg2");
      expect(serialized).not.toContain("leaktarg3");
      expect(serialized).not.toContain("leaktarg4");
      expect(serialized).not.toContain("leaktarg5");
    });
  });

  describe("Integration with SettingsStore and edge cases (Requirement 5)", () => {
    it("works seamlessly with real SettingsStore encrypted secrets and public config", () => {
      const store = createTempStore();
      store.update({
        llm: {
          provider: "deepseek",
          deepseekApiKey: "encrypted-deepseek-key",
          deepseekModel: "deepseek-chat"
        },
        github: {
          appId: "gh-app-456",
          webhookSecret: "encrypted-webhook"
        },
        runtime: {
          workerConcurrency: 3,
          webUrl: "http://127.0.0.1:9000"
        }
      });

      // 1. Resolve purely from store without env overrides
      const fromStore = resolveEffectiveSettings({ store, env: {} });
      expect(fromStore.items.workerConcurrency!.value).toBe(3);
      expect(fromStore.items.workerConcurrency!.source).toBe("file");
      expect(fromStore.items.workerConcurrency!.readOnly).toBe(false);
      expect(fromStore.items.provider!.value).toBe("deepseek");
      expect(fromStore.items.provider!.source).toBe("file");
      expect(fromStore.items.deepseekApiKey!.configured).toBe(true);
      expect(fromStore.items.deepseekApiKey!.source).toBe("file");
      expect(fromStore.items.deepseekApiKey!.value).toBeUndefined();

      // 2. Resolve with env override
      const withEnv = resolveEffectiveSettings({
        store,
        env: {
          CONSISTENCY_WORKER_CONCURRENCY: "7",
          OPENAI_API_KEY: "env-openai-key"
        }
      });
      expect(withEnv.items.workerConcurrency!.value).toBe(7);
      expect(withEnv.items.workerConcurrency!.source).toBe("env");
      expect(withEnv.items.workerConcurrency!.readOnly).toBe(true);
      expect(withEnv.items.openaiApiKey!.configured).toBe(true);
      expect(withEnv.items.openaiApiKey!.source).toBe("env");
      expect(withEnv.items.openaiApiKey!.readOnly).toBe(true);
      expect(withEnv.items.openaiApiKey!.value).toBeUndefined();

      // 3. Via SettingsStore.effectiveSettings method
      const methodResult = store.effectiveSettings({ CONSISTENCY_WORKER_CONCURRENCY: "7" });
      expect(methodResult.items.workerConcurrency!.value).toBe(7);
      expect(methodResult.items.workerConcurrency!.source).toBe("env");
    });

    it("resolves nested file structures (e.g. { runtime: { workerConcurrency: 5 } })", () => {
      const result = resolveEffectiveSettings({
        env: {},
        file: {
          runtime: {
            workerConcurrency: 5,
            webUrl: "https://nested.local"
          },
          llm: {
            deepseekModel: "custom-v3"
          }
        }
      });

      expect(result.items.workerConcurrency!.value).toBe(5);
      expect(result.items.workerConcurrency!.source).toBe("file");
      expect(result.items.webUrl!.value).toBe("https://nested.local");
      expect(result.items.webUrl!.source).toBe("file");
      expect(result.items.deepseekModel!.value).toBe("custom-v3");
      expect(result.items.deepseekModel!.source).toBe("file");
    });

    it("supports lookup by canonical key, envVar, or alias via get()", () => {
      const result = resolveEffectiveSettings({
        env: { CONSISTENCY_WORKER_CONCURRENCY: "4" }
      });

      const byKey = result.get("workerConcurrency");
      const byEnv = result.get("CONSISTENCY_WORKER_CONCURRENCY");
      const byAlias = result.get("runtime.workerConcurrency");

      expect(byKey).toBeDefined();
      expect(byEnv).toBeDefined();
      expect(byAlias).toBeDefined();
      expect(byKey).toBe(byEnv);
      expect(byKey).toBe(byAlias);
    });

    it("categorizes settings in the structured view", () => {
      const result = resolveEffectiveSettings();
      expect(result.structured.runtime.workerConcurrency).toBeDefined();
      expect(result.structured.runtime.databasePath).toBeDefined();
      expect(result.structured.runtime.webUrl).toBeDefined();
      expect(result.structured.llm.provider).toBeDefined();
      expect(result.structured.llm.deepseekApiKey).toBeDefined();
      expect(result.structured.github.appId).toBeDefined();
      expect(result.structured.general.port).toBeDefined();
    });

    it("synthesizes dynamic definitions for custom keys while protecting custom secrets", () => {
      const customKeyItem = resolveEffectiveSetting("CUSTOM_THIRD_PARTY_SECRET", {
        env: { CUSTOM_THIRD_PARTY_SECRET: "ultra-secret-value" }
      });

      expect(customKeyItem.isSecret).toBe(true);
      expect(customKeyItem.configured).toBe(true);
      expect(customKeyItem.source).toBe("env");
      expect(customKeyItem.value).toBeUndefined();
      expect(JSON.stringify(customKeyItem)).not.toContain("ultra-secret-value");

      const customPublicItem = resolveEffectiveSetting("customFeatureFlag", {
        env: { CUSTOM_FEATURE_FLAG: "enabled" }
      });
      expect(customPublicItem.isSecret).toBe(false);
      expect(customPublicItem.value).toBe("enabled");
      expect(customPublicItem.source).toBe("env");
    });
  });
});
