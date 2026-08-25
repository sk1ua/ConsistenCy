import { Bot, FileSearch, Gauge, Layers, Workflow } from "lucide-react";
import type { HealthResponse, SettingsSnapshot } from "../../api/client";
import { useI18n } from "../../i18n";
import { SettingHelp } from "../SettingHelp";

export interface ReviewsSettingsSectionProps {
  /** SAVED settings snapshot; drives the saved-vs-active model drift note. */
  settings?: SettingsSnapshot;
  /** ACTIVE runtime truth from /health; health-derived rows hide when absent. */
  health?: HealthResponse;
}

function providerLabel(provider: string): string {
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "openai") return "OpenAI";
  return provider;
}

/**
 * Shared read-only Reviews status presentation for the Settings Dialog and
 * the /settings page. There is no global review policy system: the global
 * default model lives in the Models section (Settings ≠ Active — the row
 * shows the ACTIVE provider from /health and echoes the restart banner's
 * saved-vs-active truth when the two disagree), the effective review
 * pipeline workflow comes from the CONSISTENCY_REVIEW_WORKFLOW environment
 * variable via /health (distinct from per-repository workflow bindings),
 * context limits are fixed compile-time constants, worker concurrency is
 * owned by the Runtime section and in-review agent concurrency is fixed at
 * 1. Per-review overrides happen in the review composer. No row here is
 * interactive and nothing here persists a new setting.
 */
export function ReviewsSettingsSection({ settings, health }: ReviewsSettingsSectionProps) {
  const { t } = useI18n();

  const activeConfigured = health?.llmProvider === "deepseek" || health?.llmProvider === "openai";
  const activeModelLabel = !health || !activeConfigured
    ? t("Not configured")
    : `${providerLabel(health.llmProvider)}${health.llmModel ? ` · ${health.llmModel}` : ""}`;

  const savedProvider = settings?.llm.provider;
  const savedModel = savedProvider === "deepseek"
    ? settings?.llm.deepseekModel
    : savedProvider === "openai"
      ? settings?.llm.openaiModel
      : undefined;
  const savedModelLabel = !settings || (savedProvider !== "deepseek" && savedProvider !== "openai")
    ? t("Not active")
    : `${providerLabel(savedProvider)}${savedModel ? ` · ${savedModel}` : ""}`;
  const modelDrift = health !== undefined && settings !== undefined
    && (savedProvider !== health.llmProvider || savedModel !== health.llmModel);

  const reviewWorkflow = health?.configuration.reviewWorkflow;
  const activeWorkerConcurrency = health?.configuration.workerConcurrency;

  return <section className="settings-group section-block">
    <div className="settings-group-title"><FileSearch size={18} /><div><h3>{t("Review defaults")}</h3><p>{t("Read-only defaults for new reviews. Per-review choices happen in the review composer.")}</p></div></div>
    <div className="settings-fields">
      {health && (
        <div className="setting-field setting-note runtime-active-note" id="setting-reviews-model"><Bot size={17} /><div><strong>{t("Default model")}</strong><p>{activeModelLabel}</p>{modelDrift && <p className="runtime-drift-notice">{t("Saved {saved} · Active {active} — restart required", { saved: savedModelLabel, active: activeModelLabel })}</p>}<SettingHelp id="setting-reviews-model-help" text="Change the global default in the Models section; each review can override the model in the review composer." /></div></div>
      )}
      {health && (
        <div className="setting-field setting-note" id="setting-reviews-workflow"><Workflow size={17} /><div><strong>{t("Review workflow")}</strong><p>{reviewWorkflow ?? t("Not reported")}</p><SettingHelp id="setting-reviews-workflow-help" text="Effective review pipeline workflow set by the CONSISTENCY_REVIEW_WORKFLOW environment variable; repository-level workflow bindings live in the repository Workflows tab." /></div></div>
      )}
      {/*
        Fixed compile-time context limits. The web bundle cannot import API
        internals, so the display values mirror the constants at their source:
        per-file 256 KB and total 2 MB (apps/api/src/review/context/fileLoader.ts
        DEFAULT_MAX_FILE_BYTES / DEFAULT_MAX_TOTAL_BYTES) and diff 1 MB
        (apps/api/src/review/context/buildLocalContext.ts DEFAULT_MAX_DIFF_BYTES).
      */}
      <div className="setting-field setting-note" id="setting-reviews-context"><Layers size={17} /><div><strong>{t("Context limits")}</strong><p>{t("Per file 256 KB · Total 2 MB · Diff 1 MB")}</p><SettingHelp id="setting-reviews-context-help" text="Fixed compile-time limits; not configurable in this version." /></div></div>
      {health && (
        <div className="setting-field setting-note" id="setting-reviews-concurrency"><Gauge size={17} /><div><strong>{t("Concurrency")}</strong><p>{t("Workers {count} · In-review agent concurrency fixed at 1", { count: activeWorkerConcurrency ?? health.worker.concurrency })}</p><SettingHelp id="setting-reviews-concurrency-help" text="Adjust worker concurrency in the Runtime section; agent concurrency inside a single review is fixed at 1 in this version." /></div></div>
      )}
      <div className="setting-field setting-note" id="setting-reviews-other"><FileSearch size={17} /><div><strong>{t("Other defaults")}</strong><p>{t("Not available yet")}</p><SettingHelp id="setting-reviews-other-help" text="There is no global review policy in this version; per-review settings are overridden in the review composer." /></div></div>
    </div>
  </section>;
}
