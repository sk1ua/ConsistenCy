import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type HealthResponse, type SettingsPatch, type SettingsSnapshot } from "../api/client";
import { DESKTOP_CREDENTIAL_KEYS, desktopBridge, type BuildInfoSummary, type ConsistencyDesktopBridge, type DesktopCredentialKey, type DesktopCredentialStatus } from "../desktop";
import { useI18n } from "../i18n";

export type SecretName = "deepseekApiKey" | "openaiApiKey" | "privateKey" | "webhookSecret" | "publicReadToken";
export type SecretDrafts = Record<SecretName, string>;
export type ClearSecrets = Record<SecretName, boolean>;

export const emptySecrets: SecretDrafts = {
  deepseekApiKey: "",
  openaiApiKey: "",
  privateKey: "",
  webhookSecret: "",
  publicReadToken: ""
};

export const keepSecrets: ClearSecrets = {
  deepseekApiKey: false,
  openaiApiKey: false,
  privateKey: false,
  webhookSecret: false,
  publicReadToken: false
};

const secretNames: readonly SecretName[] = ["deepseekApiKey", "openaiApiKey", "privateKey", "webhookSecret", "publicReadToken"];

const desktopCredentialBySecret: Record<SecretName, DesktopCredentialKey> = Object.fromEntries(
  secretNames.map((name, idx) => [name, DESKTOP_CREDENTIAL_KEYS[idx]])
) as Record<SecretName, DesktopCredentialKey>;

export function withDesktopCredentialStatus(settings: SettingsSnapshot, status: DesktopCredentialStatus): SettingsSnapshot {
  return {
    ...settings,
    llm: {
      ...settings.llm,
      deepseekApiKeyConfigured: settings.llm.deepseekApiKeyConfigured || status[DESKTOP_CREDENTIAL_KEYS[0]],
      openaiApiKeyConfigured: settings.llm.openaiApiKeyConfigured || status[DESKTOP_CREDENTIAL_KEYS[1]]
    },
    github: {
      ...settings.github,
      privateKeyConfigured: settings.github.privateKeyConfigured || status[DESKTOP_CREDENTIAL_KEYS[2]],
      webhookSecretConfigured: settings.github.webhookSecretConfigured || status[DESKTOP_CREDENTIAL_KEYS[3]],
      publicReadTokenConfigured: settings.github.publicReadTokenConfigured || status[DESKTOP_CREDENTIAL_KEYS[4]]
    }
  };
}

export function formatSettingsError(error: unknown, t: (key: string) => string): string {
  if (!error) return "";
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("SETTINGS_READ_ONLY") || raw.includes("Settings updates are disabled")) {
    return t("Settings updates are disabled");
  }
  if (raw.includes("DESKTOP_CREDENTIAL_BOUNDARY") || raw.includes("protected credential bridge")) {
    return t("Desktop credentials must be stored through the protected credential bridge");
  }
  if (raw.includes("Credential value must contain at least 8 characters")) {
    return t("Credential value must contain at least 8 characters");
  }
  if (raw.includes("Credential key is not allowed")) {
    return t("Credential key is not allowed");
  }
  if (raw.includes("SETTINGS_UNAVAILABLE") || raw.includes("Settings service is unavailable")) {
    return t("Settings service is unavailable");
  }
  if (raw.includes("Could not save settings")) {
    return t("Could not save settings");
  }
  return raw;
}

export function secretValue(value: string, clear: boolean): string | null | undefined {
  if (clear) return null;
  return value.trim() || undefined;
}

export function buildSettingsPatch(
  draft: SettingsSnapshot,
  secrets: SecretDrafts,
  clearSecrets: ClearSecrets,
  hasBridge: boolean
): SettingsPatch {
  const secretUpdates = Object.fromEntries(
    secretNames.map(name => [name, secretValue(secrets[name], clearSecrets[name])])
  ) as Record<SecretName, string | null | undefined>;

  return {
    llm: {
      provider: draft.llm.provider,
      deepseekBaseUrl: draft.llm.deepseekBaseUrl,
      deepseekModel: draft.llm.deepseekModel,
      openaiModel: draft.llm.openaiModel,
      ...(hasBridge ? {} : {
        deepseekApiKey: secretUpdates.deepseekApiKey,
        openaiApiKey: secretUpdates.openaiApiKey
      })
    },
    github: {
      appId: draft.github.appId || null,
      ...(hasBridge ? {} : {
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
}

export interface ReadinessResult {
  llmReady: boolean;
  githubAppReady: boolean;
  publicTokenReady: boolean;
  sourceReady: boolean;
  runtimeReady: boolean;
  readiness: { complete: number; total: number };
}

export function computeReadiness(
  draft: SettingsSnapshot | undefined,
  settings: SettingsSnapshot | undefined,
  secrets: SecretDrafts,
  clearSecrets: ClearSecrets,
  health: HealthResponse | undefined
): ReadinessResult {
  function secretReady(name: SecretName, configured: boolean): boolean {
    return Boolean(secrets[name].trim()) || (configured && !clearSecrets[name]);
  }

  const llmReady = Boolean(draft && settings && (
    draft.llm.provider === "deepseek"
      ? secretReady("deepseekApiKey", settings.llm.deepseekApiKeyConfigured)
      : draft.llm.provider === "openai"
        ? secretReady("openaiApiKey", settings.llm.openaiApiKeyConfigured)
        : false
  ));
  const githubAppReady = Boolean(draft && settings && draft.github.appId
    && secretReady("privateKey", settings.github.privateKeyConfigured)
    && secretReady("webhookSecret", settings.github.webhookSecretConfigured));
  const publicTokenReady = Boolean(settings && secretReady("publicReadToken", settings.github.publicReadTokenConfigured));
  const sourceReady = Boolean(health && (health.publicPrAccessMode !== "disabled" || githubAppReady || publicTokenReady));
  const runtimeReady = Boolean(draft?.runtime.storage.configured && draft.runtime.workspace.configured);

  return {
    llmReady,
    githubAppReady,
    publicTokenReady,
    sourceReady,
    runtimeReady,
    readiness: {
      complete: Number(llmReady) + Number(sourceReady) + Number(runtimeReady),
      total: 3
    }
  };
}

export type PublicPrAccessModeLabelKey = "PAT read" | "Anonymous read" | "Disabled";

export interface PublicPrAccessModeView {
  labelKey: PublicPrAccessModeLabelKey;
  ok: boolean;
}

/**
 * Single source of truth for rendering health.publicPrAccessMode. The server
 * derives the field as: analysis disabled -> "disabled"; analysis enabled ->
 * public read token present ? "pat" : "anonymous". An undefined field only
 * comes from legacy /health payloads that predate it; consistent with the
 * fail-closed posture (and with GitHubSettingsSection's existing mapping), it
 * renders as "Disabled" instead of claiming anonymous read access.
 */
export function publicPrAccessModeView(mode: HealthResponse["publicPrAccessMode"]): PublicPrAccessModeView {
  if (mode === "pat") return { labelKey: "PAT read", ok: true };
  if (mode === "anonymous") return { labelKey: "Anonymous read", ok: true };
  return { labelKey: "Disabled", ok: false };
}

export interface UseSettingsFormDeps {
  fetchSettings?: () => Promise<SettingsSnapshot>;
  updateSettings?: (patch: SettingsPatch) => Promise<SettingsSnapshot>;
  bridge?: ConsistencyDesktopBridge | undefined;
}

export interface UseSettingsFormOptions {
  health?: HealthResponse;
  deps?: UseSettingsFormDeps;
}

export interface UseSettingsFormResult {
  settings: SettingsSnapshot | undefined;
  draft: SettingsSnapshot | undefined;
  secrets: SecretDrafts;
  clearSecrets: ClearSecrets;
  loading: boolean;
  saving: boolean;
  restarting: boolean;
  restartNeeded: boolean;
  message: { tone: "success" | "error"; text: string } | undefined;
  buildInfo: BuildInfoSummary | null;
  updateSecret: (name: SecretName, value: string) => void;
  updateClear: (name: SecretName, value: boolean) => void;
  updateLlm: (patch: Partial<SettingsSnapshot["llm"]>) => void;
  updateGithub: (patch: Partial<SettingsSnapshot["github"]>) => void;
  updateRuntime: (patch: Partial<SettingsSnapshot["runtime"]>) => void;
  save: () => Promise<void>;
  resetChanges: () => void;
  handleRestartRuntime: () => Promise<void>;
  reload: () => Promise<void>;
  llmReady: boolean;
  githubAppReady: boolean;
  publicTokenReady: boolean;
  sourceReady: boolean;
  runtimeReady: boolean;
  readiness: { complete: number; total: number };
}

export function useSettingsForm(options: UseSettingsFormOptions): UseSettingsFormResult {
  const { health } = options;
  const { t } = useI18n();
  const defaultDeps = useMemo<UseSettingsFormDeps>(() => ({
    fetchSettings: () => api.settings(),
    updateSettings: (patch: SettingsPatch) => api.updateSettings(patch),
    bridge: desktopBridge()
  }), []);
  const deps = options.deps ?? defaultDeps;
  const bridge = deps.bridge;

  const [settings, setSettings] = useState<SettingsSnapshot>();
  const [draft, setDraft] = useState<SettingsSnapshot>();
  const [secrets, setSecrets] = useState<SecretDrafts>(emptySecrets);
  const [clearSecrets, setClearSecrets] = useState<ClearSecrets>(keepSecrets);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const [buildInfo, setBuildInfo] = useState<BuildInfoSummary | null>(null);

  const loadSettings = useCallback(async (): Promise<void> => {
    const snapshot = await (deps.fetchSettings ?? api.settings)();
    const credentialStatus = bridge?.credentialStatus ? await bridge.credentialStatus().catch(() => undefined) : undefined;
    const loaded = credentialStatus ? withDesktopCredentialStatus(snapshot, credentialStatus) : snapshot;
    setSettings(loaded);
    setDraft(loaded);
    setRestartNeeded(loaded.restartRequired);
  }, [deps, bridge]);

  useEffect(() => {
    let active = true;
    if (bridge?.buildInfo) {
      bridge.buildInfo().then(info => {
        if (active && info?.version) setBuildInfo(info);
      }).catch(() => {});
    }
    void loadSettings().catch(error => {
      if (active) setMessage({ tone: "error", text: formatSettingsError(error, t) });
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [t, loadSettings, bridge]);

  const updateSecret = useCallback((name: SecretName, value: string) => {
    setSecrets(current => ({ ...current, [name]: value }));
  }, []);

  const updateClear = useCallback((name: SecretName, value: boolean) => {
    setClearSecrets(current => ({ ...current, [name]: value }));
  }, []);

  const updateLlm = useCallback((patch: Partial<SettingsSnapshot["llm"]>) => {
    setDraft(current => current ? ({ ...current, llm: { ...current.llm, ...patch } }) : current);
  }, []);

  const updateGithub = useCallback((patch: Partial<SettingsSnapshot["github"]>) => {
    setDraft(current => current ? ({ ...current, github: { ...current.github, ...patch } }) : current);
  }, []);

  const updateRuntime = useCallback((patch: Partial<SettingsSnapshot["runtime"]>) => {
    setDraft(current => current ? ({ ...current, runtime: { ...current.runtime, ...patch } }) : current);
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setMessage(undefined);
    const patch = buildSettingsPatch(draft, secrets, clearSecrets, Boolean(bridge));
    // Bridge-written credentials land only in the OS credential store and take
    // effect at the next runtime restart; the API never sees those writes, so
    // its restartRequired flag alone would hide the pending-restart state.
    let bridgeStoredCredential = false;
    try {
      const updatedSnapshot = await (deps.updateSettings ?? api.updateSettings)(patch);
      let updated = updatedSnapshot;
      if (bridge) {
        let status = await bridge.credentialStatus();
        for (const name of secretNames) {
          const value = secretValue(secrets[name], clearSecrets[name]);
          if (value === undefined) continue;
          status = await bridge.setCredential(desktopCredentialBySecret[name], value);
          bridgeStoredCredential = true;
        }
        updated = withDesktopCredentialStatus(updatedSnapshot, status);
      }
      setSettings(updated);
      setDraft(updated);
      setSecrets(emptySecrets);
      setClearSecrets(keepSecrets);
      setRestartNeeded(bridgeStoredCredential || updated.restartRequired);
      setMessage({ tone: "success", text: t("Settings saved.") });
    } catch (error) {
      setMessage({ tone: "error", text: formatSettingsError(error, t) });
    } finally {
      setSaving(false);
    }
  }, [draft, secrets, clearSecrets, bridge, deps, t]);

  const resetChanges = useCallback(() => {
    setDraft(settings);
    setSecrets(emptySecrets);
    setClearSecrets(keepSecrets);
    setMessage(undefined);
  }, [settings]);

  const handleRestartRuntime = useCallback(async () => {
    if (!bridge?.restartRuntime) return;
    setRestarting(true);
    try {
      const result = await bridge.restartRuntime();
      if (result && !result.ok && result.error) {
        setMessage({ tone: "error", text: result.error });
      } else {
        setMessage({ tone: "success", text: t("ConsistenCy runtime restarted successfully.") });
        setRestartNeeded(false);
        await loadSettings();
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : t("Could not restart runtime") });
    } finally {
      setRestarting(false);
    }
  }, [bridge, t, loadSettings]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      await loadSettings();
    } catch (error) {
      setMessage({ tone: "error", text: formatSettingsError(error, t) });
    } finally {
      setLoading(false);
    }
  }, [loadSettings, t]);

  const readiness = computeReadiness(draft, settings, secrets, clearSecrets, health);

  return {
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
    handleRestartRuntime,
    reload,
    llmReady: readiness.llmReady,
    githubAppReady: readiness.githubAppReady,
    publicTokenReady: readiness.publicTokenReady,
    sourceReady: readiness.sourceReady,
    runtimeReady: readiness.runtimeReady,
    readiness: readiness.readiness
  };
}
