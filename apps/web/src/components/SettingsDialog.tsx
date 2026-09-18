import { LoaderCircle, RotateCcw, Save, LockKeyhole } from "lucide-react";
import { useState } from "react";
import type { HealthResponse } from "../api/client";
import { Dialog } from "../design-system/Dialog";
import { Button } from "../design-system/Button";
import { useI18n } from "../i18n";
import { useSettingsForm } from "../hooks/useSettingsForm";
import { ModelSettingsSection } from "./settings/ModelSettingsSection";
import { GitHubSettingsSection } from "./settings/GitHubSettingsSection";
import { RuntimeSettingsSection } from "./settings/RuntimeSettingsSection";
import { AppearanceSettingsSection } from "./settings/AppearanceSettingsSection";
import { DesktopSettingsSection } from "./settings/DesktopSettingsSection";
import { AboutSettingsSection } from "./settings/AboutSettingsSection";
import { AdvancedSettingsDisclosure } from "./settings/AdvancedSettingsDisclosure";
import { closeSettingsDialog } from "../settingsDialogStore";
import { desktopBridge } from "../desktop";

export type SettingsSectionId = "general" | "appearance" | "about";

interface SettingsNavItem {
  id: SettingsSectionId;
  labelKey: string;
  disabled: boolean;
}

const SECTION_ITEMS: readonly SettingsNavItem[] = [
  { id: "general", labelKey: "General", disabled: false },
  { id: "appearance", labelKey: "Appearance", disabled: false },
  { id: "about", labelKey: "About", disabled: false }
];

export interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  health?: HealthResponse;
}

export function SettingsDialog({ isOpen, onClose, health }: SettingsDialogProps) {
  const { t } = useI18n();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("general");

  const form = useSettingsForm({ health });

  const {
    settings,
    draft,
    secrets,
    clearSecrets,
    loading,
    saving,
    restarting,
    restartNeeded,
    message,
    buildInfo,
    updateSecret,
    updateClear,
    updateLlm,
    updateGithub,
    updateRuntime,
    save,
    applyGitHubOauthToken,
    applyGitHubDesktopOauth,
    resetChanges,
    handleRestartRuntime
  } = form;

  function handleSectionClick(item: SettingsNavItem) {
    if (item.disabled) return;
    setActiveSection(item.id);
  }

  const footer = (
    <div className="settings-dialog-footer">
      <span className="settings-dialog-footer-status">
        {restartNeeded
          ? <span className="settings-status-chip pending">{t("Saved — restart required")}</span>
          : <><LockKeyhole size={12} aria-hidden="true" /><span>{t("Secrets are encrypted locally and never returned.")}</span></>}
      </span>
      <div className="settings-dialog-footer-actions">
        <Button variant="outline" size="sm" icon={<RotateCcw size={13} />} onClick={resetChanges} disabled={loading || saving}>
          {t("Reset changes")}
        </Button>
        <Button variant="primary" size="sm" icon={<Save size={13} />} loading={saving} onClick={() => void save()} disabled={loading || !draft}>
          {t(saving ? "Saving" : "Save settings")}
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t("Settings")}
      dismissible
      className="ds-dialog--settings"
      footer={footer}
    >
      <div className="settings-dialog-layout">
        <nav className="settings-dialog-nav" aria-label={t("Settings sections")}>
          {SECTION_ITEMS.map(item => (
            <Button key={item.id} type="button" variant="ghost" size="sm" fullWidth className={`settings-dialog-nav-item ${activeSection === item.id ? "settings-dialog-nav-item--active" : ""} ${item.disabled ? "settings-dialog-nav-item--disabled" : ""}`} onClick={() => handleSectionClick(item)} disabled={item.disabled} aria-current={activeSection === item.id ? "true" : undefined}><span>{t(item.labelKey)}</span>{item.disabled && <small>{t("Coming soon")}</small>}</Button>
          ))}
        </nav>
        <div className="settings-dialog-content">
          {/* Appearance, Desktop and About are renderer-local sections that
              render without waiting for the settings snapshot: theme + locale
              apply immediately, the desktop rows are real toggles persisted by
              the Electron main process through the preferences bridge, and
              About mirrors buildInfo and /health. */}
          {activeSection === "appearance" ? (
            <AppearanceSettingsSection />
          ) : activeSection === "about" ? (
            <AboutSettingsSection health={health} buildInfo={buildInfo} />
          ) : loading ? (
            <div className="loading-state"><LoaderCircle size={22} /><span>{t("Loading configuration")}</span></div>
          ) : !draft || !settings ? (
            <div className="empty-state">{t("Configuration editor is unavailable. Run {command} for details.", { command: "npm run config -- doctor" })}</div>
          ) : (
            <>
              {restartNeeded && (
                <div className="settings-message warning settings-lifecycle-banner" role="status">
                  <div className="settings-lifecycle-notice">
                    <span>{t("Configuration saved. Restart the API to apply.")}</span>
                    <small>
                      {t("Saved configuration")}: {settings.llm.provider === "none" ? t("Not active") : <><strong>{settings.llm.provider === "deepseek" ? "DeepSeek" : settings.llm.provider === "openai" ? "OpenAI" : "Anthropic"}</strong> &middot; {settings.llm.provider === "deepseek" ? settings.llm.deepseekModel : settings.llm.provider === "openai" ? settings.llm.openaiModel : settings.llm.anthropicModel || "catalog default"}</>}
                      {" | "}
                      {t("Active runtime")}: {health?.llmProvider === "none" || !health ? t("Not active") : <><strong>{health.llmProvider === "deepseek" ? "DeepSeek" : health.llmProvider === "openai" ? "OpenAI" : health.llmProvider}</strong> &middot; {health.llmModel}</>}
                    </small>
                  </div>
                  {desktopBridge()?.restartRuntime ? (
                    <Button type="button" variant="outline" size="sm" icon={<RotateCcw size={13} />} loading={restarting} onClick={() => void handleRestartRuntime()}>{t(restarting ? "Restarting..." : "Restart Runtime")}</Button>
                  ) : (
                    <small className="settings-lifecycle-manual">
                      {t("Restart the terminal process to apply.")}
                    </small>
                  )}
                </div>
              )}
              {message && (
                <div className={`settings-message ${message.tone}`} role="status">
                  <span>{message.text}</span>
                </div>
              )}
              {draft.overriddenByEnvironment.length > 0 && <div className="settings-message warning">{t("Environment variables override: {keys}", { keys: draft.overriddenByEnvironment.join(", ") })}</div>}
              {activeSection === "general" && <div className="settings-general-stack">                <ModelSettingsSection
                  draft={draft}
                  settings={settings}
                  secrets={secrets}
                  clearSecrets={clearSecrets}
                  updateLlm={updateLlm}
                  updateSecret={updateSecret}
                  updateClear={updateClear}
                />
                <GitHubSettingsSection
                  mode="core"
                  draft={draft}
                  settings={settings}
                  secrets={secrets}
                  clearSecrets={clearSecrets}
                  updateGithub={updateGithub}
                  updateSecret={updateSecret}
                  updateClear={updateClear}
                  applyGitHubOauthToken={applyGitHubOauthToken}
                  applyGitHubDesktopOauth={applyGitHubDesktopOauth}
                  health={health}
                  restartPending={restartNeeded}
                />
                <AdvancedSettingsDisclosure>
                  <RuntimeSettingsSection draft={draft} settings={settings} health={health} updateRuntime={updateRuntime} />
                  <GitHubSettingsSection
                    mode="advanced"
                    draft={draft}
                    settings={settings}
                    secrets={secrets}
                    clearSecrets={clearSecrets}
                    updateGithub={updateGithub}
                    updateSecret={updateSecret}
                    updateClear={updateClear}
                    applyGitHubOauthToken={applyGitHubOauthToken}
                    applyGitHubDesktopOauth={applyGitHubDesktopOauth}
                    health={health}
                    restartPending={restartNeeded}
                  />
                  <DesktopSettingsSection />
                </AdvancedSettingsDisclosure>
              </div>}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
