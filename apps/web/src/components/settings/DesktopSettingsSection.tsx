import { Bell, Globe2, Inbox, Minimize2, Monitor, Power } from "lucide-react";
import { desktopBridge } from "../../desktop";
import { useI18n } from "../../i18n";
import { SettingHelp } from "../SettingHelp";

/**
 * Shared read-only Desktop status presentation for the Settings Dialog and
 * the /settings page. The Electron host has FIXED, documented behaviors
 * (main.cjs): closing the window hides it to an always-present tray with an
 * Open/Quit menu, startup-at-login stays off under the current security
 * model, and no notification system exists. There is no IPC surface and no
 * persistence behind these rows, so every capability renders as an
 * informational status — never a fake toggle. In the browser there is no
 * desktop bridge at all, so a browser-mode note frames the rows as
 * descriptions of the desktop app rather than of the current session.
 */
export function DesktopSettingsSection() {
  const { t } = useI18n();
  const inDesktopShell = Boolean(desktopBridge());

  return <section className="settings-group section-block">
    <div className="settings-group-title"><Monitor size={18} /><div><span>{t("05 · Desktop")}</span><h3>{t("Desktop app behavior")}</h3><p>{t("Fixed behaviors of the desktop host. These rows are informational status; nothing is toggled or stored here.")}</p></div></div>
    <div className="settings-fields">
      {!inDesktopShell && (
        <div className="setting-field setting-field-wide setting-note" id="setting-desktop-browser-note"><Globe2 size={17} /><div><strong>{t("Browser mode")}</strong><p>{t("Browser mode: these rows describe the desktop app and only apply when running inside it.")}</p></div></div>
      )}
      <div className="setting-field setting-note" id="setting-desktop-close"><Minimize2 size={17} /><div><strong>{t("Close behavior")}</strong><p>{t("Stays resident in the system tray when the window closes")}</p><SettingHelp id="setting-desktop-close-help" text="Quit completely through the tray menu." /></div></div>
      <div className="setting-field setting-note" id="setting-desktop-tray"><Inbox size={17} /><div><strong>{t("System tray")}</strong><p>{t("Always present")}</p><SettingHelp id="setting-desktop-tray-help" text="The tray icon with its Open/Quit menu is created at startup and stays available." /></div></div>
      <div className="setting-field setting-note" id="setting-desktop-autostart"><Power size={17} /><div><strong>{t("Start on login")}</strong><p>{t("Not enabled")}</p><SettingHelp id="setting-desktop-autostart-help" text="Deliberately kept off under the current security model." /></div></div>
      <div className="setting-field setting-note" id="setting-desktop-notifications"><Bell size={17} /><div><strong>{t("Notifications")}</strong><p>{t("Not available yet")}</p><SettingHelp id="setting-desktop-notifications-help" text="No desktop notification system exists yet, so no option is offered." /></div></div>
    </div>
  </section>;
}
