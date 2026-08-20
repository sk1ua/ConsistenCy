import React, { useEffect, useState, type FormEvent } from "react";
import {
  ServerCog,
  Sparkles,
  Github,
  Database,
  LockKeyhole,
  RotateCcw,
  Save,
  CheckCircle2,
  XCircle,
  KeyRound,
  Globe2,
  Loader2,
  AlertCircle
} from "lucide-react";
import { api, type HealthResponse, type SettingsPatch, type SettingsSnapshot } from "../api/client";
import { SETTING_HELP_LINKS } from "../components/SettingHelp";
import { desktopBridge, type DesktopCredentialKey, type DesktopCredentialStatus, type DesktopBuildInfo } from "../desktop";
import { useI18n } from "../i18n";
import { Button } from "../design-system/Button";
import { Input } from "../design-system/Input";
import { Textarea } from "../design-system/Textarea";
import { Select } from "../design-system/Select";
import { Checkbox } from "../design-system/Checkbox";
import { Badge } from "../design-system/Badge";
import { SectionHeader } from "../design-system/SectionHeader";
import { ExternalLink } from "../design-system/Link";
import { EmptyState } from "../design-system/EmptyState";

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

export interface SettingsPageProps {
  health?: HealthResponse;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ health }) => {
  const { t } = useI18n();
  const [settings, setSettings] = useState<SettingsSnapshot>();
  const [draft, setDraft] = useState<SettingsSnapshot>();
  const [secrets, setSecrets] = useState<SecretDrafts>(emptySecrets);
  const [clearSecrets, setClearSecrets] = useState<ClearSecrets>(keepSecrets);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const [buildInfo, setBuildInfo] = useState<DesktopBuildInfo | null>(null);

  useEffect(() => {
    let active = true;
    const bridge = desktopBridge();
    if (bridge?.buildInfo) {
      bridge.buildInfo().then(info => {
        if (active && info?.version) setBuildInfo(info);
      }).catch(() => {});
    }
    void Promise.all([
      api.settings(),
      bridge?.credentialStatus().catch(() => undefined)
    ])
      .then(([snapshot, credentialStatus]) => {
        if (!active) return;
        const loaded = credentialStatus ? withDesktopCredentialStatus(snapshot, credentialStatus) : snapshot;
        setSettings(loaded);
        setDraft(loaded);
      })
      .catch(error => {
        if (active) setMessage({ tone: "error", text: error instanceof Error ? error.message : "无法加载配置" });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function updateSecret(name: SecretName, value: string) {
    setSecrets(current => ({ ...current, [name]: value }));
  }

  function updateClear(name: SecretName, value: boolean) {
    setClearSecrets(current => ({ ...current, [name]: value }));
  }

  function secretValue(value: string, clear: boolean): string | null | undefined {
    if (clear) return null;
    return value.trim() || undefined;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setMessage(undefined);
    const bridge = desktopBridge();
    const secretUpdates = Object.fromEntries(
      (Object.keys(desktopCredentialBySecret) as SecretName[]).map(name => [
        name,
        secretValue(secrets[name], clearSecrets[name])
      ])
    ) as Record<SecretName, string | null | undefined>;

    const patch: SettingsPatch = {
      llm: {
        provider: draft.llm.provider,
        deepseekBaseUrl: draft.llm.deepseekBaseUrl,
        deepseekModel: draft.llm.deepseekModel,
        openaiModel: draft.llm.openaiModel,
        ...(bridge
          ? {}
          : {
              deepseekApiKey: secretUpdates.deepseekApiKey,
              openaiApiKey: secretUpdates.openaiApiKey
            })
      },
      github: {
        appId: draft.github.appId || null,
        ...(bridge
          ? {}
          : {
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
      setRestartNeeded(true);
      setMessage({ tone: "success", text: "设置已保存。请重启 API 服务以应用新的运行时配置。" });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "保存设置失败" });
    } finally {
      setSaving(false);
    }
  }

  async function handleRestartRuntime() {
    const bridge = desktopBridge();
    if (!bridge?.restartRuntime) return;
    setRestarting(true);
    try {
      const result = await bridge.restartRuntime();
      if (result && !result.ok && result.error) {
        setMessage({ tone: "error", text: result.error });
      } else {
        setMessage({ tone: "success", text: "ConsistenCy 运行时已成功重启。" });
        setRestartNeeded(false);
        const snapshot = await api.settings();
        const status = await bridge.credentialStatus().catch(() => undefined);
        const loaded = status ? withDesktopCredentialStatus(snapshot, status) : snapshot;
        setSettings(loaded);
        setDraft(loaded);
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "重启运行时失败" });
    } finally {
      setRestarting(false);
    }
  }

  if (!health) {
    return <EmptyState title="请启动 API 服务以在浏览器中配置工作区。" />;
  }

  if (loading) {
    return (
      <div style={{ padding: "48px", textAlign: "center", color: "var(--muted)" }}>
        <Loader2 size={24} className="ds-spin" style={{ margin: "0 auto 8px" }} />
        <div>{t("Loading configuration")}</div>
      </div>
    );
  }

  if (!draft || !settings) {
    return <EmptyState title="配置服务暂不可用。请运行 npm run config -- doctor 检查。" />;
  }

  return (
    <form
      onSubmit={e => void save(e)}
      style={{ padding: "24px 32px", maxWidth: "1000px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "24px" }}
    >
      <SectionHeader
        title="系统设置 (Settings)"
        subtitle="配置大语言模型凭证、GitHub 连接、以及本地代码审查服务运行时参数"
        actions={
          buildInfo && (
            <Badge variant="neutral" size="sm" mono>
              ConsistenCy {buildInfo.version} · build {buildInfo.commitSha.substring(0, 7)}
            </Badge>
          )
        }
      />

      {message && (
        <div
          style={{
            padding: "12px 16px",
            background: message.tone === "success" ? "var(--success-soft)" : "var(--danger-soft)",
            color: message.tone === "success" ? "var(--success-strong)" : "var(--danger-strong)",
            borderRadius: "var(--ds-radius-md)",
            fontSize: "13px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between"
          }}
        >
          <span>{message.text}</span>
          {desktopBridge()?.restartRuntime && restartNeeded && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={restarting}
              icon={<RotateCcw size={13} />}
              onClick={() => void handleRestartRuntime()}
            >
              {restarting ? "正在重启..." : "立即重启 ConsistenCy 运行时"}
            </Button>
          )}
        </div>
      )}

      {/* Group 1: Model Settings */}
      <section
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--ds-radius-lg)",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "16px"
        }}
      >
        <SectionHeader
          title="1. 大语言模型配置 (LLM Models)"
          subtitle="选择用于代码事实推导、缺陷识别与证据综合的真实大语言模型"
          icon={<Sparkles size={16} />}
        />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
              默认模型提供商 (Default Provider)
            </label>
            <Select
              sizeVariant="md"
              value={draft.llm.provider ?? "none"}
              onChange={e =>
                setDraft(c =>
                  c ? { ...c, llm: { ...c.llm, provider: e.target.value as any } } : c
                )
              }
              options={[
                { label: "未配置 (Not Configured)", value: "none" },
                { label: "DeepSeek (推荐)", value: "deepseek" },
                { label: "OpenAI", value: "openai" }
              ]}
            />
          </div>
        </div>

        {draft.llm.provider === "deepseek" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px", borderTop: "1px solid var(--border)", paddingTop: "14px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                  DeepSeek 模型名称
                </label>
                <Input
                  type="text"
                  value={draft.llm.deepseekModel}
                  onChange={e => setDraft(c => (c ? { ...c, llm: { ...c.llm, deepseekModel: e.target.value } } : c))}
                  placeholder="deepseek-v4-flash"
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                  API Base URL
                </label>
                <Input
                  type="url"
                  value={draft.llm.deepseekBaseUrl}
                  onChange={e => setDraft(c => (c ? { ...c, llm: { ...c.llm, deepseekBaseUrl: e.target.value } } : c))}
                />
              </div>
            </div>

            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
                <label style={{ fontSize: "12px", fontWeight: 600 }}>DeepSeek API Key</label>
                <Badge variant={settings.llm.deepseekApiKeyConfigured ? "success" : "neutral"} size="sm">
                  {settings.llm.deepseekApiKeyConfigured ? "已配置" : "未配置"}
                </Badge>
              </div>
              <Input
                type="password"
                value={secrets.deepseekApiKey}
                onChange={e => updateSecret("deepseekApiKey", e.target.value)}
                placeholder={settings.llm.deepseekApiKeyConfigured ? "已加密保存 (留空保持不变)" : "输入 sk- 开头的 API Key"}
                disabled={clearSecrets.deepseekApiKey}
              />
              <div style={{ marginTop: "4px", fontSize: "11px", color: "var(--muted)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>密钥将通过桌面端安全存储加密，不会返回给前端。</span>
                <ExternalLink href={SETTING_HELP_LINKS.deepseekApi}>获取 DeepSeek API Key</ExternalLink>
              </div>
              {settings.llm.deepseekApiKeyConfigured && (
                <div style={{ marginTop: "6px" }}>
                  <Checkbox
                    label="清除已保存的 API Key"
                    checked={clearSecrets.deepseekApiKey}
                    onChange={e => updateClear("deepseekApiKey", e.target.checked)}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {draft.llm.provider === "openai" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px", borderTop: "1px solid var(--border)", paddingTop: "14px" }}>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                OpenAI 模型名称
              </label>
              <Input
                type="text"
                value={draft.llm.openaiModel}
                onChange={e => setDraft(c => (c ? { ...c, llm: { ...c.llm, openaiModel: e.target.value } } : c))}
                placeholder="gpt-4.1-mini"
              />
            </div>

            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
                <label style={{ fontSize: "12px", fontWeight: 600 }}>OpenAI API Key</label>
                <Badge variant={settings.llm.openaiApiKeyConfigured ? "success" : "neutral"} size="sm">
                  {settings.llm.openaiApiKeyConfigured ? "已配置" : "未配置"}
                </Badge>
              </div>
              <Input
                type="password"
                value={secrets.openaiApiKey}
                onChange={e => updateSecret("openaiApiKey", e.target.value)}
                placeholder={settings.llm.openaiApiKeyConfigured ? "已加密保存 (留空保持不变)" : "输入 sk- 开头的 API Key"}
                disabled={clearSecrets.openaiApiKey}
              />
              <div style={{ marginTop: "4px", fontSize: "11px", color: "var(--muted)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>密钥将通过桌面端安全存储加密。</span>
                <ExternalLink href={SETTING_HELP_LINKS.openaiApiKeys}>获取 OpenAI API Key</ExternalLink>
              </div>
              {settings.llm.openaiApiKeyConfigured && (
                <div style={{ marginTop: "6px" }}>
                  <Checkbox
                    label="清除已保存的 API Key"
                    checked={clearSecrets.openaiApiKey}
                    onChange={e => updateClear("openaiApiKey", e.target.checked)}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Group 2: GitHub Integration */}
      <section
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--ds-radius-lg)",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "16px"
        }}
      >
        <SectionHeader
          title="2. GitHub 接入与凭证 (GitHub Integration)"
          subtitle="配置公开 PR 访问令牌或 GitHub App 自动化审查凭据"
          icon={<Github size={16} />}
        />

        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
            GitHub App ID
          </label>
          <Input
            type="text"
            value={draft.github.appId ?? ""}
            onChange={e => setDraft(c => (c ? { ...c, github: { ...c.github, appId: e.target.value } } : c))}
            placeholder="仅在使用 GitHub App 模式时需要填写"
          />
        </div>

        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
            <label style={{ fontSize: "12px", fontWeight: 600 }}>公开读取 Token (Public Read PAT)</label>
            <Badge variant={settings.github.publicReadTokenConfigured ? "success" : "neutral"} size="sm">
              {settings.github.publicReadTokenConfigured ? "已配置" : "未配置"}
            </Badge>
          </div>
          <Input
            type="password"
            value={secrets.publicReadToken}
            onChange={e => updateSecret("publicReadToken", e.target.value)}
            placeholder={settings.github.publicReadTokenConfigured ? "已加密保存 (留空保持不变)" : "输入只读 GitHub Token"}
            disabled={clearSecrets.publicReadToken}
          />
        </div>
      </section>

      {/* Group 3: Runtime Service */}
      <section
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--ds-radius-lg)",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "16px"
        }}
      >
        <SectionHeader
          title="3. 运行时与服务设置 (Runtime & Concurrency)"
          subtitle="调度进程并发控制与存储参数"
          icon={<ServerCog size={16} />}
        />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
              工作线程并发度 (Worker Concurrency)
            </label>
            <Input
              type="number"
              value={draft.runtime.workerConcurrency}
              onChange={e => setDraft(c => (c ? { ...c, runtime: { ...c.runtime, workerConcurrency: Number(e.target.value) } } : c))}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
              轮询间隔 (毫秒)
            </label>
            <Input
              type="number"
              value={draft.runtime.workerPollIntervalMs}
              onChange={e => setDraft(c => (c ? { ...c, runtime: { ...c.runtime, workerPollIntervalMs: Number(e.target.value) } } : c))}
            />
          </div>
        </div>
      </section>

      {/* Action Footer */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 20px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--ds-radius-md)"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--muted)" }}>
          <LockKeyhole size={14} />
          <span>敏感凭证通过系统级安全存储加密，永不会明文发送至 Web 渲染层。</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Button
            type="button"
            variant="outline"
            icon={<RotateCcw size={14} />}
            onClick={() => {
              setDraft(settings);
              setSecrets(emptySecrets);
              setClearSecrets(keepSecrets);
              setMessage(undefined);
            }}
          >
            重置修改
          </Button>

          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={saving}
            icon={<Save size={14} />}
            disabled={saving}
          >
            保存系统设置
          </Button>
        </div>
      </div>
    </form>
  );
};
