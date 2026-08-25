import { Activity, Github, KeyRound, LoaderCircle, PlugZap, Webhook } from "lucide-react";
import { useState } from "react";
import type { GitHubConnectionTestResponse, GitHubConnectionTestStatus } from "@consistency/schema";
import { api, type HealthResponse, type SettingsSnapshot } from "../../api/client";
import type { SecretDrafts, ClearSecrets, SecretName } from "../../hooks/useSettingsForm";
import { useI18n } from "../../i18n";
import { SettingHelp, SETTING_HELP_LINKS } from "../SettingHelp";
import { SecretField } from "./SecretField";

export interface GitHubSettingsSectionProps {
  draft: SettingsSnapshot;
  settings: SettingsSnapshot;
  secrets: SecretDrafts;
  clearSecrets: ClearSecrets;
  updateGithub: (patch: Partial<SettingsSnapshot["github"]>) => void;
  updateSecret: (name: SecretName, value: string) => void;
  updateClear: (name: SecretName, value: boolean) => void;
  /** ACTIVE runtime truth from /health; the status rows hide when absent. */
  health?: HealthResponse;
  /** True while saved settings await a restart; the probe tests the running config. */
  restartPending?: boolean;
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

export function GitHubSettingsSection({
  draft,
  secrets,
  clearSecrets,
  settings,
  updateGithub,
  updateSecret,
  updateClear,
  health,
  restartPending
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

  const accessModeLabel = health?.publicPrAccessMode === "pat"
    ? t("PAT read")
    : health?.publicPrAccessMode === "anonymous"
      ? t("Anonymous read")
      : t("Disabled");

  return <>
    <section className="settings-group section-block">
      <div className="settings-group-title"><Github size={18} /><div><h3>{t("GitHub")}</h3><p>{t("Start with anonymous public PR analysis, then add credentials only for the mode you need.")}</p></div></div>
      <div className="settings-fields">
        <div className="source-mode-guide setting-field-wide" aria-label={t("GitHub connection modes")}>
          <span><strong>{t("Anonymous public PR")}</strong><small>{t("Recommended for trying ConsistenCy. No GitHub App or token is required.")}</small></span>
          <span><strong>{t("Public read token")}</strong><small>{t("Optional. Adds authenticated read capacity for selected public repositories.")}</small></span>
          <span><strong>{t("GitHub App automation")}</strong><small>{t("Only needed for signed webhooks and installation-based repository access.")}</small></span>
        </div>
        <div className="setting-field"><label htmlFor="setting-app-id">{t("GitHub App ID")}</label><input id="setting-app-id" aria-describedby="setting-app-id-help" value={draft.github.appId} onChange={event => updateGithub({ appId: event.target.value })} placeholder={t("Only for GitHub App mode")} /><SettingHelp id="setting-app-id-help" text="Find the numeric App ID on the GitHub App settings page. Skip this for anonymous or PAT read-only mode." href={SETTING_HELP_LINKS.githubApp} /></div>
        <SecretField name="publicReadToken" label="Public read token" configured={settings.github.publicReadTokenConfigured} value={secrets.publicReadToken} clear={clearSecrets.publicReadToken} help="Optional: use a fine-grained PAT limited to selected repositories and read-only contents/metadata permissions." helpHref={SETTING_HELP_LINKS.githubPat} onValue={updateSecret} onClear={updateClear} />
        <SecretField name="webhookSecret" label="Webhook secret" configured={settings.github.webhookSecretConfigured} value={secrets.webhookSecret} clear={clearSecrets.webhookSecret} help="Create a random webhook secret in your GitHub App and enter the same value here." helpHref={SETTING_HELP_LINKS.githubWebhook} onValue={updateSecret} onClear={updateClear} />
        <div className="setting-field-wide"><SecretField name="privateKey" label="Private key" configured={settings.github.privateKeyConfigured} value={secrets.privateKey} clear={clearSecrets.privateKey} help="Paste the GitHub App PEM private key or a readable local file path. Never commit the PEM file." helpHref={SETTING_HELP_LINKS.githubPrivateKey} multiline onValue={updateSecret} onClear={updateClear} /></div>
      </div>
    </section>
    <section className="settings-group section-block" aria-label={t("Connection status")}>
      <div className="settings-group-title"><PlugZap size={18} /><div><h3>{t("Connection status")}</h3><p>{t("Read-only status of the running GitHub configuration.")}</p></div></div>
      <div className="settings-fields">
        {health && (
          <>
            <div className="setting-field setting-note" id="setting-github-status-access"><Activity size={17} /><div><strong>{t("Public PR access")}</strong><p>{accessModeLabel}</p></div></div>
            <div className="setting-field setting-note" id="setting-github-status-app"><Github size={17} /><div><strong>{t("GitHub App")}</strong><p>{t(health.configuration.githubAppConfigured ? "Configured" : "Not configured")}</p></div></div>
            <div className="setting-field setting-note" id="setting-github-status-webhook"><Webhook size={17} /><div><strong>{t("Webhook secret")}</strong><p>{t(health.configuration.webhookSecretConfigured ? "Configured" : "Not configured")}</p></div></div>
            <div className="setting-field setting-note" id="setting-github-status-token"><KeyRound size={17} /><div><strong>{t("Public read token")}</strong><p>{t(health.configuration.publicReadTokenConfigured ? "Configured" : "Not configured")}</p></div></div>
          </>
        )}
        <div className="setting-field setting-field-wide setting-note" id="setting-github-status-test">
          <PlugZap size={17} />
          <div>
            <strong>{t("Live connection test")}</strong>
            <p id="setting-github-status-result" role="status">
              {testState.phase === "idle" && t("Not tested yet")}
              {testState.phase === "testing" && t("Testing…")}
              {testState.phase === "error" && <span className="badge badge-failed">{t("Connection test unavailable")}</span>}
              {testState.phase === "done" && <>
                <span className={connectionStatusBadgeClass(testState.result.status)}>{t(connectionStatusLabelKey(testState.result.status))}</span>
                {testState.result.status === "rate_limited" && testState.result.retryAfterMs !== undefined && (
                  <> {t("Retry available in {minutes} min", { minutes: Math.max(1, Math.ceil(testState.result.retryAfterMs / 60_000)) })}</>
                )}
              </>}
            </p>
            {restartPending && (
              <p className="github-restart-hint">{t("Tests use the running configuration. Restart to apply saved changes.")}</p>
            )}
            <button
              type="button"
              id="setting-github-test"
              className="secondary-button"
              aria-describedby="setting-github-test-help"
              disabled={testState.phase === "testing"}
              onClick={() => void runConnectionTest()}
            >
              {testState.phase === "testing" ? <LoaderCircle className="spinning" size={13} /> : <PlugZap size={13} />}
              {t(testState.phase === "testing" ? "Testing…" : "Test Connection")}
            </button>
            <SettingHelp id="setting-github-test-help" text="Runs one read-only request against the credential the API is actually using. Saved changes apply only after a restart." href={SETTING_HELP_LINKS.githubApp} />
          </div>
        </div>
      </div>
    </section>
  </>;
}
