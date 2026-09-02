// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { SettingsSnapshot } from "../api/client";
import { api } from "../api/client";
import { I18nProvider } from "../i18n";
import { ThemeProvider } from "../theme";
import { SettingsDialog } from "./SettingsDialog";
import { SecretField } from "./settings/SecretField";
import { emptySecrets, keepSecrets } from "../hooks/useSettingsForm";

const configuredSettings: SettingsSnapshot = {
  llm: {
    provider: "deepseek",
        anthropicModel: "",
        anthropicApiKeyConfigured: false,
        llmApiKeyConfigured: false,
        llmModel: "",
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

const health = {
  ok: true,
  service: "consistency-api",
  engine: "python",
  schemaVersion: "0.1.0",
  database: { ok: true },
  worker: { running: true, activeJobs: 0, concurrency: 1 },
  llmProvider: "deepseek",
  llmModel: "deepseek-chat",
  publicPrAccessMode: "anonymous" as const,
  configuration: {
    githubAppConfigured: true,
    webhookSecretConfigured: true,
    publicReadTokenConfigured: true,
    storage: { kind: "file" as const, configured: true },
    workerConcurrency: 1,
    reviewWorkflow: "pr-review"
  }
};

function renderDialog(open: boolean): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en-US">
      <SettingsDialog
        isOpen={open}
        onClose={() => undefined}
        health={health}
      />
    </I18nProvider>
  );
}

describe("SettingsDialog", () => {
  it("does not render any dialog DOM when closed", () => {
    expect(renderDialog(false)).not.toContain("ds-dialog");
  });

  it("renders a four-section workbench navigation", () => {
    const html = renderDialog(true);
    expect(html).toContain("ds-dialog--settings");
    for (const label of ["General", "Reviews", "Appearance", "About"]) expect(html).toContain(label);
    expect(html.match(/<button[^>]*settings-dialog-nav-item[^>]*>/g) ?? []).toHaveLength(4);
    expect(html).not.toContain("settings-dialog-nav-item--disabled");
    expect(html).not.toContain("Coming soon");
  });

  it("uses General as the default and exposes advanced settings only on demand", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const settingsSpy = vi.spyOn(api, "settings").mockResolvedValue(configuredSettings);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(<I18nProvider initialLocale="en-US"><SettingsDialog isOpen onClose={() => undefined} health={health} /></I18nProvider>);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Choose the model used");
    expect(container.textContent).toContain("Sign in with GitHub");
    expect(container.querySelector("#setting-concurrency")).toBeNull();
    expect(container.querySelector("#setting-app-id")).toBeNull();
    expect(container.querySelector("#setting-desktop-close")).toBeNull();

    const advanced = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Show advanced"));
    expect(advanced).toBeTruthy();
    expect(advanced?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { advanced?.click(); });

    expect(container.querySelector("#setting-concurrency")).toBeTruthy();
    expect(container.querySelector("#setting-app-id")).toBeTruthy();
    expect(container.querySelector("#setting-desktop-close")).toBeTruthy();
    expect(advanced?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => { root.unmount(); });
    settingsSpy.mockRestore();
    document.body.removeChild(container);
  });

  it("renders Reviews, Appearance and About through their four nav items", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const settingsSpy = vi.spyOn(api, "settings").mockResolvedValue(configuredSettings);
    window.localStorage.clear?.();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(<ThemeProvider><I18nProvider initialLocale="en-US"><SettingsDialog isOpen onClose={() => undefined} health={health} /></I18nProvider></ThemeProvider>);
      await Promise.resolve();
    });

    const nav = () => [...container.querySelectorAll<HTMLButtonElement>(".settings-dialog-nav-item")];
    await act(async () => { nav().find(button => button.textContent?.startsWith("Reviews"))?.click(); });
    expect(container.querySelector("#setting-reviews-model")).toBeTruthy();

    await act(async () => { nav().find(button => button.textContent?.startsWith("Appearance"))?.click(); });
    expect(container.querySelectorAll(".settings-dialog-content .ds-select-menu")).toHaveLength(2);
    expect(container.querySelector("#setting-density")).toBeTruthy();

    await act(async () => { nav().find(button => button.textContent?.startsWith("About"))?.click(); });
    expect(container.querySelector("#setting-about-service")?.textContent).toContain("consistency-api");
    expect(container.querySelector("#setting-about-mode")?.textContent).toContain("Browser");

    await act(async () => { root.unmount(); });
    settingsSpy.mockRestore();
    document.body.removeChild(container);
  });

  it("keeps Appearance reachable when the settings API fails", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const settingsSpy = vi.spyOn(api, "settings").mockRejectedValue(new Error("settings API failed"));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(<ThemeProvider><I18nProvider initialLocale="en-US"><SettingsDialog isOpen onClose={() => undefined} health={health} /></I18nProvider></ThemeProvider>);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Configuration editor is unavailable");
    const appearance = [...container.querySelectorAll<HTMLButtonElement>(".settings-dialog-nav-item")].find(button => button.textContent?.startsWith("Appearance"));
    await act(async () => { appearance?.click(); });
    expect(container.querySelectorAll(".settings-dialog-content .ds-select-menu")).toHaveLength(2);
    expect(container.querySelector(".settings-dialog-content .empty-state")).toBeNull();
    await act(async () => { root.unmount(); });
    settingsSpy.mockRestore();
    document.body.removeChild(container);
  });

  it("renders the dialog footer with design-system Save and Reset buttons", () => {
    const html = renderDialog(true);
    expect(html).toContain("Save settings");
    expect(html).toContain("Reset changes");
    expect(html).toContain("ds-button");
  });
});

describe("SettingsDialog secret non-disclosure (INV-2 / Amendment 6)", () => {
  it("does not expose stored secret plaintext in the SecretField when configured=true", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en-US">
        <SecretField
          name="deepseekApiKey"
          label="DeepSeek API key"
          configured={true}
          value={emptySecrets.deepseekApiKey}
          clear={keepSecrets.deepseekApiKey}
          help="help text"
          onValue={() => undefined}
          onClear={() => undefined}
        />
      </I18nProvider>
    );
    // Configured badge shows "Saved" — no actual key value in the DOM
    expect(html).toContain("Saved");
    expect(html).not.toMatch(/ghp_[A-F0-9]{36}/i);
    expect(html).not.toMatch(/-----BEGIN (RSA |EC )?PRIVATE KEY-----/);
    // The password input value must be empty (no plaintext)
    expect(html).not.toContain('value="ghp_');
  });

  it("leaves the secret input empty with a keep-stored-value placeholder when configured", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en-US">
        <SecretField
          name="publicReadToken"
          label="Public read token"
          configured={true}
          value={emptySecrets.publicReadToken}
          clear={keepSecrets.publicReadToken}
          help="help text"
          onValue={() => undefined}
          onClear={() => undefined}
        />
      </I18nProvider>
    );
    expect(html).toContain("Leave blank to keep the stored value");
    // No value attribute containing a token pattern
    expect(html).not.toMatch(/value="[^"]*token[^"]*"/i);
  });

  it("shows the not-configured state when a credential is absent", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en-US">
        <SecretField
          name="openaiApiKey"
          label="OpenAI API key"
          configured={false}
          value={emptySecrets.openaiApiKey}
          clear={keepSecrets.openaiApiKey}
          help="help text"
          onValue={() => undefined}
          onClear={() => undefined}
        />
      </I18nProvider>
    );
    expect(html).toContain("Not configured");
    expect(html).toContain("Enter a new secret");
  });
});
