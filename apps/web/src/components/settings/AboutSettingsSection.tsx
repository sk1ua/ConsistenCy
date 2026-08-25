import { Braces, Cpu, FolderOpen, GitCommit, Info, Monitor, ServerCog, Tag } from "lucide-react";
import { useState } from "react";
import type { HealthResponse } from "../../api/client";
import { desktopBridge, type BuildInfoSummary } from "../../desktop";
import { useI18n } from "../../i18n";
import { SettingHelp } from "../SettingHelp";

export interface AboutSettingsSectionProps {
  health?: HealthResponse;
  buildInfo?: BuildInfoSummary | null;
}

/**
 * Shared About presentation for the Settings Dialog and the /settings page.
 * Every row is grounded in an existing capability: build identity comes from
 * the desktop buildInfo bridge (undefined in the browser, which degrades to an
 * explicit not-available note), service / engine / schema version come
 * straight from the /health payload, and the runtime mode is derived from
 * desktop bridge presence. The full commit SHA is public repository data and
 * only ever appears in a title attribute — no filesystem paths, tokens, or
 * environment versions are surfaced here.
 *
 * The one interactive control is the semantic "Open logs folder" action: the
 * bridge method takes no arguments and returns only a boolean, the main
 * process resolves the folder itself, and no path value ever reaches this
 * renderer. Browsers (and hosts without the method) get the standard
 * desktop-only degradation note instead of a button.
 */
export function AboutSettingsSection({ health, buildInfo }: AboutSettingsSectionProps) {
  const { t } = useI18n();
  const inDesktopShell = Boolean(desktopBridge());
  const openLogsFolder = desktopBridge()?.openLogsFolder;
  const [logsState, setLogsState] = useState<"idle" | "opening" | "opened" | "failed">("idle");
  // Desktop shell with the async buildInfo resolve still pending: a neutral
  // loading note, not the browser-mode desktop-only degradation.
  const buildInfoPending = inDesktopShell && buildInfo == null;
  const buildUnavailableNote = t("Provided by the desktop build only.");
  const versionRow = buildInfo?.version
    ? <p><code>{buildInfo.version}</code></p>
    : <p>{buildInfoPending ? t("Reading build information…") : buildUnavailableNote}</p>;
  const buildRow = buildInfo?.commitSha
    ? <p><code title={`Commit ${buildInfo.commitSha}`}>{buildInfo.commitSha.slice(0, 7)}</code></p>
    : <p>{buildInfoPending ? t("Reading build information…") : buildUnavailableNote}</p>;

  async function openLogs(): Promise<void> {
    if (!openLogsFolder) return;
    setLogsState("opening");
    try {
      const result = await openLogsFolder();
      setLogsState(result?.ok ? "opened" : "failed");
    } catch {
      setLogsState("failed");
    }
  }

  return <section className="settings-group section-block">
    <div className="settings-group-title"><Info size={18} /><div><span>{t("06 · About")}</span><h3>{t("Version and environment")}</h3><p>{t("Build identity, API service and runtime mode. These rows are read-only status.")}</p></div></div>
    <div className="settings-fields">
      <div className="setting-field setting-note" id="setting-about-version"><Tag size={17} /><div><strong>{t("ConsistenCy version")}</strong>{versionRow}<SettingHelp id="setting-about-version-help" text="The desktop host reports its build through the buildInfo bridge; no such bridge exists in the browser." /></div></div>
      <div className="setting-field setting-note" id="setting-about-build"><GitCommit size={17} /><div><strong>{t("Build")}</strong>{buildRow}<SettingHelp id="setting-about-build-help" text="Short commit identifier of the desktop build; hover for the full SHA." /></div></div>
      {health?.service && (
        <div className="setting-field setting-note" id="setting-about-service"><ServerCog size={17} /><div><strong>{t("API service")}</strong><p><code>{health.service}</code></p><SettingHelp id="setting-about-service-help" text="Service identifier reported by the /health endpoint." /></div></div>
      )}
      {health?.engine && (
        <div className="setting-field setting-note" id="setting-about-engine"><Cpu size={17} /><div><strong>{t("Engine")}</strong><p><code>{health.engine}</code></p><SettingHelp id="setting-about-engine-help" text="Deterministic analysis engine behind the API." /></div></div>
      )}
      {health?.schemaVersion && (
        <div className="setting-field setting-note" id="setting-about-schema"><Braces size={17} /><div><strong>{t("Schema version")}</strong><p><code>{health.schemaVersion}</code></p><SettingHelp id="setting-about-schema-help" text="Protocol version shared by the API and the engine." /></div></div>
      )}
      <div className="setting-field setting-note" id="setting-about-mode"><Monitor size={17} /><div><strong>{t("Runtime mode")}</strong><p>{t(inDesktopShell ? "Desktop" : "Browser")}</p><SettingHelp id="setting-about-mode-help" text="Derived from the presence of the desktop bridge in this renderer." /></div></div>
      {openLogsFolder ? (
        <div className="setting-field setting-field-wide setting-note" id="setting-about-logs-row">
          <FolderOpen size={17} />
          <div>
            <strong>{t("Logs")}</strong>
            <p id="setting-about-logs-status" role="status">
              {logsState === "idle" && t("The main and API logs are written to the desktop app's own data folder.")}
              {logsState === "opening" && t("Opening logs folder…")}
              {logsState === "opened" && t("Logs folder opened.")}
              {logsState === "failed" && t("Could not open the logs folder.")}
            </p>
            <button
              type="button"
              id="setting-about-open-logs"
              className="secondary-button"
              disabled={logsState === "opening"}
              onClick={() => void openLogs()}
            >
              <FolderOpen size={13} />
              {t("Open logs folder")}
            </button>
            <SettingHelp id="setting-about-open-logs-help" text="Opens the desktop app's own data folder — where the main and API logs live — in your file manager. The folder location stays in the main process; no path is shown or sent to this page." />
          </div>
        </div>
      ) : (
        <div className="setting-field setting-note" id="setting-about-logs-row"><FolderOpen size={17} /><div><strong>{t("Logs")}</strong><p>{t("Provided by the desktop build only.")}</p></div></div>
      )}
    </div>
  </section>;
}
