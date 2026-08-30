import { Bell, Globe2, Inbox, Minimize2, Monitor, Power } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  desktopBridge,
  type DesktopPreferenceKey,
  type DesktopPreferences,
  type DesktopPreferencesPatch
} from "../../desktop";
import { useI18n } from "../../i18n";
import { SettingHelp } from "../SettingHelp";

/**
 * Desktop section for the Settings Dialog and the /settings page. Close
 * behavior, tray visibility and login launch are REAL toggles: each change
 * is applied immediately through the desktop bridge (main-process
 * desktop-preferences.json) and survives an application restart. There is no
 * draft/save lifecycle here — the main process owns these keys, validates the
 * patch and applies the OS side effects. In the browser there is no desktop
 * bridge at all, so the switches render disabled and a browser-mode note
 * frames the rows as descriptions of the desktop app. Notifications stay
 * honest: no desktop notification system exists yet, so that row is still an
 * informational status — never a fake toggle.
 */

const DEFAULT_PREFERENCES: DesktopPreferences = Object.freeze({
  closeToTray: true,
  trayEnabled: true,
  launchAtLogin: false
});

const DESKTOP_SWITCH_STYLE: CSSProperties = {
  width: "36px",
  height: "20px",
  position: "relative",
  flexShrink: 0,
  padding: 0,
  borderRadius: "999px",
  border: "1px solid var(--border-strong)",
  background: "var(--surface-muted)",
  cursor: "pointer"
};

function DesktopSwitch({
  checked,
  disabled,
  labelledBy,
  describedBy,
  switchId,
  onToggle
}: {
  checked: boolean;
  disabled: boolean;
  labelledBy: string;
  describedBy: string;
  switchId: string;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onToggle(!checked)}
      style={{
        ...DESKTOP_SWITCH_STYLE,
        ...(checked ? { background: "var(--primary)", borderColor: "var(--primary)" } : {}),
        ...(disabled ? { opacity: 0.55, cursor: "not-allowed" } : {})
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          top: "2px",
          left: checked ? "18px" : "2px",
          width: "14px",
          height: "14px",
          borderRadius: "50%",
          background: "#ffffff",
          boxShadow: "0 1px 2px var(--shadow-soft)",
          transition: "left var(--duration-fast) var(--ease-standard)"
        }}
      />
    </button>
  );
}

function SwitchRow({
  rowId,
  icon,
  label,
  statusText,
  helpText,
  checked,
  disabled,
  onToggle
}: {
  rowId: string;
  icon: ReactNode;
  label: string;
  statusText: string;
  helpText: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="setting-field" id={rowId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "10px", minWidth: 0 }}>
        <span style={{ display: "inline-flex", flexShrink: 0, marginTop: "2px", color: "var(--muted)" }}>{icon}</span>
        <div style={{ minWidth: 0 }}>
          <strong id={`${rowId}-label`}>{t(label)}</strong>
          <p style={{ margin: "2px 0 0" }}>{t(statusText)}</p>
          <SettingHelp id={`${rowId}-help`} text={helpText} />
        </div>
      </div>
      <DesktopSwitch
        switchId={`${rowId}-switch`}
        checked={checked}
        disabled={disabled}
        labelledBy={`${rowId}-label`}
        describedBy={`${rowId}-help`}
        onToggle={onToggle}
      />
    </div>
  );
}

export function DesktopSettingsSection() {
  const { t } = useI18n();
  const inDesktopShell = Boolean(desktopBridge());
  const [preferences, setPreferences] = useState<DesktopPreferences | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failedKey, setFailedKey] = useState<DesktopPreferenceKey | null>(null);

  useEffect(() => {
    const bridge = desktopBridge()?.preferences;
    if (!bridge) return;
    let active = true;
    bridge.get().then(
      loaded => {
        if (active) setPreferences(loaded);
      },
      () => {
        if (active) setLoadFailed(true);
      }
    );
    return () => {
      active = false;
    };
  }, []);

  async function togglePreference(key: DesktopPreferenceKey, next: boolean) {
    const bridge = desktopBridge()?.preferences;
    if (!bridge) return;
    const previous = preferences;
    const patch: DesktopPreferencesPatch = {};
    patch[key] = next;
    // Optimistic update, reverted when the main process rejects the patch.
    setPreferences(current => (current ? { ...current, [key]: next } : current));
    setFailedKey(null);
    try {
      setPreferences(await bridge.set(patch));
    } catch {
      setPreferences(previous);
      setFailedKey(key);
    }
  }

  const switchesDisabled = !inDesktopShell || preferences === null;
  // While the main process has not answered yet (or in browser mode) the rows
  // describe the shipped defaults; the switches stay disabled until then.
  const resolved = (key: DesktopPreferenceKey): boolean =>
    preferences ? preferences[key] : DEFAULT_PREFERENCES[key];
  const statusText = (key: DesktopPreferenceKey, enabledText: string, disabledText: string) =>
    resolved(key) ? enabledText : disabledText;

  return <section className="settings-group section-block">
    <div className="settings-group-title"><Monitor size={18} /><div><span>{t("05 · Desktop")}</span><h3>{t("Desktop app behavior")}</h3><p>{t("Behavior of the desktop host. Toggles apply immediately inside the desktop app and are stored locally.")}</p></div></div>
    <div className="settings-fields">
      {!inDesktopShell && (
        <div className="setting-field setting-field-wide setting-note" id="setting-desktop-browser-note"><Globe2 size={17} /><div><strong>{t("Browser mode")}</strong><p>{t("Browser mode: these rows describe the desktop app and only apply when running inside it.")}</p></div></div>
      )}
      {loadFailed && (
        <div className="setting-field setting-field-wide setting-note" id="setting-desktop-load-error"><Globe2 size={17} /><div><strong>{t("Desktop preferences unavailable")}</strong><p>{t("The desktop host did not report its preferences, so the switches stay off until it answers.")}</p></div></div>
      )}
      <SwitchRow
        rowId="setting-desktop-close"
        icon={<Minimize2 size={17} />}
        label="Close behavior"
        statusText={statusText("closeToTray", "Closing the window keeps the app in the system tray", "Closing the window exits the app")}
        helpText="Hiding to the tray requires the tray to be enabled. Changes apply immediately."
        checked={resolved("closeToTray")}
        disabled={switchesDisabled}
        onToggle={next => void togglePreference("closeToTray", next)}
      />
      <SwitchRow
        rowId="setting-desktop-tray"
        icon={<Inbox size={17} />}
        label="System tray"
        statusText={statusText("trayEnabled", "The tray icon with its Open/Quit menu is available", "No tray icon is created")}
        helpText="Disabling the tray also makes closing the window exit the app."
        checked={resolved("trayEnabled")}
        disabled={switchesDisabled}
        onToggle={next => void togglePreference("trayEnabled", next)}
      />
      <SwitchRow
        rowId="setting-desktop-autostart"
        icon={<Power size={17} />}
        label="Start on login"
        statusText={statusText("launchAtLogin", "Registered with the operating system", "Not registered with the operating system")}
        helpText="Registered through the desktop host via the OS login items. Default is off."
        checked={resolved("launchAtLogin")}
        disabled={switchesDisabled}
        onToggle={next => void togglePreference("launchAtLogin", next)}
      />
      {failedKey && (
        <div className="settings-message warning" role="status" id={`setting-desktop-${failedKey}-error`}>
          <span>{t("The desktop host rejected the change. The previous state was restored.")}</span>
        </div>
      )}
      <div className="setting-field setting-note" id="setting-desktop-notifications"><Bell size={17} /><div><strong>{t("Notifications")}</strong><p>{t("Not available yet")}</p><SettingHelp id="setting-desktop-notifications-help" text="No desktop notification system exists yet, so no option is offered." /></div></div>
    </div>
  </section>;
}
