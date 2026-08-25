import { Languages, Palette, Rows3 } from "lucide-react";
import { useI18n, type Locale } from "../../i18n";
import { useTheme, type ThemePreference } from "../../theme";
import { SettingHelp } from "../SettingHelp";

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
    <div className="settings-group-title"><Palette size={18} /><div><span>{t("04 · Appearance")}</span><h3>{t("Theme and language")}</h3><p>{t("Adjust the interface theme and language. Changes apply immediately and are stored locally.")}</p></div></div>
    <div className="settings-fields">
      <div className="setting-field"><label htmlFor="setting-theme">{t("Theme")}</label><select id="setting-theme" aria-describedby="setting-theme-help" value={preference} onChange={event => setPreference(event.target.value as ThemePreference)}><option value="system">{t("Follow system")}</option><option value="light">{t("Light")}</option><option value="dark">{t("Dark")}</option></select><SettingHelp id="setting-theme-help" text="Applies immediately and is stored locally." /></div>
      <div className="setting-field"><label htmlFor="setting-locale">{t("Language")}</label><select id="setting-locale" aria-describedby="setting-locale-help" value={locale} onChange={event => setLocale(event.target.value as Locale)}><option value="zh-CN">中文</option><option value="en-US">English</option></select><SettingHelp id="setting-locale-help" text="Applies immediately and is stored locally." /></div>
      <div className="setting-field setting-note" id="setting-theme-resolved"><Palette size={17} /><div><strong>{t("Resolved theme")}</strong><p>{t(preference === "system" ? "Currently {theme} (following the system setting)" : "Currently {theme}", { theme: resolvedThemeLabel })}</p><SettingHelp id="setting-theme-resolved-help" text="Tracks the operating system in real time while Follow system is selected." /></div></div>
      <div className="setting-field setting-note" id="setting-density"><Rows3 size={17} /><div><strong>{t("Density")}</strong><p>{t("Not available yet")}</p><SettingHelp id="setting-density-help" text="No density contract exists yet, so no option is offered." /></div></div>
    </div>
  </section>;
}
