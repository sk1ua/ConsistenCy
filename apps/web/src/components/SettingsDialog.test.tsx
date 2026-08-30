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
    const html = renderDialog(false);
    expect(html).not.toContain("ds-dialog");
    expect(html).not.toContain("settings-dialog");
  });

  it("renders the dialog shell with the settings sizing class when open", () => {
    const html = renderDialog(true);
    expect(html).toContain("ds-dialog--settings");
    expect(html).toContain("settings-dialog-nav");
  });

  it("lists all 7 section nav items", () => {
    const html = renderDialog(true);
    expect(html).toContain("Models");
    expect(html).toContain("GitHub");
    expect(html).toContain("Reviews");
    expect(html).toContain("Runtime");
    expect(html).toContain("Appearance");
    expect(html).toContain("Desktop");
    expect(html).toContain("About");
  });

  it("enables all 7 nav sections — no disabled item and no coming-soon label remains", () => {
    const html = renderDialog(true);
    expect(html).not.toContain("settings-dialog-nav-item--disabled");
    expect(html).not.toContain("Coming soon");
    expect(html.match(/<small>Coming soon<\/small>/g) ?? []).toHaveLength(0);
    const navButtons = html.match(/<button[^>]*settings-dialog-nav-item[^>]*>/g) ?? [];
    expect(navButtons).toHaveLength(7);
    for (const button of navButtons) expect(button).not.toContain("disabled");
  });

  it("enables the Runtime nav item without a disabled state or coming-soon label", () => {
    const html = renderDialog(true);
    const runtimeButton = html.match(/<button[^>]*><span>Runtime<\/span><\/button>/)?.[0] ?? "";
    expect(runtimeButton).not.toBe("");
    expect(runtimeButton).not.toContain("disabled");
    expect(runtimeButton).not.toContain("settings-dialog-nav-item--disabled");
    expect(runtimeButton).not.toContain("Coming soon");
  });

  it("enables the Appearance nav item without a disabled state or coming-soon label", () => {
    const html = renderDialog(true);
    const appearanceButton = html.match(/<button[^>]*><span>Appearance<\/span><\/button>/)?.[0] ?? "";
    expect(appearanceButton).not.toBe("");
    expect(appearanceButton).not.toContain("disabled");
    expect(appearanceButton).not.toContain("settings-dialog-nav-item--disabled");
    expect(appearanceButton).not.toContain("Coming soon");
  });

  it("renders the Models section as the default active section", () => {
    const html = renderDialog(true);
    expect(html).toContain("settings-dialog-nav-item--active");
  });

  it("renders the dialog footer with Save and Reset buttons", () => {
    const html = renderDialog(true);
    expect(html).toContain("Save settings");
    expect(html).toContain("Reset changes");
  });

  it("renders the shared Runtime section when the Runtime nav item is clicked", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const settingsSpy = vi.spyOn(api, "settings").mockResolvedValue(configuredSettings);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en-US">
          <SettingsDialog isOpen onClose={() => undefined} health={health} />
        </I18nProvider>
      );
      await Promise.resolve();
    });

    const runtimeButton = [...container.querySelectorAll<HTMLButtonElement>(".settings-dialog-nav-item")]
      .find(button => button.textContent?.startsWith("Runtime"));
    expect(runtimeButton).toBeTruthy();
    expect(runtimeButton?.disabled).toBe(false);

    await act(async () => {
      runtimeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector<HTMLInputElement>("#setting-concurrency")).toBeTruthy();
    expect(container.querySelector<HTMLInputElement>("#setting-poll")).toBeTruthy();
    expect(container.querySelector<HTMLInputElement>("#setting-web-url")).toBeTruthy();
    expect(container.querySelector(".settings-dialog-content .settings-group-title h3")?.textContent).toBe("Local service");
    expect(container.querySelector(".settings-dialog-content .empty-state")).toBeNull();

    await act(async () => { root.unmount(); });
    settingsSpy.mockRestore();
    document.body.removeChild(container);
  });

  it("renders the read-only Reviews section when the Reviews nav item is clicked", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const settingsSpy = vi.spyOn(api, "settings").mockResolvedValue(configuredSettings);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en-US">
          <SettingsDialog isOpen onClose={() => undefined} health={health} />
        </I18nProvider>
      );
      await Promise.resolve();
    });

    const reviewsButton = [...container.querySelectorAll<HTMLButtonElement>(".settings-dialog-nav-item")]
      .find(button => button.textContent?.startsWith("Reviews"));
    expect(reviewsButton).toBeTruthy();
    expect(reviewsButton?.disabled).toBe(false);

    await act(async () => {
      reviewsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector(".settings-dialog-content .settings-group-title h3")?.textContent).toBe("Review defaults");
    expect(container.querySelector("#setting-reviews-model")).toBeTruthy();
    expect(container.querySelector("#setting-reviews-workflow")?.textContent).toContain("pr-review");
    expect(container.querySelector("#setting-reviews-context")).toBeTruthy();
    expect(container.querySelector("#setting-reviews-concurrency")).toBeTruthy();
    expect(container.querySelector("#setting-reviews-other")).toBeTruthy();
    // Read-only status: no interactive control inside the section.
    expect(container.querySelectorAll(".settings-dialog-content select, .settings-dialog-content input, .settings-dialog-content textarea")).toHaveLength(0);
    expect(container.querySelector(".settings-dialog-content .empty-state")).toBeNull();

    await act(async () => { root.unmount(); });
    settingsSpy.mockRestore();
    document.body.removeChild(container);
  });

  it("renders the shared Appearance section when the Appearance nav item is clicked", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const settingsSpy = vi.spyOn(api, "settings").mockResolvedValue(configuredSettings);
    window.localStorage.clear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <ThemeProvider>
          <I18nProvider initialLocale="en-US">
            <SettingsDialog isOpen onClose={() => undefined} health={health} />
          </I18nProvider>
        </ThemeProvider>
      );
      await Promise.resolve();
    });

    const appearanceButton = [...container.querySelectorAll<HTMLButtonElement>(".settings-dialog-nav-item")]
      .find(button => button.textContent?.startsWith("Appearance"));
    expect(appearanceButton).toBeTruthy();
    expect(appearanceButton?.disabled).toBe(false);

    await act(async () => {
      appearanceButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector<HTMLSelectElement>("#setting-theme")).toBeTruthy();
    expect(container.querySelector<HTMLSelectElement>("#setting-locale")).toBeTruthy();
    expect(container.querySelector("#setting-density")).toBeTruthy();
    expect(container.querySelector(".settings-dialog-content .empty-state")).toBeNull();

    await act(async () => { root.unmount(); });
    settingsSpy.mockRestore();
    document.body.removeChild(container);
  });

  it("keeps Appearance reachable when the settings API fails while form sections degrade to the empty state", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const settingsSpy = vi.spyOn(api, "settings").mockRejectedValue(new Error("settings API failed"));
    window.localStorage.clear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <ThemeProvider>
          <I18nProvider initialLocale="en-US">
            <SettingsDialog isOpen onClose={() => undefined} health={health} />
          </I18nProvider>
        </ThemeProvider>
      );
      await Promise.resolve();
    });

    // Default models section with a failed settings fetch: exactly one
    // Configuration-unavailable empty-state is what every form section shows.
    const emptyStates = container.querySelectorAll(".settings-dialog-content .empty-state");
    expect(emptyStates).toHaveLength(1);
    expect(emptyStates[0]?.textContent).toContain("Configuration editor is unavailable");

    const appearanceButton = [...container.querySelectorAll<HTMLButtonElement>(".settings-dialog-nav-item")]
      .find(button => button.textContent?.startsWith("Appearance"));
    expect(appearanceButton).toBeTruthy();
    expect(appearanceButton?.disabled).toBe(false);

    await act(async () => {
      appearanceButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Appearance is renderer-local: the theme control renders without the
    // settings snapshot and the empty state is gone.
    expect(container.querySelector<HTMLSelectElement>("#setting-theme")).toBeTruthy();
    expect(container.querySelector(".settings-dialog-content .empty-state")).toBeNull();

    await act(async () => { root.unmount(); });
    settingsSpy.mockRestore();
    document.body.removeChild(container);
  });

  it("renders the Desktop section with disabled real switches when the Desktop nav item is clicked (browser mode)", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const settingsSpy = vi.spyOn(api, "settings").mockResolvedValue(configuredSettings);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en-US">
          <SettingsDialog isOpen onClose={() => undefined} health={health} />
        </I18nProvider>
      );
      await Promise.resolve();
    });

    const desktopButton = [...container.querySelectorAll<HTMLButtonElement>(".settings-dialog-nav-item")]
      .find(button => button.textContent?.startsWith("Desktop"));
    expect(desktopButton).toBeTruthy();
    expect(desktopButton?.disabled).toBe(false);

    await act(async () => {
      desktopButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector(".settings-dialog-content .settings-group-title h3")?.textContent).toBe("Desktop app behavior");
    expect(container.querySelector("#setting-desktop-close")).toBeTruthy();
    expect(container.querySelector("#setting-desktop-tray")).toBeTruthy();
    expect(container.querySelector("#setting-desktop-autostart")).toBeTruthy();
    expect(container.querySelector("#setting-desktop-notifications")).toBeTruthy();
    // No desktop bridge in the test environment → browser-mode note renders
    // and the real switches stay disabled; notifications has no switch at all.
    expect(container.querySelector("#setting-desktop-browser-note")).toBeTruthy();
    expect(container.querySelectorAll('.settings-dialog-content [role="switch"]')).toHaveLength(3);
    for (const element of container.querySelectorAll<HTMLButtonElement>('.settings-dialog-content [role="switch"]')) {
      expect(element.disabled).toBe(true);
    }
    expect(container.querySelector('#setting-desktop-notifications [role="switch"]')).toBeNull();
    expect(container.querySelectorAll(".settings-dialog-content select, .settings-dialog-content input, .settings-dialog-content textarea")).toHaveLength(0);
    expect(container.querySelector(".settings-dialog-content .empty-state")).toBeNull();

    await act(async () => { root.unmount(); });
    settingsSpy.mockRestore();
    document.body.removeChild(container);
  });

  it("renders the read-only About section when the About nav item is clicked (browser mode)", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const settingsSpy = vi.spyOn(api, "settings").mockResolvedValue(configuredSettings);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en-US">
          <SettingsDialog isOpen onClose={() => undefined} health={health} />
        </I18nProvider>
      );
      await Promise.resolve();
    });

    const aboutButton = [...container.querySelectorAll<HTMLButtonElement>(".settings-dialog-nav-item")]
      .find(button => button.textContent?.startsWith("About"));
    expect(aboutButton).toBeTruthy();
    expect(aboutButton?.disabled).toBe(false);

    await act(async () => {
      aboutButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector(".settings-dialog-content .settings-group-title h3")?.textContent).toBe("Version and environment");
    // Browser mode: no buildInfo bridge → desktop-only note on the build rows.
    expect(container.querySelector("#setting-about-version")?.textContent).toContain("Provided by the desktop build only.");
    expect(container.querySelector("#setting-about-build")?.textContent).toContain("Provided by the desktop build only.");
    // Health-derived rows stay grounded in the /health payload.
    expect(container.querySelector("#setting-about-service")?.textContent).toContain("consistency-api");
    expect(container.querySelector("#setting-about-engine")?.textContent).toContain("python");
    expect(container.querySelector("#setting-about-schema")?.textContent).toContain("0.1.0");
    expect(container.querySelector("#setting-about-mode")?.textContent).toContain("Browser");
    expect(container.querySelector(".settings-dialog-content .empty-state")).toBeNull();

    await act(async () => { root.unmount(); });
    settingsSpy.mockRestore();
    document.body.removeChild(container);
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
