import { Check, CheckCircle2, Database, Globe2, Github, KeyRound, LoaderCircle, LockKeyhole, RotateCcw, Save, ServerCog, XCircle } from "lucide-react";
import type { FormEvent } from "react";
import type { HealthResponse } from "../api/client";
import { SettingHelp } from "../components/SettingHelp";
import { ModelSettingsSection } from "../components/settings/ModelSettingsSection";
import { GitHubSettingsSection } from "../components/settings/GitHubSettingsSection";
import { desktopBridge } from "../desktop";
import { useI18n } from "../i18n";
import { useSettingsForm } from "../hooks/useSettingsForm";

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
    />

    <section className="settings-group section-block">
      <div className="settings-group-title"><ServerCog size={18} /><div><span>{t("03 · Runtime")}</span><h3>{t("Local service")}</h3><p>{t("Control storage, workspace isolation and worker throughput.")}</p></div></div>
      <div className="settings-fields">
        <div className="setting-field setting-note"><Database size={17} /><div><strong>{t("Database")}</strong><p>{t(draft.runtime.storage.kind === "memory" ? "In-memory storage configured" : "Local file storage configured")}</p><SettingHelp id="setting-database-help" text="The local filesystem location is owned by the API process and is never sent to the renderer." /></div></div>
        <div className="setting-field setting-note"><ServerCog size={17} /><div><strong>{t("Workspace")}</strong><p>{t(draft.runtime.workspace.configured ? "Review workspace configured" : "Review workspace not configured")}</p><SettingHelp id="setting-workspace-help" text="Choose local folders through the privileged desktop folder picker; raw paths do not cross into Web UI state." /></div></div>
        <div className="setting-field"><label htmlFor="setting-concurrency">{t("Worker concurrency")}</label><input id="setting-concurrency" aria-describedby="setting-concurrency-help" type="number" min="1" max="16" value={draft.runtime.workerConcurrency} onChange={event => updateRuntime({ workerConcurrency: Number(event.target.value) })} /><SettingHelp id="setting-concurrency-help" text="Start with 1. Increase only after checking CPU, memory and provider rate limits." /></div>
        <div className="setting-field"><label htmlFor="setting-poll">{t("Poll interval (ms)")}</label><input id="setting-poll" aria-describedby="setting-poll-help" type="number" min="50" max="60000" value={draft.runtime.workerPollIntervalMs} onChange={event => updateRuntime({ workerPollIntervalMs: Number(event.target.value) })} /><SettingHelp id="setting-poll-help" text="How often the worker checks for queued jobs. The default is appropriate for local use." /></div>
        <div className="setting-field setting-field-wide"><label htmlFor="setting-web-url">{t("Web URL")}</label><input id="setting-web-url" aria-describedby="setting-web-url-help" type="url" value={draft.runtime.webUrl} onChange={event => updateRuntime({ webUrl: event.target.value })} /><SettingHelp id="setting-web-url-help" text="The browser URL used in links and callbacks, usually http://127.0.0.1:5173 for local development." /></div>
        <div className="setting-field setting-field-wide setting-note"><LockKeyhole size={17} /><div><strong>{t("API session")}</strong><p>{t(settings.runtime.apiTokenConfigured ? "Protected API session configured" : "Browser development session is not protected")}</p><code>npm run config -- set runtime.api-token</code><SettingHelp id="setting-api-token-help" text="Electron owns its one-time session token in the main process. The renderer never receives or stores that token." /></div></div>
      </div>
    </section>

    <section className="settings-status section-block">
      <div className="section-heading"><div><h2>{t("Active runtime")}</h2><p>{t("These values describe the currently running API process.")}</p></div></div>
      <div className="config-list">
        <ConfigRow icon={Github} label={t("GitHub App")} value={t(health.configuration.githubAppConfigured ? "Configured" : "Not configured")} ok={health.configuration.githubAppConfigured} />
        <ConfigRow icon={KeyRound} label={t("Webhook secret")} value={t(health.configuration.webhookSecretConfigured ? "Configured" : "Not configured")} ok={health.configuration.webhookSecretConfigured} />
        <ConfigRow icon={Globe2} label={t("Public PR access")} value={health.publicPrAccessMode === "pat" ? t("PAT read") : health.publicPrAccessMode === "disabled" ? t("Disabled") : t("Anonymous read")} ok={health.publicPrAccessMode !== "disabled"} />
        <ConfigRow icon={KeyRound} label={t("Public read token")} value={t(health.configuration.publicReadTokenConfigured ? "Configured" : "Not configured")} ok={health.configuration.publicReadTokenConfigured} />
        <ConfigRow icon={ServerCog} label={t("LLM provider")} value={health.llmProvider} />
        <ConfigRow icon={ServerCog} label={t("Worker")} value={t(health.worker.running ? "Running · concurrency {count}" : "Stopped · concurrency {count}", { count: health.worker.concurrency })} ok={health.worker.running} />
        <ConfigRow icon={Database} label={t("Database")} value={t(health.configuration.storage.kind === "memory" ? "In-memory storage" : "Local file storage")} ok={health.database.ok && health.configuration.storage.configured} />
      </div>
    </section>

    <div className="settings-actions"><span><LockKeyhole size={15} />{t("Secrets are encrypted locally and never returned.")}</span><button className="secondary-button" type="button" onClick={resetChanges}><RotateCcw size={15} />{t("Reset changes")}</button><button className="save-settings" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spinning" size={16} /> : <Save size={16} />}{t(saving ? "Saving" : "Save settings")}</button></div>
  </form>;
}
