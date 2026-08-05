import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "./settings";

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

  it("lets environment variables override saved values without exposing secrets", () => {
    const settings = store();
    settings.update({ llm: { provider: "deepseek", deepseekApiKey: "saved-key" } });
    const snapshot = settings.snapshot({ LLM_PROVIDER: "mock", DEEPSEEK_API_KEY: "environment-key" });

    expect(snapshot.llm.provider).toBe("mock");
    expect(snapshot.llm.deepseekApiKeyConfigured).toBe(true);
    expect(snapshot.overriddenByEnvironment).toEqual(["DEEPSEEK_API_KEY", "LLM_PROVIDER"]);
    expect(JSON.stringify(snapshot)).not.toContain("saved-key");
    expect(JSON.stringify(snapshot)).not.toContain("environment-key");
  });

  it("can clear a stored secret", () => {
    const settings = store();
    settings.update({ github: { webhookSecret: "configured", publicReadToken: "read-token" } });
    settings.update({ github: { webhookSecret: null, publicReadToken: null } });
    expect(settings.savedEnvironment().GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(settings.savedEnvironment().GITHUB_PUBLIC_READ_TOKEN).toBeUndefined();
  });
});
