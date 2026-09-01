// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { HealthResponse, SettingsPatch, SettingsSnapshot } from "../api/client";
import type { ConsistencyDesktopBridge, DesktopCredentialKey, DesktopCredentialStatus } from "../desktop";
import { I18nProvider } from "../i18n";
import {
  buildSettingsPatch,
  computeReadiness,
  emptySecrets,
  keepSecrets,
  publicPrAccessModeView,
  secretValue,
  useSettingsForm,
  withDesktopCredentialStatus,
  type SecretDrafts,
  type ClearSecrets,
  type SecretName,
  type UseSettingsFormOptions,
  type UseSettingsFormResult
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
    oauthClientId: "",
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

const clearedStatus: DesktopCredentialStatus = {
  DEEPSEEK_API_KEY: false,
  OPENAI_API_KEY: false,
  GITHUB_PRIVATE_KEY: false,
  GITHUB_WEBHOOK_SECRET: false,
  GITHUB_PUBLIC_READ_TOKEN: false
};

function makeBridge(writes: DesktopCredentialKey[]): ConsistencyDesktopBridge {
  return {
    appVersion: async () => "0.0.0",
    selectRepository: async () => ({ canceled: true }),
    credentialStatus: async () => clearedStatus,
    setCredential: async key => {
      writes.push(key);
      return { ...clearedStatus, [key]: true };
    },
    showFromTray: async () => ({ visible: true })
  };
}

interface HookHarness {
  current: () => UseSettingsFormResult;
  unmount: () => Promise<void>;
}

async function mountSettingsForm(options: UseSettingsFormOptions = {}): Promise<HookHarness> {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let latest!: UseSettingsFormResult;
  function Harness() {
    latest = useSettingsForm(options);
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(I18nProvider, { initialLocale: "en-US", children: createElement(Harness) }));
  });
  return {
    current: () => latest,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      document.body.removeChild(container);
    }
  };
}

describe("publicPrAccessModeView", () => {
  it("maps every server mode onto a label key and ok state, treating unknown as disabled", () => {
    expect(publicPrAccessModeView("pat")).toEqual({ labelKey: "PAT read", ok: true });
    expect(publicPrAccessModeView("anonymous")).toEqual({ labelKey: "Anonymous read", ok: true });
    expect(publicPrAccessModeView("disabled")).toEqual({ labelKey: "Disabled", ok: false });
    // Legacy /health payloads predate the field entirely. The server derives
    // the mode from the analysis flag, so an absent field cannot honestly
    // claim anonymous read access — it must fail closed to "Disabled".
    expect(publicPrAccessModeView(undefined)).toEqual({ labelKey: "Disabled", ok: false });
  });
});

describe("save() restart honesty on the desktop bridge path", () => {
  function bridgeDeps(options?: { restartRequired?: boolean; writes?: DesktopCredentialKey[] }) {
    const patches: SettingsPatch[] = [];
    return {
      patches,
      deps: {
        fetchSettings: async () => baseSettings,
        updateSettings: async (patch: SettingsPatch) => {
          patches.push(patch);
          return { ...baseSettings, restartRequired: options?.restartRequired ?? false };
        },
        bridge: makeBridge(options?.writes ?? [])
      } satisfies UseSettingsFormOptions["deps"]
    };
  }

  it("marks a local restart as needed after the bridge stored a changed credential", async () => {
    const writes: DesktopCredentialKey[] = [];
    const { deps, patches } = bridgeDeps({ writes });
    const harness = await mountSettingsForm({ deps });

    await act(async () => { harness.current().updateSecret(GH_KEY_TOKEN, "ghp_test_fake"); });
    expect(harness.current().restartNeeded).toBe(false);

    await act(async () => { await harness.current().save(); });

    // The patch must still exclude secrets (bridge boundary), the bridge must
    // have received exactly one write, and the local banner must appear even
    // though the server never saw a persisted change of its own.
    expect((patches[0]?.github as Record<string, unknown>)?.[GH_KEY_TOKEN]).toBeUndefined();
    expect(writes).toEqual(["GITHUB_PUBLIC_READ_TOKEN"]);
    expect(harness.current().restartNeeded).toBe(true);

    await harness.unmount();
  });

  it("keeps reporting the server flag when the save changed no credential", async () => {
    const writes: DesktopCredentialKey[] = [];
    const { deps, patches } = bridgeDeps({ restartRequired: false, writes });
    const harness = await mountSettingsForm({ deps });

    await act(async () => { harness.current().updateGithub({ appId: "777777" }); });
    await act(async () => { await harness.current().save(); });

    expect(patches[0]?.github?.appId).toBe("777777");
    expect(writes).toEqual([]);
    expect(harness.current().restartNeeded).toBe(false);

    await harness.unmount();
  });

  it("still surfaces a server-declared restart for non-credential saves through the bridge", async () => {
    const writes: DesktopCredentialKey[] = [];
    const { deps } = bridgeDeps({ restartRequired: true, writes });
    const harness = await mountSettingsForm({ deps });

    await act(async () => { await harness.current().save(); });

    expect(writes).toEqual([]);
    expect(harness.current().restartNeeded).toBe(true);

    await harness.unmount();
  });
});

describe("applyGitHubOauthToken one-time handoff", () => {
  function oauthDeps(options?: { restartRequired?: boolean; writes?: DesktopCredentialKey[] }) {
    const patches: SettingsPatch[] = [];
    return {
      patches,
      deps: {
        fetchSettings: async () => baseSettings,
        updateSettings: async (patch: SettingsPatch) => {
          patches.push(patch);
          return { ...baseSettings, restartRequired: options?.restartRequired ?? false };
        },
        ...(options?.writes ? { bridge: makeBridge(options.writes) } : {})
      } satisfies UseSettingsFormOptions["deps"]
    };
  }

  it("persists the OAuth token through the encrypted settings path without a bridge", async () => {
    const { deps, patches } = oauthDeps();
    const harness = await mountSettingsForm({ deps });

    await act(async () => { await harness.current().applyGitHubOauthToken("gho_oauth_secret"); });

    // Web mode: the token rides in the patch body (the API stores it
    // AES-256-GCM encrypted) and the snapshot turns on tokenConfigured only
    // through the server response, so the handoff leaves no visible draft.
    expect((patches[0]?.github as Record<string, unknown>)?.publicReadToken).toBe("gho_oauth_secret");
    expect(harness.current().secrets.publicReadToken).toBe("");
    expect(harness.current().restartNeeded).toBe(false);

    await harness.unmount();
  });

  it("routes the OAuth token through the protected bridge in desktop mode", async () => {
    const writes: DesktopCredentialKey[] = [];
    const { deps, patches } = oauthDeps({ writes });
    const harness = await mountSettingsForm({ deps });

    await act(async () => { await harness.current().applyGitHubOauthToken("gho_oauth_secret"); });

    expect(writes).toEqual(["GITHUB_PUBLIC_READ_TOKEN"]);
    expect((patches[0]?.github as Record<string, unknown>)?.publicReadToken).toBeUndefined();
    expect(harness.current().restartNeeded).toBe(true);

    await harness.unmount();
  });
});
