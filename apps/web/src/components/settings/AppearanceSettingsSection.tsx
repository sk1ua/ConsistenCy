import { Languages, Palette, Rows3 } from "lucide-react";
import { useI18n, type Locale } from "../../i18n";
import { useTheme, type ThemePreference } from "../../theme";
import { SettingHelp } from "../SettingHelp";
import { SelectMenu } from "../../design-system/SelectMenu";

/**
 * Shared appearance presentation for the Settings Dialog and the /settings
 * page. Theme and locale are renderer-local capabilities owned by the
 * CKPT1-frozen providers: they apply IMMEDIATELY and never round-trip the
 * server settings form, so this section owns no draft/save lifecycle and is
 * rendered even when the settings snapshot is unavailable. Density has no
 * contract yet and is surfaced truthfully as not available — no fake control.
 */
export function AppearanceSettingsSection() {
  const { t, locale, setLocale } = useI18n();
  const { preference, resolved, setPreference } = useTheme();

  const resolvedThemeLabel = t(resolved === "dark" ? "Dark" : "Light");

  return <section className="settings-group section-block">
    <div className="settings-group-title"><Palette size={18} /><div><h3>{t("Theme and language")}</h3><p>{t("Adjust the interface theme and language. Changes apply immediately and are stored locally.")}</p></div></div>
    <div className="settings-fields">
      <div className="setting-field"><label>{t("Theme")}</label><SelectMenu ariaLabel={t("Theme")} value={preference} options={[{ value: "system", label: t("Follow system") }, { value: "light", label: t("Light") }, { value: "dark", label: t("Dark") }]} onChange={value => setPreference(value as ThemePreference)} /><SettingHelp id="setting-theme-help" text="Applies immediately and is stored locally." /></div>
      <div className="setting-field"><label>{t("Language")}</label><SelectMenu ariaLabel={t("Language")} value={locale} options={[{ value: "zh-CN", label: "中文" }, { value: "en-US", label: "English" }]} onChange={value => setLocale(value as Locale)} /><SettingHelp id="setting-locale-help" text="Applies immediately and is stored locally." /></div>
      <div className="setting-field setting-note" id="setting-theme-resolved"><Palette size={17} /><div><strong>{t("Resolved theme")}</strong><p>{t(preference === "system" ? "Currently {theme} (following the system setting)" : "Currently {theme}", { theme: resolvedThemeLabel })}</p><SettingHelp id="setting-theme-resolved-help" text="Tracks the operating system in real time while Follow system is selected." /></div></div>
      <div className="setting-field setting-note" id="setting-density"><Rows3 size={17} /><div><strong>{t("Density")}</strong><p>{t("Not available yet")}</p><SettingHelp id="setting-density-help" text="No density contract exists yet, so no option is offered." /></div></div>
    </div>
  </section>;
}
