/**
 * SettingsPage contract tests for the Active-runtime "Public PR access" row
 * (CKPT4 Phase 2C). The row must render the same mode mapping as the GitHub
 * settings section: pat -> "PAT read", anonymous -> "Anonymous read", and —
 * matching the server truth (analysis disabled) and legacy payloads without
 * the field -> "Disabled" with a negative state, never an implicit anonymous
 * read claim. The api client seam is mocked; no network is touched.
 */
// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { api, type HealthResponse, type SettingsSnapshot } from "../api/client";
import { I18nProvider } from "../i18n";
import { SettingsPage } from "./SettingsPage";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: { ...actual.api, settings: vi.fn() }
  };
});

const settingsMock = vi.mocked(api.settings);

const savedSettings: SettingsSnapshot = {
  llm: {
    provider: "deepseek",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-chat",
    openaiModel: "",
    deepseekApiKeyConfigured: true,
    openaiApiKeyConfigured: false
  },
  github: {
    appId: "",
    privateKeyConfigured: false,
    webhookSecretConfigured: false,
    publicReadTokenConfigured: true
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

function makeHealth(publicPrAccessMode?: HealthResponse["publicPrAccessMode"]): HealthResponse {
  return {
    ok: true,
    service: "consistency-api",
    database: { ok: true },
    worker: { running: true, activeJobs: 0, concurrency: 1 },
    llmProvider: "deepseek",
    ...(publicPrAccessMode === undefined ? {} : { publicPrAccessMode }),
    configuration: {
      githubAppConfigured: false,
      webhookSecretConfigured: false,
      publicReadTokenConfigured: true,
      storage: { kind: "file", configured: true },
      workerConcurrency: 1
    }
  };
}

async function mountPage(health: HealthResponse): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  settingsMock.mockResolvedValue(savedSettings);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(I18nProvider, { initialLocale: "en-US", children: createElement(SettingsPage, { health }) }));
  });
  // Flush the async settings load so the page leaves its loading state.
  await act(async () => {});
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      document.body.removeChild(container);
    }
  };
}

function accessRow(html: string): string {
  // Anchor inside the "Active runtime" config list: the GitHub settings
  // section repeats both labels further up the page.
  const scoped = html.slice(html.indexOf("settings-status"));
  const start = scoped.indexOf("Public PR access");
  const end = scoped.indexOf("Public read token", start);
  return scoped.slice(start, end);
}

describe("SettingsPage Public PR access row mapping", () => {
  it("renders PAT read as an ok state", async () => {
    const page = await mountPage(makeHealth("pat"));
    try {
      const row = accessRow(page.container.innerHTML);
      expect(row).toContain("PAT read");
      expect(row).toMatch(/class="[^"]*\bok\b/);
    } finally {
      await page.unmount();
    }
  });

  it("renders Anonymous read as an ok state", async () => {
    const page = await mountPage(makeHealth("anonymous"));
    try {
      const row = accessRow(page.container.innerHTML);
      expect(row).toContain("Anonymous read");
      expect(row).toMatch(/class="[^"]*\bok\b/);
    } finally {
      await page.unmount();
    }
  });

  it("fails closed to Disabled for the disabled mode and for legacy payloads without the field", async () => {
    for (const health of [makeHealth("disabled"), makeHealth(undefined)]) {
      const page = await mountPage(health);
      try {
        const row = accessRow(page.container.innerHTML);
        expect(row).toContain("Disabled");
        expect(row).not.toContain("Anonymous read");
        expect(row).not.toContain("PAT read");
        expect(row).toMatch(/class="[^"]*\bbad\b/);
        expect(row).not.toMatch(/class="[^"]*\bok\b/);
      } finally {
        await page.unmount();
      }
    }
  });
});
