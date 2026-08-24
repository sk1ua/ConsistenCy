import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettingsSnapshot } from "../api/client";
import { I18nProvider } from "../i18n";
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
    workerConcurrency: 1
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

  it("lists all 7 section nav items including disabled sections", () => {
    const html = renderDialog(true);
    expect(html).toContain("Models");
    expect(html).toContain("GitHub");
    expect(html).toContain("Reviews");
    expect(html).toContain("Runtime");
    expect(html).toContain("Appearance");
    expect(html).toContain("Desktop");
    expect(html).toContain("About");
  });

  it("marks disabled sections with the disabled class and coming-soon label", () => {
    const html = renderDialog(true);
    expect(html).toContain("settings-dialog-nav-item--disabled");
    expect(html).toContain("Coming soon");
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
