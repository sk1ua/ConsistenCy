import { Activity, Database, FolderGit2, LockKeyhole, ServerCog } from "lucide-react";
import type { HealthResponse, SettingsSnapshot } from "../../api/client";
import { useI18n } from "../../i18n";
import { SettingHelp } from "../SettingHelp";

export interface RuntimeSettingsSectionProps {
  draft: SettingsSnapshot;
  settings: SettingsSnapshot;
  health?: HealthResponse;
  updateRuntime: (patch: Partial<SettingsSnapshot["runtime"]>) => void;
}

export function RuntimeSettingsSection({
  draft,
  settings,
  health,
  updateRuntime
}: RuntimeSettingsSectionProps) {
  const { t } = useI18n();

  // Desired-vs-active truth: the saved draft describes what should run after a
  // restart; /health describes the running process. Only surface the drift
  // notice when the two disagree — restartRequired stays the authoritative
  // global banner, this is the runtime-local, data-derived echo of it.
  const activeConcurrency = health?.configuration?.workerConcurrency;
  const concurrencyDrift = activeConcurrency !== undefined && activeConcurrency !== settings.runtime.workerConcurrency;

  return <section className="settings-group section-block">
    <div className="settings-group-title"><ServerCog size={18} /><div><span>{t("03 · Runtime")}</span><h3>{t("Local service")}</h3><p>{t("Control storage, workspace isolation and worker throughput.")}</p></div></div>
    <div className="settings-fields">
      <div className="setting-field setting-note"><Database size={17} /><div><strong>{t("Database")}</strong><p>{t(draft.runtime.storage.kind === "memory" ? "In-memory storage configured" : "Local file storage configured")}</p><SettingHelp id="setting-database-help" text="The local filesystem location is owned by the API process and is never sent to the renderer." /></div></div>
      <div className="setting-field setting-note"><ServerCog size={17} /><div><strong>{t("Workspace")}</strong><p>{t(draft.runtime.workspace.configured ? "Review workspace configured" : "Review workspace not configured")}</p><SettingHelp id="setting-workspace-help" text="Choose local folders through the privileged desktop folder picker; raw paths do not cross into Web UI state." /></div></div>
      <div className="setting-field setting-note"><FolderGit2 size={17} /><div><strong>{t("Local review roots")}</strong><p>{t(draft.runtime.localReview.configured ? "Local review roots configured: {count}" : "No local review roots configured", { count: draft.runtime.localReview.rootCount })}</p><SettingHelp id="setting-local-roots-help" text="Local review roots are picked through the privileged desktop folder picker; raw paths never cross into Web UI state." /></div></div>
      <div className="setting-field"><label htmlFor="setting-concurrency">{t("Worker concurrency")}</label><input id="setting-concurrency" aria-describedby="setting-concurrency-help" type="number" min="1" max="16" value={draft.runtime.workerConcurrency} onChange={event => updateRuntime({ workerConcurrency: Number(event.target.value) })} /><SettingHelp id="setting-concurrency-help" text="Start with 1. Increase only after checking CPU, memory and provider rate limits." /></div>
      <div className="setting-field"><label htmlFor="setting-poll">{t("Poll interval (ms)")}</label><input id="setting-poll" aria-describedby="setting-poll-help" type="number" min="50" max="60000" value={draft.runtime.workerPollIntervalMs} onChange={event => updateRuntime({ workerPollIntervalMs: Number(event.target.value) })} /><SettingHelp id="setting-poll-help" text="How often the worker checks for queued jobs. The default is appropriate for local use." /></div>
      <div className="setting-field setting-field-wide"><label htmlFor="setting-web-url">{t("Web URL")}</label><input id="setting-web-url" aria-describedby="setting-web-url-help" type="url" value={draft.runtime.webUrl} onChange={event => updateRuntime({ webUrl: event.target.value })} /><SettingHelp id="setting-web-url-help" text="The browser URL used in links and callbacks, usually http://127.0.0.1:5173 for local development." /></div>
      <div className="setting-field setting-field-wide setting-note"><LockKeyhole size={17} /><div><strong>{t("API session")}</strong><p>{t(settings.runtime.apiTokenConfigured ? "Protected API session configured" : "Browser development session is not protected")}</p><code>npm run config -- set runtime.api-token</code><SettingHelp id="setting-api-token-help" text="Electron owns its one-time session token in the main process. The renderer never receives or stores that token." /></div></div>
      {health && (
        <div className="setting-field setting-field-wide setting-note runtime-active-note">
          <Activity size={17} />
          <div>
            <strong>{t("Active runtime")}</strong>
            <p>{t("Worker")}: {t(health.worker.running ? "Running · concurrency {count} · {jobs} active jobs" : "Stopped · concurrency {count}", { count: health.worker.concurrency, jobs: health.worker.activeJobs })}</p>
            <p>{t("Database")}: {t(health.configuration.storage.kind === "memory" ? "In-memory storage" : "Local file storage")}</p>
            {concurrencyDrift && (
              <p className="runtime-drift-notice">{t("Saved {saved} · Active {active} — restart required", { saved: settings.runtime.workerConcurrency, active: activeConcurrency })}</p>
            )}
            <SettingHelp id="setting-active-runtime-help" text="These values describe the currently running API process." />
          </div>
        </div>
      )}
    </div>
  </section>;
}
