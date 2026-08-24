import { Sparkles } from "lucide-react";
import type { SettingsSnapshot } from "../../api/client";
import type { SecretDrafts, ClearSecrets, SecretName } from "../../hooks/useSettingsForm";
import { useI18n } from "../../i18n";
import { SettingHelp, SETTING_HELP_LINKS } from "../SettingHelp";
import { SecretField } from "./SecretField";

export interface ModelSettingsSectionProps {
  draft: SettingsSnapshot;
  settings: SettingsSnapshot;
  secrets: SecretDrafts;
  clearSecrets: ClearSecrets;
  updateLlm: (patch: Partial<SettingsSnapshot["llm"]>) => void;
  updateSecret: (name: SecretName, value: string) => void;
  updateClear: (name: SecretName, value: boolean) => void;
}

export function ModelSettingsSection({
  draft,
  secrets,
  clearSecrets,
  settings,
  updateLlm,
  updateSecret,
  updateClear
}: ModelSettingsSectionProps) {
  const { t } = useI18n();

  return <section className="settings-group section-block">
    <div className="settings-group-title"><Sparkles size={18} /><div><h3>{t("Model")}</h3><p>{t("Choose the model used for evidence synthesis and reviewer handoff.")}</p></div></div>
    <div className="settings-fields">
      <div className="setting-field"><label htmlFor="setting-provider">{t("Provider")}</label><select id="setting-provider" aria-describedby="setting-provider-help" value={draft.llm.provider ?? "none"} onChange={event => updateLlm({ provider: event.target.value as SettingsSnapshot["llm"]["provider"] })}><option value="none">{t("Not configured")}</option><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option></select><SettingHelp id="setting-provider-help" text="ConsistenCy requires a real LLM Provider (DeepSeek or OpenAI) to execute reviews." /></div>
      {draft.llm.provider === "deepseek" && <>
        <div className="setting-field"><label htmlFor="setting-deepseek-model">{t("Model")}</label><input id="setting-deepseek-model" aria-describedby="setting-deepseek-model-help" value={draft.llm.deepseekModel} onChange={event => updateLlm({ deepseekModel: event.target.value })} /><SettingHelp id="setting-deepseek-model-help" text="Use a model name supported by your DeepSeek account." /></div>
        <div className="setting-field setting-field-wide"><label htmlFor="setting-deepseek-url">{t("Base URL")}</label><input id="setting-deepseek-url" aria-describedby="setting-deepseek-url-help" type="url" value={draft.llm.deepseekBaseUrl} onChange={event => updateLlm({ deepseekBaseUrl: event.target.value })} /><SettingHelp id="setting-deepseek-url-help" text="Keep the official endpoint unless your organization provides a compatible gateway." /></div>
        <SecretField name="deepseekApiKey" label="DeepSeek API key" configured={settings.llm.deepseekApiKeyConfigured} value={secrets.deepseekApiKey} clear={clearSecrets.deepseekApiKey} help="Create a key in DeepSeek. Do not paste an account password or browser session token." helpHref={SETTING_HELP_LINKS.deepseekApi} onValue={updateSecret} onClear={updateClear} />
      </>}
      {draft.llm.provider === "openai" && <>
        <div className="setting-field"><label htmlFor="setting-openai-model">{t("Model")}</label><input id="setting-openai-model" aria-describedby="setting-openai-model-help" value={draft.llm.openaiModel} onChange={event => updateLlm({ openaiModel: event.target.value })} /><SettingHelp id="setting-openai-model-help" text="Use an API model available to your OpenAI project." /></div>
        <SecretField name="openaiApiKey" label="OpenAI API key" configured={settings.llm.openaiApiKeyConfigured} value={secrets.openaiApiKey} clear={clearSecrets.openaiApiKey} help="Create a project API key. This is not your ChatGPT password or session token." helpHref={SETTING_HELP_LINKS.openaiApiKeys} onValue={updateSecret} onClear={updateClear} />
      </>}
    </div>
  </section>;
}
