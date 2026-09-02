import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import type { SettingsSnapshot } from "../../api/client";
import { api } from "../../api/client";
import type { SecretDrafts, ClearSecrets, SecretName } from "../../hooks/useSettingsForm";
import { useI18n } from "../../i18n";
import { SettingHelp, SETTING_HELP_LINKS } from "../SettingHelp";
import { SecretField } from "./SecretField";
import { SelectMenu } from "../../design-system/SelectMenu";

export interface ModelSettingsSectionProps {
  draft: SettingsSnapshot;
  settings: SettingsSnapshot;
  secrets: SecretDrafts;
  clearSecrets: ClearSecrets;
  updateLlm: (patch: Partial<SettingsSnapshot["llm"]>) => void;
  updateSecret: (name: SecretName, value: string) => void;
  updateClear: (name: SecretName, value: boolean) => void;
}

/**
 * Provider selection is driven by the bundled Pi runtime's catalog served
 * from GET /llm/catalog — the API owns the list (33+ providers); the Web UI
 * never hardcodes it. Falls back to a free-text field when the catalog is
 * temporarily unavailable.
 */
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
  const [catalogProviders, setCatalogProviders] = useState<Array<{ id: string; label: string }>>([]);
  const [catalogModels, setCatalogModels] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    let active = true;
    api.llmCatalog().then(response => {
      if (!active) return;
      setCatalogProviders(response.providers.map(provider => ({ id: provider.id, label: provider.label })));
      const selected = response.providers.find(provider => provider.id === (draft.llm.provider ?? ""));
      setCatalogModels(selected?.models ?? []);
    }).catch(() => {});
    return () => { active = false; };
    // Reload the model list only when the provider choice changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.llm.provider]);

  return <section className="settings-group section-block">
    <div className="settings-group-title"><Sparkles size={18} /><div><h3>{t("Model")}</h3><p>{t("Choose the model used for evidence synthesis and reviewer handoff.")}</p></div></div>
    <div className="settings-fields">
      <div className="setting-field"><label id="setting-provider-label">{t("Provider")}</label><SelectMenu ariaLabel={t("Provider")} value={draft.llm.provider ?? "none"} options={[{ value: "none", label: t("Not configured") }, ...catalogProviders.map(provider => ({ value: provider.id, label: provider.label })), ...(catalogProviders.length === 0 && draft.llm.provider && draft.llm.provider !== "none" ? [{ value: draft.llm.provider, label: draft.llm.provider }] : [])]} onChange={provider => updateLlm({ provider })} /><SettingHelp id="setting-provider-help" text="Providers come from the bundled Pi model catalog served by the API. Pick one and configure its API key." /></div>
      {draft.llm.provider && draft.llm.provider !== "none" && <>
        <div className="setting-field setting-field-wide"><label htmlFor="setting-llm-model">{t("Model")}</label><input id="setting-llm-model" aria-describedby="setting-llm-model-help" list="setting-llm-model-options" value={draft.llm.llmModel ?? ""} onChange={event => updateLlm({ llmModel: event.target.value })} placeholder={t("Catalog default")} /><datalist id="setting-llm-model-options">{catalogModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist><SettingHelp id="setting-llm-model-help" text="Leave empty to use the provider's first available catalog model." /></div>
        <SecretField name="llmApiKey" label="Provider API key" configured={settings.llm.llmApiKeyConfigured} value={secrets.llmApiKey} clear={clearSecrets.llmApiKey} help="Create a key with the selected provider. It is stored encrypted and injected in-memory at runtime." helpHref={SETTING_HELP_LINKS.openaiApiKeys} onValue={updateSecret} onClear={updateClear} />
      </>}
      {draft.llm.provider === "deepseek" && <>
        <div className="setting-field setting-field-wide"><label htmlFor="setting-deepseek-url">{t("Base URL")}</label><input id="setting-deepseek-url" aria-describedby="setting-deepseek-url-help" type="url" value={draft.llm.deepseekBaseUrl} onChange={event => updateLlm({ deepseekBaseUrl: event.target.value })} /><SettingHelp id="setting-deepseek-url-help" text="Keep the official endpoint unless your organization provides a compatible gateway." /></div>
      </>}
    </div>
  </section>;
}
