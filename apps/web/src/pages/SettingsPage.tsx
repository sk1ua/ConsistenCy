import { Check, CheckCircle2, Database, Globe2, Github, KeyRound, LoaderCircle, LockKeyhole, RotateCcw, Save, ServerCog, Sparkles, XCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, type HealthResponse, type SettingsPatch, type SettingsSnapshot } from "../api/client";
import { SETTING_HELP_LINKS, SettingHelp } from "../components/SettingHelp";
import { useI18n } from "../i18n";

type SecretName = "deepseekApiKey" | "openaiApiKey" | "privateKey" | "webhookSecret" | "publicReadToken";
type SecretDrafts = Record<SecretName, string>;
type ClearSecrets = Record<SecretName, boolean>;

const emptySecrets: SecretDrafts = {
  deepseekApiKey: "",
  openaiApiKey: "",
  privateKey: "",
  webhookSecret: "",
  publicReadToken: ""
};
const keepSecrets: ClearSecrets = {
  deepseekApiKey: false,
  openaiApiKey: false,
  privateKey: false,
  webhookSecret: false,
  publicReadToken: false
};

function safeEditablePath(value: string, fallback: string): string {
  const normalized = value.replaceAll("\\", "/");
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/") ? fallback : value;
}

function ConfigRow({ icon: Icon, label, value, ok, redact }: { icon: typeof Github; label: string; value: string; ok?: boolean; redact?: boolean }) {
  const { t } = useI18n();
  return <div className="config-row"><Icon size={18} /><span><strong>{label}</strong><small>{redact ? t("Local database configured") : value}</small></span>{ok === undefined ? null : ok ? <CheckCircle2 className="ok" size={18} /> : <XCircle className="bad" size={18} />}</div>;
}

function SecretField({ name, label, configured, value, clear, help, helpHref, multiline = false, onValue, onClear }: {
  name: SecretName;
  label: string;
  configured: boolean;
  value: string;
  clear: boolean;
  help: string;
  helpHref?: string;
  multiline?: boolean;
  onValue: (name: SecretName, value: string) => void;
  onClear: (name: SecretName, value: boolean) => void;
}) {
  const { t } = useI18n();
  const id = `setting-${name}`;
  const helpId = `${id}-help`;
  return <div className="setting-field secret-field">
    <label htmlFor={id}>{t(label)}<span className={configured ? "configured" : "missing"}>{t(configured ? "Configured" : "Not configured")}</span></label>
    {multiline
      ? <textarea id={id} aria-describedby={helpId} rows={3} value={value} disabled={clear} onChange={event => onValue(name, event.target.value)} placeholder={t(configured ? "Leave blank to keep the stored value" : "Paste a PEM key or enter a readable file path")} />
      : <input id={id} aria-describedby={helpId} type="password" autoComplete="new-password" value={value} disabled={clear} onChange={event => onValue(name, event.target.value)} placeholder={t(configured ? "Leave blank to keep the stored value" : "Enter a new secret")} />}
    <SettingHelp id={helpId} text={help} href={helpHref} />
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

  function updateSecret(name: SecretName, value: string) {
    setSecrets(current => ({ ...current, [name]: value }));
  }

  function updateClear(name: SecretName, value: boolean) {
    setClearSecrets(current => ({ ...current, [name]: value }));
  }

  function secretReady(name: SecretName, configured: boolean): boolean {
    return Boolean(secrets[name].trim()) || (configured && !clearSecrets[name]);
  }

  const llmReady = Boolean(draft && settings && (draft.llm.provider === "mock"
    || (draft.llm.provider === "deepseek" ? secretReady("deepseekApiKey", settings.llm.deepseekApiKeyConfigured) : secretReady("openaiApiKey", settings.llm.openaiApiKeyConfigured))));
  const githubAppReady = Boolean(draft && settings && draft.github.appId
    && secretReady("privateKey", settings.github.privateKeyConfigured)
    && secretReady("webhookSecret", settings.github.webhookSecretConfigured));
  const publicTokenReady = Boolean(settings && secretReady("publicReadToken", settings.github.publicReadTokenConfigured));
  const sourceReady = Boolean(health && (health.publicPrAccessMode !== "disabled" || githubAppReady || publicTokenReady));
  const runtimeReady = Boolean(draft?.runtime.databasePath && draft.runtime.workspaceRoot);
  const readiness = { complete: Number(llmReady) + Number(sourceReady) + Number(runtimeReady), total: 3 };

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
        webhookSecret: secretValue(secrets.webhookSecret, clearSecrets.webhookSecret),
        publicReadToken: secretValue(secrets.publicReadToken, clearSecrets.publicReadToken)
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

  return <form className="settings-editor" onSubmit={event => void save(event)}>
    <section className="settings-intro">
      <div><span className="eyebrow"><Sparkles size={15} />{t("Workspace setup")}</span><h2>{t("Configure the review pipeline without editing environment files.")}</h2><p>{t("Secrets can be replaced but are never returned to this page. Environment variables remain the final override.")}</p></div>
      <div className="readiness-score"><strong>{readiness.complete}/{readiness.total}</strong><span>{t("configuration groups ready")}</span></div>
      <div className="setup-rail" aria-label={t("Configuration readiness")}>
        <span className={llmReady ? "ready" : ""}><i>{llmReady ? <Check size={12} /> : "1"}</i>{t("Model")}</span>
        <span className={sourceReady ? "ready" : ""}><i>{sourceReady ? <Check size={12} /> : "2"}</i>{t("Repository source")}</span>
        <span className={runtimeReady ? "ready" : ""}><i>{runtimeReady ? <Check size={12} /> : "3"}</i>{t("Runtime")}</span>
      </div>
    </section>

    {message && <div className={`settings-message ${message.tone}`} role="status">{message.text}</div>}
    {draft.overriddenByEnvironment.length > 0 && <div className="settings-message warning">{t("Environment variables override: {keys}", { keys: draft.overriddenByEnvironment.join(", ") })}</div>}

    <section className="settings-group section-block">
      <div className="settings-group-title"><Sparkles size={18} /><div><span>{t("01 · Model")}</span><h3>{t("Evidence synthesis model")}</h3><p>{t("Choose the model used for evidence synthesis and reviewer handoff.")}</p></div></div>
      <div className="settings-fields">
        <div className="setting-field"><label htmlFor="setting-provider">{t("Provider")}</label><select id="setting-provider" aria-describedby="setting-provider-help" value={draft.llm.provider} onChange={event => setDraft(current => current ? ({ ...current, llm: { ...current.llm, provider: event.target.value as SettingsSnapshot["llm"]["provider"] } }) : current)}><option value="mock">{t("Mock · no external model")}</option><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option></select><SettingHelp id="setting-provider-help" text="Mock mode needs no API key. Select a provider only when you want LLM synthesis and dialogue." /></div>
        {draft.llm.provider === "deepseek" && <>
          <div className="setting-field"><label htmlFor="setting-deepseek-model">{t("Model")}</label><input id="setting-deepseek-model" aria-describedby="setting-deepseek-model-help" value={draft.llm.deepseekModel} onChange={event => setDraft(current => current ? ({ ...current, llm: { ...current.llm, deepseekModel: event.target.value } }) : current)} /><SettingHelp id="setting-deepseek-model-help" text="Use a model name supported by your DeepSeek account." /></div>
          <div className="setting-field setting-field-wide"><label htmlFor="setting-deepseek-url">{t("Base URL")}</label><input id="setting-deepseek-url" aria-describedby="setting-deepseek-url-help" type="url" value={draft.llm.deepseekBaseUrl} onChange={event => setDraft(current => current ? ({ ...current, llm: { ...current.llm, deepseekBaseUrl: event.target.value } }) : current)} /><SettingHelp id="setting-deepseek-url-help" text="Keep the official endpoint unless your organization provides a compatible gateway." /></div>
          <SecretField name="deepseekApiKey" label="DeepSeek API key" configured={settings.llm.deepseekApiKeyConfigured} value={secrets.deepseekApiKey} clear={clearSecrets.deepseekApiKey} help="Create a key in DeepSeek. Do not paste an account password or browser session token." helpHref={SETTING_HELP_LINKS.deepseekApi} onValue={updateSecret} onClear={updateClear} />
        </>}
        {draft.llm.provider === "openai" && <>
          <div className="setting-field"><label htmlFor="setting-openai-model">{t("Model")}</label><input id="setting-openai-model" aria-describedby="setting-openai-model-help" value={draft.llm.openaiModel} onChange={event => setDraft(current => current ? ({ ...current, llm: { ...current.llm, openaiModel: event.target.value } }) : current)} /><SettingHelp id="setting-openai-model-help" text="Use an API model available to your OpenAI project." /></div>
          <SecretField name="openaiApiKey" label="OpenAI API key" configured={settings.llm.openaiApiKeyConfigured} value={secrets.openaiApiKey} clear={clearSecrets.openaiApiKey} help="Create a project API key. This is not your ChatGPT password or session token." helpHref={SETTING_HELP_LINKS.openaiApiKeys} onValue={updateSecret} onClear={updateClear} />
        </>}
      </div>
    </section>

    <section className="settings-group section-block">
      <div className="settings-group-title"><Github size={18} /><div><span>{t("02 · GitHub")}</span><h3>{t("Pull request connection")}</h3><p>{t("Start with anonymous public PR analysis, then add credentials only for the mode you need.")}</p></div></div>
      <div className="settings-fields">
        <div className="source-mode-guide setting-field-wide" aria-label={t("GitHub connection modes")}>
          <span><strong>{t("Anonymous public PR")}</strong><small>{t("Recommended for trying ConsistenCy. No GitHub App or token is required.")}</small></span>
          <span><strong>{t("Public read token")}</strong><small>{t("Optional. Adds authenticated read capacity for selected public repositories.")}</small></span>
          <span><strong>{t("GitHub App automation")}</strong><small>{t("Only needed for signed webhooks and installation-based repository access.")}</small></span>
        </div>
        <div className="setting-field"><label htmlFor="setting-app-id">{t("GitHub App ID")}</label><input id="setting-app-id" aria-describedby="setting-app-id-help" value={draft.github.appId} onChange={event => setDraft(current => current ? ({ ...current, github: { ...current.github, appId: event.target.value } }) : current)} placeholder={t("Only for GitHub App mode")} /><SettingHelp id="setting-app-id-help" text="Find the numeric App ID on the GitHub App settings page. Skip this for anonymous or PAT read-only mode." href={SETTING_HELP_LINKS.githubApp} /></div>
        <SecretField name="publicReadToken" label="Public read token" configured={settings.github.publicReadTokenConfigured} value={secrets.publicReadToken} clear={clearSecrets.publicReadToken} help="Optional: use a fine-grained PAT limited to selected repositories and read-only contents/metadata permissions." helpHref={SETTING_HELP_LINKS.githubPat} onValue={updateSecret} onClear={updateClear} />
        <SecretField name="webhookSecret" label="Webhook secret" configured={settings.github.webhookSecretConfigured} value={secrets.webhookSecret} clear={clearSecrets.webhookSecret} help="Create a random webhook secret in your GitHub App and enter the same value here." helpHref={SETTING_HELP_LINKS.githubWebhook} onValue={updateSecret} onClear={updateClear} />
        <div className="setting-field-wide"><SecretField name="privateKey" label="Private key" configured={settings.github.privateKeyConfigured} value={secrets.privateKey} clear={clearSecrets.privateKey} help="Paste the GitHub App PEM private key or a readable local file path. Never commit the PEM file." helpHref={SETTING_HELP_LINKS.githubPrivateKey} multiline onValue={updateSecret} onClear={updateClear} /></div>
      </div>
    </section>

    <section className="settings-group section-block">
      <div className="settings-group-title"><ServerCog size={18} /><div><span>{t("03 · Runtime")}</span><h3>{t("Local service")}</h3><p>{t("Control storage, workspace isolation and worker throughput.")}</p></div></div>
      <div className="settings-fields">
        <div className="setting-field"><label htmlFor="setting-database">{t("Database path")}</label><input id="setting-database" aria-describedby="setting-database-help" value={safeEditablePath(draft.runtime.databasePath, "./.consistency/consistency.db")} onChange={event => setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, databasePath: event.target.value } }) : current)} /><SettingHelp id="setting-database-help" text="Stored locally. Relative paths stay inside this project and are safest for a first setup." /></div>
        <div className="setting-field"><label htmlFor="setting-workspace">{t("Workspace root")}</label><input id="setting-workspace" aria-describedby="setting-workspace-help" value={safeEditablePath(draft.runtime.workspaceRoot, "./.consistency/workspaces")} onChange={event => setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, workspaceRoot: event.target.value } }) : current)} /><SettingHelp id="setting-workspace-help" text="Temporary review workspaces are created here. Keep the default unless you manage storage separately." /></div>
        <div className="setting-field"><label htmlFor="setting-concurrency">{t("Worker concurrency")}</label><input id="setting-concurrency" aria-describedby="setting-concurrency-help" type="number" min="1" max="16" value={draft.runtime.workerConcurrency} onChange={event => setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, workerConcurrency: Number(event.target.value) } }) : current)} /><SettingHelp id="setting-concurrency-help" text="Start with 1. Increase only after checking CPU, memory and provider rate limits." /></div>
        <div className="setting-field"><label htmlFor="setting-poll">{t("Poll interval (ms)")}</label><input id="setting-poll" aria-describedby="setting-poll-help" type="number" min="50" max="60000" value={draft.runtime.workerPollIntervalMs} onChange={event => setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, workerPollIntervalMs: Number(event.target.value) } }) : current)} /><SettingHelp id="setting-poll-help" text="How often the worker checks for queued jobs. The default is appropriate for local use." /></div>
        <div className="setting-field setting-field-wide"><label htmlFor="setting-web-url">{t("Web URL")}</label><input id="setting-web-url" aria-describedby="setting-web-url-help" type="url" value={draft.runtime.webUrl} onChange={event => setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, webUrl: event.target.value } }) : current)} /><SettingHelp id="setting-web-url-help" text="The browser URL used in links and callbacks, usually http://127.0.0.1:5173 for local development." /></div>
        <div className="setting-field setting-field-wide setting-note"><LockKeyhole size={17} /><div><strong>{t("API bearer token")}</strong><p>{t(settings.runtime.apiTokenConfigured ? "Configured for the API. Keep VITE_API_TOKEN synchronized before restarting the web app." : "Optional for local use. Generate a high-entropy value yourself; this is not a vendor API key.")}</p><code>npm run config -- set runtime.api-token</code><SettingHelp id="setting-api-token-help" text="This token is generated by ConsistenCy, not an external API provider. A production browser deployment should use a protected server session or reverse proxy instead of treating a Vite build variable as a user secret." /></div></div>
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
        <ConfigRow icon={Database} label={t("Database")} value={health.configuration.databasePath} ok={health.database.ok} redact />
      </div>
    </section>

    <div className="settings-actions"><span><LockKeyhole size={15} />{t("Secrets are encrypted locally and never returned.")}</span><button className="secondary-button" type="button" onClick={() => { setDraft(settings); setSecrets(emptySecrets); setClearSecrets(keepSecrets); setMessage(undefined); }}><RotateCcw size={15} />{t("Reset changes")}</button><button className="save-settings" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spinning" size={16} /> : <Save size={16} />}{t(saving ? "Saving" : "Save settings")}</button></div>
  </form>;
}
