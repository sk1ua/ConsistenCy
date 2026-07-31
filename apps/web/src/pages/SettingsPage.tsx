import { Check, CheckCircle2, Database, Github, KeyRound, LoaderCircle, LockKeyhole, RotateCcw, Save, ServerCog, Sparkles, XCircle } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type HealthResponse, type SettingsPatch, type SettingsSnapshot } from "../api/client";
import { useI18n } from "../i18n";

type SecretName = "deepseekApiKey" | "openaiApiKey" | "privateKey" | "webhookSecret";
type SecretDrafts = Record<SecretName, string>;
type ClearSecrets = Record<SecretName, boolean>;

const emptySecrets: SecretDrafts = { deepseekApiKey: "", openaiApiKey: "", privateKey: "", webhookSecret: "" };
const keepSecrets: ClearSecrets = { deepseekApiKey: false, openaiApiKey: false, privateKey: false, webhookSecret: false };

function ConfigRow({ icon: Icon, label, value, ok }: { icon: typeof Github; label: string; value: string; ok?: boolean }) {
  return <div className="config-row"><Icon size={18} /><span><strong>{label}</strong><small>{value}</small></span>{ok === undefined ? null : ok ? <CheckCircle2 className="ok" size={18} /> : <XCircle className="bad" size={18} />}</div>;
}

function SecretField({ name, label, configured, value, clear, multiline = false, onValue, onClear }: {
  name: SecretName;
  label: string;
  configured: boolean;
  value: string;
  clear: boolean;
  multiline?: boolean;
  onValue: (name: SecretName, value: string) => void;
  onClear: (name: SecretName, value: boolean) => void;
}) {
  const { t } = useI18n();
  const id = `setting-${name}`;
  return <div className="setting-field secret-field">
    <label htmlFor={id}>{t(label)}<span className={configured ? "configured" : "missing"}>{t(configured ? "Configured" : "Not configured")}</span></label>
    {multiline
      ? <textarea id={id} rows={3} value={value} disabled={clear} onChange={event => onValue(name, event.target.value)} placeholder={t(configured ? "Leave blank to keep the stored value" : "Paste a PEM key or enter a readable file path")} />
      : <input id={id} type="password" autoComplete="new-password" value={value} disabled={clear} onChange={event => onValue(name, event.target.value)} placeholder={t(configured ? "Leave blank to keep the stored value" : "Enter a new secret")} />}
    {configured && <label className="clear-secret"><input type="checkbox" checked={clear} onChange={event => onClear(name, event.target.checked)} />{t("Remove the stored value")}</label>}
  </div>;
}

function secretValue(value: string, clear: boolean): string | null | undefined {
  if (clear) return null;
  return value.trim() || undefined;
}

export function SettingsPage({ health }: { health?: HealthResponse }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<SettingsSnapshot>();
  const [draft, setDraft] = useState<SettingsSnapshot>();
  const [secrets, setSecrets] = useState<SecretDrafts>(emptySecrets);
  const [clearSecrets, setClearSecrets] = useState<ClearSecrets>(keepSecrets);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();

  useEffect(() => {
    let active = true;
    void api.settings().then(loaded => {
      if (!active) return;
      setSettings(loaded);
      setDraft(loaded);
    }).catch(error => {
      if (active) setMessage({ tone: "error", text: error instanceof Error ? error.message : t("Could not load settings") });
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const readiness = useMemo(() => {
    if (!draft) return { complete: 0, total: 3 };
    return {
      complete: Number(draft.llm.provider === "mock" || (draft.llm.provider === "deepseek" ? draft.llm.deepseekApiKeyConfigured : draft.llm.openaiApiKeyConfigured))
        + Number(Boolean(draft.github.appId && draft.github.privateKeyConfigured && draft.github.webhookSecretConfigured))
        + Number(Boolean(draft.runtime.databasePath && draft.runtime.workspaceRoot)),
      total: 3
    };
  }, [draft]);

  function updateSecret(name: SecretName, value: string) {
    setSecrets(current => ({ ...current, [name]: value }));
  }

  function updateClear(name: SecretName, value: boolean) {
    setClearSecrets(current => ({ ...current, [name]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setMessage(undefined);
    const patch: SettingsPatch = {
      llm: {
        provider: draft.llm.provider,
        deepseekBaseUrl: draft.llm.deepseekBaseUrl,
        deepseekModel: draft.llm.deepseekModel,
        openaiModel: draft.llm.openaiModel,
        deepseekApiKey: secretValue(secrets.deepseekApiKey, clearSecrets.deepseekApiKey),
        openaiApiKey: secretValue(secrets.openaiApiKey, clearSecrets.openaiApiKey)
      },
      github: {
        appId: draft.github.appId || null,
        privateKey: secretValue(secrets.privateKey, clearSecrets.privateKey),
        webhookSecret: secretValue(secrets.webhookSecret, clearSecrets.webhookSecret)
      },
      runtime: {
        databasePath: draft.runtime.databasePath,
        workspaceRoot: draft.runtime.workspaceRoot,
        workerConcurrency: draft.runtime.workerConcurrency,
        workerPollIntervalMs: draft.runtime.workerPollIntervalMs,
        webUrl: draft.runtime.webUrl
      }
    };
    try {
      const updated = await api.updateSettings(patch);
      setSettings(updated);
      setDraft(updated);
      setSecrets(emptySecrets);
      setClearSecrets(keepSecrets);
      setMessage({ tone: "success", text: t("Settings saved. Restart the API to apply the new runtime configuration.") });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : t("Could not save settings") });
    } finally {
      setSaving(false);
    }
  }

  if (!health) return <div className="empty-state">{t("Start the API to configure this workspace from the browser.")}</div>;
  if (loading) return <div className="loading-state"><LoaderCircle size={22} /><span>{t("Loading configuration")}</span></div>;
  if (!draft || !settings) return <div className="empty-state">{t("Configuration editor is unavailable. Run {command} for details.", { command: "npm run config -- doctor" })}</div>;

  const llmReady = draft.llm.provider === "mock" || (draft.llm.provider === "deepseek" ? draft.llm.deepseekApiKeyConfigured : draft.llm.openaiApiKeyConfigured);
  const githubReady = Boolean(draft.github.appId && draft.github.privateKeyConfigured && draft.github.webhookSecretConfigured);
  return <form className="settings-editor" onSubmit={event => void save(event)}>
    <section className="settings-intro">
      <div><span className="eyebrow"><Sparkles size={15} />{t("Workspace setup")}</span><h2>{t("Configure the review pipeline without editing environment files.")}</h2><p>{t("Secrets can be replaced but are never returned to this page. Environment variables remain the final override.")}</p></div>
      <div className="readiness-score"><strong>{readiness.complete}/{readiness.total}</strong><span>{t("configuration groups ready")}</span></div>
      <div className="setup-rail" aria-label={t("Configuration readiness")}>
        <span className={llmReady ? "ready" : ""}><i>{llmReady ? <Check size={12} /> : "1"}</i>{t("Model")}</span>
        <span className={githubReady ? "ready" : ""}><i>{githubReady ? <Check size={12} /> : "2"}</i>{t("GitHub")}</span>
        <span className="ready"><i><Check size={12} /></i>{t("Runtime")}</span>
      </div>
    </section>

    {message && <div className={`settings-message ${message.tone}`} role="status">{message.text}</div>}
    {draft.overriddenByEnvironment.length > 0 && <div className="settings-message warning">{t("Environment variables override: {keys}", { keys: draft.overriddenByEnvironment.join(", ") })}</div>}

    <section className="settings-group section-block">
      <div className="settings-group-title"><Sparkles size={18} /><div><span>{t("01 · Model")}</span><h3>{t("Review intelligence heading")}</h3><p>{t("Choose the model used for evidence synthesis and reviewer handoff.")}</p></div></div>
      <div className="settings-fields">
        <div className="setting-field"><label htmlFor="setting-provider">{t("Provider")}</label><select id="setting-provider" value={draft.llm.provider} onChange={event => setDraft(current => current ? ({ ...current, llm: { ...current.llm, provider: event.target.value as SettingsSnapshot["llm"]["provider"] } }) : current)}><option value="mock">{t("Mock · no external model")}</option><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option></select></div>
        {draft.llm.provider === "deepseek" && <>
          <div className="setting-field"><label htmlFor="setting-deepseek-model">{t("Model")}</label><input id="setting-deepseek-model" value={draft.llm.deepseekModel} onChange={event => setDraft(current => current ? ({ ...current, llm: { ...current.llm, deepseekModel: event.target.value } }) : current)} /></div>
          <div className="setting-field setting-field-wide"><label htmlFor="setting-deepseek-url">Base URL</label><input id="setting-deepseek-url" type="url" value={draft.llm.deepseekBaseUrl} onChange={event => setDraft(current => current ? ({ ...current, llm: { ...current.llm, deepseekBaseUrl: event.target.value } }) : current)} /></div>
          <SecretField name="deepseekApiKey" label="DeepSeek API key" configured={settings.llm.deepseekApiKeyConfigured} value={secrets.deepseekApiKey} clear={clearSecrets.deepseekApiKey} onValue={updateSecret} onClear={updateClear} />
        </>}
        {draft.llm.provider === "openai" && <>
          <div className="setting-field"><label htmlFor="setting-openai-model">{t("Model")}</label><input id="setting-openai-model" value={draft.llm.openaiModel} onChange={event => setDraft(current => current ? ({ ...current, llm: { ...current.llm, openaiModel: event.target.value } }) : current)} /></div>
          <SecretField name="openaiApiKey" label="OpenAI API key" configured={settings.llm.openaiApiKeyConfigured} value={secrets.openaiApiKey} clear={clearSecrets.openaiApiKey} onValue={updateSecret} onClear={updateClear} />
        </>}
      </div>
    </section>

    <section className="settings-group section-block">
      <div className="settings-group-title"><Github size={18} /><div><span>{t("02 · GitHub")}</span><h3>{t("Pull request connection")}</h3><p>{t("Connect signed webhook events to authenticated repository analysis.")}</p></div></div>
      <div className="settings-fields">
        <div className="setting-field"><label htmlFor="setting-app-id">{t("GitHub App ID")}</label><input id="setting-app-id" value={draft.github.appId} onChange={event => setDraft(current => current ? ({ ...current, github: { ...current.github, appId: event.target.value } }) : current)} placeholder="123456" /></div>
        <SecretField name="webhookSecret" label="Webhook secret" configured={settings.github.webhookSecretConfigured} value={secrets.webhookSecret} clear={clearSecrets.webhookSecret} onValue={updateSecret} onClear={updateClear} />
        <div className="setting-field-wide"><SecretField name="privateKey" label="Private key" configured={settings.github.privateKeyConfigured} value={secrets.privateKey} clear={clearSecrets.privateKey} multiline onValue={updateSecret} onClear={updateClear} /></div>
      </div>
    </section>

    <section className="settings-group section-block">
      <div className="settings-group-title"><ServerCog size={18} /><div><span>{t("03 · Runtime")}</span><h3>{t("Local service")}</h3><p>{t("Control storage, workspace isolation and worker throughput.")}</p></div></div>
      <div className="settings-fields">
        <div className="setting-field"><label htmlFor="setting-database">{t("Database path")}</label><input id="setting-database" value={draft.runtime.databasePath} onChange={event => setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, databasePath: event.target.value } }) : current)} /></div>
        <div className="setting-field"><label htmlFor="setting-workspace">{t("Workspace root")}</label><input id="setting-workspace" value={draft.runtime.workspaceRoot} onChange={event => setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, workspaceRoot: event.target.value } }) : current)} /></div>
        <div className="setting-field"><label htmlFor="setting-concurrency">{t("Worker concurrency")}</label><input id="setting-concurrency" type="number" min="1" max="16" value={draft.runtime.workerConcurrency} onChange={event => setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, workerConcurrency: Number(event.target.value) } }) : current)} /></div>
        <div className="setting-field"><label htmlFor="setting-poll">{t("Poll interval (ms)")}</label><input id="setting-poll" type="number" min="50" max="60000" value={draft.runtime.workerPollIntervalMs} onChange={event => setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, workerPollIntervalMs: Number(event.target.value) } }) : current)} /></div>
        <div className="setting-field setting-field-wide"><label htmlFor="setting-web-url">{t("Web URL")}</label><input id="setting-web-url" type="url" value={draft.runtime.webUrl} onChange={event => setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, webUrl: event.target.value } }) : current)} /></div>
        <div className="setting-field setting-field-wide setting-note"><LockKeyhole size={17} /><div><strong>{t("API bearer token")}</strong><p>{t(settings.runtime.apiTokenConfigured ? "Configured for the API. Keep VITE_API_TOKEN synchronized before restarting the web app." : "Optional. Configure it from the CLI so the API and Vite client can be updated together.")}</p><code>npm run config -- set runtime.api-token</code></div></div>
      </div>
    </section>

    <section className="settings-status section-block">
      <div className="section-heading"><div><h2>{t("Active runtime")}</h2><p>{t("These values describe the currently running API process.")}</p></div></div>
      <div className="config-list">
        <ConfigRow icon={Github} label={t("GitHub App")} value={t(health.configuration.githubAppConfigured ? "Configured" : "Not configured")} ok={health.configuration.githubAppConfigured} />
        <ConfigRow icon={KeyRound} label={t("Webhook secret")} value={t(health.configuration.webhookSecretConfigured ? "Configured" : "Not configured")} ok={health.configuration.webhookSecretConfigured} />
        <ConfigRow icon={ServerCog} label={t("LLM provider")} value={health.llmProvider} />
        <ConfigRow icon={ServerCog} label={t("Worker")} value={t(health.worker.running ? "Running · concurrency {count}" : "Stopped · concurrency {count}", { count: health.worker.concurrency })} ok={health.worker.running} />
        <ConfigRow icon={Database} label={t("Database")} value={health.configuration.databasePath} ok={health.database.ok} />
      </div>
    </section>

    <div className="settings-actions"><span><LockKeyhole size={15} />{t("Secrets are encrypted locally and never returned.")}</span><button className="secondary-button" type="button" onClick={() => { setDraft(settings); setSecrets(emptySecrets); setClearSecrets(keepSecrets); setMessage(undefined); }}><RotateCcw size={15} />{t("Reset changes")}</button><button className="save-settings" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spinning" size={16} /> : <Save size={16} />}{t(saving ? "Saving" : "Save settings")}</button></div>
  </form>;
}
