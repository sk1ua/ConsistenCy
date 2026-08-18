import { Check, CheckCircle2, Database, Globe2, Github, KeyRound, LoaderCircle, LockKeyhole, RotateCcw, Save, ServerCog, Sparkles, XCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, type HealthResponse, type SettingsPatch, type SettingsSnapshot } from "../api/client";
import { SETTING_HELP_LINKS, SettingHelp } from "../components/SettingHelp";
import { desktopBridge, type DesktopCredentialKey, type DesktopCredentialStatus } from "../desktop";
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

const desktopCredentialBySecret: Record<SecretName, DesktopCredentialKey> = {
  deepseekApiKey: "DEEPSEEK_API_KEY",
  openaiApiKey: "OPENAI_API_KEY",
  privateKey: "GITHUB_PRIVATE_KEY",
  webhookSecret: "GITHUB_WEBHOOK_SECRET",
  publicReadToken: "GITHUB_PUBLIC_READ_TOKEN"
};

function withDesktopCredentialStatus(settings: SettingsSnapshot, status: DesktopCredentialStatus): SettingsSnapshot {
  return {
    ...settings,
    llm: {
      ...settings.llm,
      deepseekApiKeyConfigured: settings.llm.deepseekApiKeyConfigured || status.DEEPSEEK_API_KEY,
      openaiApiKeyConfigured: settings.llm.openaiApiKeyConfigured || status.OPENAI_API_KEY
    },
    github: {
      ...settings.github,
      privateKeyConfigured: settings.github.privateKeyConfigured || status.GITHUB_PRIVATE_KEY,
      webhookSecretConfigured: settings.github.webhookSecretConfigured || status.GITHUB_WEBHOOK_SECRET,
      publicReadTokenConfigured: settings.github.publicReadTokenConfigured || status.GITHUB_PUBLIC_READ_TOKEN
    }
  };
}

function ConfigRow({ icon: Icon, label, value, ok }: { icon: typeof Github; label: string; value: string; ok?: boolean }) {
  return <div className="config-row"><Icon size={18} /><span><strong>{label}</strong><small>{value}</small></span>{ok === undefined ? null : ok ? <CheckCircle2 className="ok" size={18} /> : <XCircle className="bad" size={18} />}</div>;
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
    const bridge = desktopBridge();
    void Promise.all([
      api.settings(),
      bridge?.credentialStatus().catch(() => undefined)
    ]).then(([snapshot, credentialStatus]) => {
      if (!active) return;
      const loaded = credentialStatus ? withDesktopCredentialStatus(snapshot, credentialStatus) : snapshot;
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

  const llmReady = Boolean(draft && settings && (
    (draft.llm.provider === "deepseek" ? secretReady("deepseekApiKey", settings.llm.deepseekApiKeyConfigured)
     : draft.llm.provider === "openai" ? secretReady("openaiApiKey", settings.llm.openaiApiKeyConfigured)
     : false)
  ));
  const githubAppReady = Boolean(draft && settings && draft.github.appId
    && secretReady("privateKey", settings.github.privateKeyConfigured)
    && secretReady("webhookSecret", settings.github.webhookSecretConfigured));
  const publicTokenReady = Boolean(settings && secretReady("publicReadToken", settings.github.publicReadTokenConfigured));
  const sourceReady = Boolean(health && (health.publicPrAccessMode !== "disabled" || githubAppReady || publicTokenReady));
  const runtimeReady = Boolean(draft?.runtime.storage.configured && draft.runtime.workspace.configured);
  const readiness = { complete: Number(llmReady) + Number(sourceReady) + Number(runtimeReady), total: 3 };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setMessage(undefined);
    const bridge = desktopBridge();
    const secretUpdates = Object.fromEntries((Object.keys(desktopCredentialBySecret) as SecretName[])
      .map(name => [name, secretValue(secrets[name], clearSecrets[name])])) as Record<SecretName, string | null | undefined>;
    const patch: SettingsPatch = {
      llm: {
        provider: draft.llm.provider,
        deepseekBaseUrl: draft.llm.deepseekBaseUrl,
        deepseekModel: draft.llm.deepseekModel,
        openaiModel: draft.llm.openaiModel,
        ...(bridge ? {} : {
          deepseekApiKey: secretUpdates.deepseekApiKey,
          openaiApiKey: secretUpdates.openaiApiKey
        })
      },
      github: {
        appId: draft.github.appId || null,
        ...(bridge ? {} : {
          privateKey: secretUpdates.privateKey,
          webhookSecret: secretUpdates.webhookSecret,
          publicReadToken: secretUpdates.publicReadToken
        })
      },
      runtime: {
        workerConcurrency: draft.runtime.workerConcurrency,
        workerPollIntervalMs: draft.runtime.workerPollIntervalMs,
        webUrl: draft.runtime.webUrl
      }
    };
    try {
      const updatedSnapshot = await api.updateSettings(patch);
      let updated = updatedSnapshot;
      if (bridge) {
        let status = await bridge.credentialStatus();
        for (const name of Object.keys(desktopCredentialBySecret) as SecretName[]) {
          const value = secretUpdates[name];
          if (value === undefined) continue;
          status = await bridge.setCredential(desktopCredentialBySecret[name], value);
        }
        updated = withDesktopCredentialStatus(updatedSnapshot, status);
      }
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

  return <form className="settings-editor page-stack" onSubmit={event => void save(event)}>
    <section className="section-block settings-header-strip">
      <div className="settings-title-wrap">
        <ServerCog size={20} className="settings-icon-main" />
        <div>
          <h2>{t("Settings")}</h2>
          <p>{t("Configure models, GitHub connections, and review worker runtime settings.")}</p>
        </div>
      </div>
    </section>

    {message && <div className={`settings-message ${message.tone}`} role="status">{message.text}</div>}
    {draft.overriddenByEnvironment.length > 0 && <div className="settings-message warning">{t("Environment variables override: {keys}", { keys: draft.overriddenByEnvironment.join(", ") })}</div>}

    <section className="settings-group section-block">
      <div className="settings-group-title"><Sparkles size={18} /><div><h3>{t("Model")}</h3><p>{t("Choose the model used for evidence synthesis and reviewer handoff.")}</p></div></div>
      <div className="settings-fields">
        <div className="setting-field"><label htmlFor="setting-provider">{t("Provider")}</label><select id="setting-provider" aria-describedby="setting-provider-help" value={draft.llm.provider ?? "none"} onChange={event => setDraft(current => current ? ({ ...current, llm: { ...current.llm, provider: event.target.value as SettingsSnapshot["llm"]["provider"] } }) : current)}><option value="none">{t("Not configured")}</option><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option></select><SettingHelp id="setting-provider-help" text="ConsistenCy requires a real LLM Provider (DeepSeek or OpenAI) to execute reviews." /></div>
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
      <div className="settings-group-title"><Github size={18} /><div><h3>{t("GitHub")}</h3><p>{t("Start with anonymous public PR analysis, then add credentials only for the mode you need.")}</p></div></div>
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
        <div className="setting-field setting-note"><Database size={17} /><div><strong>{t("Database")}</strong><p>{t(draft.runtime.storage.kind === "memory" ? "In-memory storage configured" : "Local file storage configured")}</p><SettingHelp id="setting-database-help" text="The local filesystem location is owned by the API process and is never sent to the renderer." /></div></div>
        <div className="setting-field setting-note"><ServerCog size={17} /><div><strong>{t("Workspace")}</strong><p>{t(draft.runtime.workspace.configured ? "Review workspace configured" : "Review workspace not configured")}</p><SettingHelp id="setting-workspace-help" text="Choose local folders through the privileged desktop folder picker; raw paths do not cross into Web UI state." /></div></div>
        <div className="setting-field"><label htmlFor="setting-concurrency">{t("Worker concurrency")}</label><input id="setting-concurrency" aria-describedby="setting-concurrency-help" type="number" min="1" max="16" value={draft.runtime.workerConcurrency} onChange={event => setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, workerConcurrency: Number(event.target.value) } }) : current)} /><SettingHelp id="setting-concurrency-help" text="Start with 1. Increase only after checking CPU, memory and provider rate limits." /></div>
        <div className="setting-field"><label htmlFor="setting-poll">{t("Poll interval (ms)")}</label><input id="setting-poll" aria-describedby="setting-poll-help" type="number" min="50" max="60000" value={draft.runtime.workerPollIntervalMs} onChange={event => setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, workerPollIntervalMs: Number(event.target.value) } }) : current)} /><SettingHelp id="setting-poll-help" text="How often the worker checks for queued jobs. The default is appropriate for local use." /></div>
        <div className="setting-field setting-field-wide"><label htmlFor="setting-web-url">{t("Web URL")}</label><input id="setting-web-url" aria-describedby="setting-web-url-help" type="url" value={draft.runtime.webUrl} onChange={event => setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, webUrl: event.target.value } }) : current)} /><SettingHelp id="setting-web-url-help" text="The browser URL used in links and callbacks, usually http://127.0.0.1:5173 for local development." /></div>
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

    <div className="settings-actions"><span><LockKeyhole size={15} />{t("Secrets are encrypted locally and never returned.")}</span><button className="secondary-button" type="button" onClick={() => { setDraft(settings); setSecrets(emptySecrets); setClearSecrets(keepSecrets); setMessage(undefined); }}><RotateCcw size={15} />{t("Reset changes")}</button><button className="save-settings" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spinning" size={16} /> : <Save size={16} />}{t(saving ? "Saving" : "Save settings")}</button></div>
  </form>;
}
