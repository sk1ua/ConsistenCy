import { Github, PlugZap } from "lucide-react";
import { useState } from "react";
import type { GitHubConnectionTestResponse, GitHubConnectionTestStatus } from "@consistency/schema";
import { api, type HealthResponse, type SettingsSnapshot } from "../../api/client";
import { desktopBridge } from "../../desktop";
import { publicPrAccessModeView } from "../../hooks/useSettingsForm";
import type { SecretDrafts, ClearSecrets, SecretName } from "../../hooks/useSettingsForm";
import { useI18n } from "../../i18n";
import { SettingHelp, SETTING_HELP_LINKS } from "../SettingHelp";
import { GitHubOauthSignIn } from "./GitHubOauthSignIn";
import { SecretField } from "./SecretField";
import { Button } from "../../design-system/Button";

export interface GitHubSettingsSectionProps {
  draft: SettingsSnapshot;
  settings: SettingsSnapshot;
  secrets: SecretDrafts;
  clearSecrets: ClearSecrets;
  updateGithub: (patch: Partial<SettingsSnapshot["github"]>) => void;
  updateSecret: (name: SecretName, value: string) => void;
  updateClear: (name: SecretName, value: boolean) => void;
  /** One-time OAuth token handoff for the Web Device Flow compatibility path. */
  applyGitHubOauthToken: (token: string) => Promise<void>;
  /** Desktop main-process OAuth completion; no token crosses into the renderer. */
  applyGitHubDesktopOauth?: (login: string) => Promise<void>;
  /** ACTIVE runtime truth from /health; the status rows hide when absent. */
  health?: HealthResponse;
  /** True while saved settings await a restart; the probe tests the running config. */
  restartPending?: boolean;
  /** Core shows OAuth + live test; advanced shows GitHub App automation fields. */
  mode?: "all" | "core" | "advanced";
}

type ConnectionTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "done"; result: GitHubConnectionTestResponse }
  | { phase: "error" };

function connectionStatusLabelKey(status: GitHubConnectionTestStatus): string {
  switch (status) {
    case "connected": return "Connected";
    case "anonymous_available": return "Anonymous access available";
    case "invalid_credential": return "Credential rejected";
    case "rate_limited": return "Rate limited";
    case "unavailable": return "GitHub unavailable";
    case "not_configured": return "Not configured";
  }
}

function connectionStatusBadgeClass(status: GitHubConnectionTestStatus): string {
  switch (status) {
    case "connected": return "badge badge-succeeded";
    case "anonymous_available": return "badge badge-info";
    case "invalid_credential": return "badge badge-critical";
    case "rate_limited": return "badge badge-medium";
    case "unavailable": return "badge badge-hypothesis";
    case "not_configured": return "badge";
  }
}

function ConnectionTestResult({ result }: { result: GitHubConnectionTestResponse }) {
  const { t } = useI18n();
  return <>
    <span className={connectionStatusBadgeClass(result.status)}>{t(connectionStatusLabelKey(result.status))}</span>
    {result.status === "rate_limited" && result.retryAfterMs !== undefined && (
      <> {t("Retry available in {minutes} min", { minutes: Math.max(1, Math.ceil(result.retryAfterMs / 60_000)) })}</>
    )}
  </>;
}

export function GitHubSettingsSection({
  draft,
  secrets,
  clearSecrets,
  settings,
  updateGithub,
  updateSecret,
  updateClear,
  applyGitHubOauthToken,
  applyGitHubDesktopOauth,
  health,
  restartPending,
  mode = "all"
}: GitHubSettingsSectionProps) {
  const { t } = useI18n();
  const [testState, setTestState] = useState<ConnectionTestState>({ phase: "idle" });

  // Explicit-only probe: no auto-run on mount (anonymous quota is shared and
  // bounded). Each click performs exactly one read-only request through the
  // API against the ACTIVE runtime credential.
  async function runConnectionTest(): Promise<void> {
    setTestState({ phase: "testing" });
    try {
      const result = await api.testGitHubConnection();
      setTestState({ phase: "done", result });
    } catch {
      setTestState({ phase: "error" });
    }
  }

  return <section className="settings-group section-block">
    <div className="settings-group-title"><Github size={18} /><div><h3>{t("GitHub")}</h3><p>{t("Sign in through github.com; add GitHub App automation only when you need it.")}</p></div></div>
    <div className="settings-fields">
      <GitHubOauthSignIn
        restartPending={Boolean(restartPending)}
        desktopOAuth={desktopBridge()?.githubOAuth}
        onDesktopConnected={applyGitHubDesktopOauth}
        onConnected={applyGitHubOauthToken}
      />
      {mode !== "advanced" && (
        <div className="setting-field setting-field-wide setting-note github-live-test" id="setting-github-status-test">
          <PlugZap size={17} />
          <div>
            <strong>{t("Live connection test")}</strong>
            <p id="setting-github-status-result" role="status">
              {testState.phase === "idle" && t("Not tested yet")}
              {testState.phase === "testing" && t("Testing…")}
              {testState.phase === "error" && <span className="badge badge-failed">{t("Connection test unavailable")}</span>}
              {testState.phase === "done" && <ConnectionTestResult result={testState.result} />}
              {testState.phase === "done" && health && (
                <span className="github-access-mode"> {t("Public PR access")}: {t(publicPrAccessModeView(health.publicPrAccessMode).labelKey)}</span>
              )}
            </p>
            {restartPending && (
              <p className="github-restart-hint">{t("Tests use the running configuration. Restart to apply saved changes.")}</p>
            )}
            <Button type="button" id="setting-github-test" variant="outline" size="sm" icon={<PlugZap size={13} />} loading={testState.phase === "testing"} aria-describedby="setting-github-test-help" onClick={() => void runConnectionTest()}>{t(testState.phase === "testing" ? "Testing…" : "Test Connection")}</Button>
            <SettingHelp id="setting-github-test-help" text="Runs one read-only request against the credential the API is actually using. Saved changes apply only after a restart." href={SETTING_HELP_LINKS.githubApp} />
          </div>
        </div>
      )}
      {mode !== "core" && <>
        <div className="setting-field"><label htmlFor="setting-app-id">{t("GitHub App ID")}</label><input id="setting-app-id" aria-describedby="setting-app-id-help" value={draft.github.appId} onChange={event => updateGithub({ appId: event.target.value })} placeholder={t("Only for GitHub App mode")} /><SettingHelp id="setting-app-id-help" text="Find the numeric App ID on the GitHub App settings page. Skip this for anonymous or OAuth sign-in." href={SETTING_HELP_LINKS.githubApp} /></div>
        <SecretField name="webhookSecret" label="Webhook secret" configured={settings.github.webhookSecretConfigured} value={secrets.webhookSecret} clear={clearSecrets.webhookSecret} help="Create a random webhook secret in your GitHub App and enter the same value here." helpHref={SETTING_HELP_LINKS.githubWebhook} onValue={updateSecret} onClear={updateClear} />
        <div className="setting-field-wide"><SecretField name="privateKey" label="Private key" configured={settings.github.privateKeyConfigured} value={secrets.privateKey} clear={clearSecrets.privateKey} help="Paste the GitHub App PEM private key or a readable local file path. Never commit the PEM file." helpHref={SETTING_HELP_LINKS.githubPrivateKey} multiline onValue={updateSecret} onClear={updateClear} /></div>
      </>}
    </div>
  </section>;
}
