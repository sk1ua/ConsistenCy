import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore, toRendererSettings } from "./settings";

describe("SettingsStore", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function store(): SettingsStore {
    const directory = mkdtempSync(join(tmpdir(), "consistency-settings-"));
    directories.push(directory);
    return new SettingsStore(directory);
  }

  it("persists public settings and encrypts secrets", () => {
    const settings = store();
    settings.update({
      llm: { provider: "deepseek", deepseekApiKey: "secret-deepseek-key" },
      github: { appId: "123", webhookSecret: "secret-webhook-value", publicReadToken: "secret-public-token" },
      runtime: { workerConcurrency: 3 }
    });

    const publicText = readFileSync(settings.publicPath, "utf8");
    const encryptedText = readFileSync(settings.secretsPath, "utf8");
    expect(publicText).toContain('"GITHUB_APP_ID": "123"');
    expect(publicText).not.toContain("secret-deepseek-key");
    expect(encryptedText).not.toContain("secret-deepseek-key");
    expect(encryptedText).not.toContain("secret-webhook-value");
    expect(encryptedText).not.toContain("secret-public-token");
    expect(settings.savedEnvironment()).toMatchObject({
      LLM_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "secret-deepseek-key",
      GITHUB_WEBHOOK_SECRET: "secret-webhook-value",
      GITHUB_PUBLIC_READ_TOKEN: "secret-public-token",
      CONSISTENCY_WORKER_CONCURRENCY: "3"
    });
  });

  it("persists generic Pi provider credentials and model without exposing the key", () => {
    const settings = store();
    const snapshot = settings.update({
      llm: { provider: "xiaomi", llmModel: "mimo-v2.6-flash", llmApiKey: "xiaomi-test-secret" }
    });

    const publicText = readFileSync(settings.publicPath, "utf8");
    const encryptedText = readFileSync(settings.secretsPath, "utf8");
    expect(publicText).toContain('"LLM_PROVIDER": "xiaomi"');
    expect(publicText).toContain('"LLM_MODEL": "mimo-v2.6-flash"');
    expect(publicText).not.toContain("xiaomi-test-secret");
    expect(encryptedText).not.toContain("xiaomi-test-secret");
    expect(settings.savedEnvironment()).toMatchObject({
      LLM_PROVIDER: "xiaomi",
      LLM_MODEL: "mimo-v2.6-flash",
      LLM_API_KEY: "xiaomi-test-secret"
    });
    expect(snapshot.llm).toMatchObject({
      provider: "xiaomi",
      llmModel: "mimo-v2.6-flash",
      llmApiKeyConfigured: true,
      deepseekApiKeyConfigured: false,
      openaiApiKeyConfigured: false,
      anthropicApiKeyConfigured: false
    });
    expect(JSON.stringify(snapshot)).not.toContain("xiaomi-test-secret");
  });

  it("does not credit LLM_API_KEY to other providers when LLM_PROVIDER is set", () => {
    // LLM_PROVIDER=deepseek + LLM_API_KEY: only deepseekApiKeyConfigured should
    // be true; openai and anthropic must stay false.
    const settings = store();
    const snapshot = settings.update({
      llm: { provider: "deepseek", llmApiKey: "shared-key" }
    });
    expect(snapshot.llm.deepseekApiKeyConfigured).toBe(true);
    expect(snapshot.llm.openaiApiKeyConfigured).toBe(false);
    expect(snapshot.llm.anthropicApiKeyConfigured).toBe(false);
    expect(snapshot.llm.llmApiKeyConfigured).toBe(true);
  });

  it("scopes a generic key to the selected provider without hiding dedicated keys", () => {
    const settings = store();
    const snapshot = settings.snapshot({
      LLM_PROVIDER: "XIAOMI",
      LLM_API_KEY: "generic-key",
      DEEPSEEK_API_KEY: "deepseek-key"
    });
    expect(snapshot.llm).toMatchObject({
      provider: "xiaomi",
      llmApiKeyConfigured: true,
      deepseekApiKeyConfigured: true,
      openaiApiKeyConfigured: false,
      anthropicApiKeyConfigured: false
    });
  });

  it("lets environment variables override saved values without exposing secrets", () => {
    const settings = store();
    settings.update({ llm: { provider: "deepseek", deepseekApiKey: "saved-key" } });
    const snapshot = settings.snapshot({ LLM_PROVIDER: "openai", DEEPSEEK_API_KEY: "environment-key" });

    expect(snapshot.llm.provider).toBe("openai");
    expect(snapshot.llm.deepseekApiKeyConfigured).toBe(true);
    expect(snapshot.overriddenByEnvironment).toEqual(["DEEPSEEK_API_KEY", "LLM_PROVIDER"]);
    expect(JSON.stringify(snapshot)).not.toContain("saved-key");
    expect(JSON.stringify(snapshot)).not.toContain("environment-key");
  });

  it("keeps restart required after a changed save for this process but not a fresh store", () => {
    const settings = store();

    const saved = settings.update({
      llm: {
        provider: "deepseek",
        deepseekModel: "deepseek-v4-flash",
        deepseekApiKey: "saved-key"
      }
    });
    const subsequentRead = settings.snapshot({});
    const restartedProcess = new SettingsStore(settings.rootDirectory).snapshot({});

    expect(saved.restartRequired).toBe(true);
    expect(subsequentRead.restartRequired).toBe(true);
    expect(restartedProcess.restartRequired).toBe(false);
  });

  it("can clear a stored secret", () => {
    const settings = store();
    settings.update({ github: { webhookSecret: "configured", publicReadToken: "read-token" } });
    settings.update({ github: { webhookSecret: null, publicReadToken: null } });
    expect(settings.savedEnvironment().GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(settings.savedEnvironment().GITHUB_PUBLIC_READ_TOKEN).toBeUndefined();
  });

  it("projects filesystem configuration to renderer-safe status only", () => {
    const settings = store();
    const snapshot = settings.update({
      runtime: {
        databasePath: "D:/private/state/consistency.db",
        workspaceRoot: "D:/private/workspaces",
        localReviewRoots: "D:/customers/one,D:/customers/two"
      }
    });

    const renderer = toRendererSettings(snapshot);
    expect(renderer.runtime).toMatchObject({
      storage: { kind: "file", configured: true },
      workspace: { configured: true },
      localReview: { configured: true, rootCount: 2 }
    });
    expect(renderer.runtime).not.toHaveProperty("databasePath");
    expect(renderer.runtime).not.toHaveProperty("workspaceRoot");
    expect(renderer.runtime).not.toHaveProperty("localReviewRoots");
    expect(JSON.stringify(renderer)).not.toContain("D:/private");
    expect(JSON.stringify(renderer)).not.toContain("D:/customers");
  });

  it("reports local review as disabled when no roots are configured", () => {
    const settings = store();
    // No saved CONSISTENCY_LOCAL_REVIEW_ROOTS and none in the environment:
    // the legacy endpoint is disabled, so the renderer must not see roots.
    const snapshot = settings.snapshot({});
    const renderer = toRendererSettings(snapshot);
    expect(renderer.runtime.localReview).toEqual({ configured: false, rootCount: 0 });
  });
});
