import { Check, CheckCircle2, Database, Globe2, Github, KeyRound, LoaderCircle, LockKeyhole, RotateCcw, Save, ServerCog, XCircle } from "lucide-react";
import type { FormEvent } from "react";
import type { HealthResponse } from "../api/client";
import { ModelSettingsSection } from "../components/settings/ModelSettingsSection";
import { GitHubSettingsSection } from "../components/settings/GitHubSettingsSection";
import { ReviewsSettingsSection } from "../components/settings/ReviewsSettingsSection";
import { RuntimeSettingsSection } from "../components/settings/RuntimeSettingsSection";
import { AppearanceSettingsSection } from "../components/settings/AppearanceSettingsSection";
import { DesktopSettingsSection } from "../components/settings/DesktopSettingsSection";
import { AboutSettingsSection } from "../components/settings/AboutSettingsSection";
import { desktopBridge } from "../desktop";
import { useI18n } from "../i18n";
import { publicPrAccessModeView, useSettingsForm } from "../hooks/useSettingsForm";

function ConfigRow({ icon: Icon, label, value, ok }: { icon: typeof Github; label: string; value: string; ok?: boolean }) {
  return <div className="config-row"><Icon size={18} /><span><strong>{label}</strong><small>{value}</small></span>{ok === undefined ? null : ok ? <CheckCircle2 className="ok" size={18} /> : <XCircle className="bad" size={18} />}</div>;
}

export function SettingsPage({ health }: { health?: HealthResponse }) {
  const { t } = useI18n();
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
    resetChanges,
    handleRestartRuntime
  } = form;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void save();
  }

  if (!health) return <div className="empty-state">{t("Start the API to configure this workspace from the browser.")}</div>;
  if (loading) return <div className="loading-state"><LoaderCircle size={22} /><span>{t("Loading configuration")}</span></div>;
  if (!draft || !settings) return <div className="empty-state">{t("Configuration editor is unavailable. Run {command} for details.", { command: "npm run config -- doctor" })}</div>;

  return <form className="settings-editor page-stack" onSubmit={onSubmit}>
    <section className="section-block settings-header-strip">
      <div className="settings-title-wrap">
        <ServerCog size={20} className="settings-icon-main" />
        <div>
          <h2>{t("Settings")}</h2>
          <p>{t("Configure models, GitHub connections, and review worker runtime settings.")}</p>
        </div>
      </div>
      {buildInfo && (
        <div className="settings-build-badge" title={`Commit ${buildInfo.commitSha}`}>
          <code>ConsistenCy {buildInfo.version} · build {buildInfo.commitSha.slice(0, 7)}</code>
        </div>
      )}
    </section>

    {restartNeeded && (
      <div className="settings-message warning settings-lifecycle-banner" role="status">
        <div className="settings-lifecycle-notice">
          <span>{t("Configuration saved. Restart the API to apply.")}</span>
          <small>
            {t("Saved configuration")}: {settings.llm.provider === "none" ? t("Not active") : <><strong>{settings.llm.provider === "deepseek" ? "DeepSeek" : "OpenAI"}</strong> &middot; {settings.llm.provider === "deepseek" ? settings.llm.deepseekModel : settings.llm.openaiModel}</>}
            {" | "}
            {t("Active runtime")}: {health.llmProvider === "none" ? t("Not active") : <><strong>{health.llmProvider === "deepseek" ? "DeepSeek" : health.llmProvider === "openai" ? "OpenAI" : health.llmProvider}</strong> &middot; {health.llmModel}</>}
          </small>
        </div>
        {desktopBridge()?.restartRuntime ? (
          <button
            type="button"
            className="secondary-button"
            disabled={restarting}
            onClick={() => void handleRestartRuntime()}
          >
            {restarting ? <LoaderCircle className="spinning" size={13} /> : <RotateCcw size={13} />}
            {t(restarting ? "Restarting..." : "Restart Runtime")}
          </button>
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

    <ModelSettingsSection
      draft={draft}
      settings={settings}
      secrets={secrets}
      clearSecrets={clearSecrets}
      updateLlm={updateLlm}
      updateSecret={updateSecret}
      updateClear={updateClear}
    />

    <GitHubSettingsSection
      draft={draft}
      settings={settings}
      secrets={secrets}
      clearSecrets={clearSecrets}
      updateGithub={updateGithub}
      updateSecret={updateSecret}
      updateClear={updateClear}
      health={health}
      restartPending={restartNeeded}
    />

    <ReviewsSettingsSection settings={settings} health={health} />

    <RuntimeSettingsSection
      draft={draft}
      settings={settings}
      health={health}
      updateRuntime={updateRuntime}
    />

    <AppearanceSettingsSection />

    <DesktopSettingsSection />

    <AboutSettingsSection health={health} buildInfo={buildInfo} />

    <section className="settings-status section-block">
      <div className="section-heading"><div><h2>{t("Active runtime")}</h2><p>{t("These values describe the currently running API process.")}</p></div></div>
      <div className="config-list">
        <ConfigRow icon={Github} label={t("GitHub App")} value={t(health.configuration.githubAppConfigured ? "Configured" : "Not configured")} ok={health.configuration.githubAppConfigured} />
        <ConfigRow icon={KeyRound} label={t("Webhook secret")} value={t(health.configuration.webhookSecretConfigured ? "Configured" : "Not configured")} ok={health.configuration.webhookSecretConfigured} />
        <ConfigRow icon={Globe2} label={t("Public PR access")} value={t(publicPrAccessModeView(health.publicPrAccessMode).labelKey)} ok={publicPrAccessModeView(health.publicPrAccessMode).ok} />
        <ConfigRow icon={KeyRound} label={t("Public read token")} value={t(health.configuration.publicReadTokenConfigured ? "Configured" : "Not configured")} ok={health.configuration.publicReadTokenConfigured} />
        <ConfigRow icon={ServerCog} label={t("LLM provider")} value={health.llmProvider} />
        <ConfigRow icon={ServerCog} label={t("Worker")} value={t(health.worker.running ? "Running · concurrency {count}" : "Stopped · concurrency {count}", { count: health.worker.concurrency })} ok={health.worker.running} />
        <ConfigRow icon={Database} label={t("Database")} value={t(health.configuration.storage.kind === "memory" ? "In-memory storage" : "Local file storage")} ok={health.database.ok && health.configuration.storage.configured} />
      </div>
    </section>

    <div className="settings-actions"><span><LockKeyhole size={15} />{t("Secrets are encrypted locally and never returned.")}</span><button className="secondary-button" type="button" onClick={resetChanges}><RotateCcw size={15} />{t("Reset changes")}</button><button className="save-settings" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spinning" size={16} /> : <Save size={16} />}{t(saving ? "Saving" : "Save settings")}</button></div>
  </form>;
}
