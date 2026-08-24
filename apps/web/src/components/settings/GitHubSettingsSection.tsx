import { Github } from "lucide-react";
import type { SettingsSnapshot } from "../../api/client";
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
}

export function GitHubSettingsSection({
  draft,
  secrets,
  clearSecrets,
  settings,
  updateGithub,
  updateSecret,
  updateClear
}: GitHubSettingsSectionProps) {
  const { t } = useI18n();

  return <section className="settings-group section-block">
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
  </section>;
}
