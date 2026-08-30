import React, { useState, useEffect, useMemo } from "react";
import {
  FolderGit2,
  PlayCircle,
  ShieldAlert,
  GitFork,
  Settings,
  Plus,
  RefreshCw,
  Monitor,
  Sun,
  Moon,
  Search,
  Activity,
  GitBranch,
  Cpu,
  Languages,
  Layers,
  ChevronDown,
  CheckCircle2,
  AlertCircle,
  X
} from "lucide-react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type {
  AgentRuntimeSnapshot,
  HeartbeatPulse,
  Repository,
  ReviewFinding,
  ReviewJob,
  ReviewReport,
  VcsCommitSummary
} from "@consistency/schema";
import type { HealthResponse } from "../api/client";
import type { Locale } from "../i18n";
import type { RouteMeta } from "../routes/meta";
import type { ThemePreference } from "../theme";
import { Button } from "../design-system/Button";
import { IconButton } from "../design-system/IconButton";
import { SidebarRow } from "../design-system/SidebarRow";
import { Badge } from "../design-system/Badge";
import type { BadgeVariant } from "../design-system/Badge";
import { Breadcrumb, type BreadcrumbItem } from "../design-system/Breadcrumb";
import { Dialog } from "../design-system/Dialog";
import { SettingsDialog } from "../components/SettingsDialog";
import { desktopBridge, type DesktopBuildInfo } from "../desktop";

export type DataNotice = {
  id: string;
  label: string;
  message: string;
};

export interface InspectorContext {
  runId?: string;
  job?: ReviewJob;
  report?: ReviewReport;
  agent?: AgentRuntimeSnapshot;
  finding?: ReviewFinding;
  commit?: VcsCommitSummary;
  customTitle?: string;
  customContent?: React.ReactNode;
}

const findingSeverityVariants: Record<ReviewFinding["severity"], BadgeVariant> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  info: "neutral"
};

export interface AppShellProps {
  children: React.ReactNode;
  path: string;
  routeHref: string;
  meta: RouteMeta;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  themePreference: ThemePreference;
  themeLabel: string;
  setThemePreference?: (preference: ThemePreference) => void;
  cycleTheme: () => void;
  jobs: ReviewJob[];
  repositories: Repository[];
  pulse?: HeartbeatPulse | null;
  health?: HealthResponse;
  healthUnavailable?: boolean;
  inspectorContext?: InspectorContext;
  notices?: DataNotice[];
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function isCommandPaletteShortcut(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): boolean {
  return Boolean(
    (e.ctrlKey || e.metaKey) &&
      (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "p") &&
      !e.shiftKey &&
      !e.altKey
  );
}

export function safeDecodeURIComponent(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return undefined;
  }
}

export const AppShell: React.FC<AppShellProps> = ({
  children,
  path,
  locale = "en-US",
  setLocale = () => {},
  themePreference,
  setThemePreference,
  cycleTheme,
  jobs = [],
  repositories = [],
  pulse,
  health,
  healthUnavailable = false,
  inspectorContext,
  notices = [],
  refreshing = false,
  onRefresh
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const zh = locale === "zh-CN";

  const [isConnectOpen, setIsConnectOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [buildInfo, setBuildInfo] = useState<DesktopBuildInfo | null>(null);

  // Keyboard shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isCommandPaletteShortcut(e)) {
        e.preventDefault();
        setIsCommandOpen(prev => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Fetch Desktop build info
  useEffect(() => {
    const bridge = desktopBridge();
    if (bridge?.buildInfo) {
      void bridge.buildInfo().then(info => setBuildInfo(info), () => undefined);
    }
  }, []);

  // Selection-driven Inspector visibility
  useEffect(() => {
    if (inspectorContext && (inspectorContext.finding || inspectorContext.agent || inspectorContext.commit || inspectorContext.customContent)) {
      setInspectorOpen(true);
    } else {
      setInspectorOpen(false);
    }
  }, [inspectorContext]);

  const routeRepositoryId = useMemo(() => {
    const match = path.match(/^\/repositories\/([^/]+)/);
    return safeDecodeURIComponent(match?.[1]);
  }, [path]);
  const pulseRepositoryName = pulse?.repository.root?.split(/[\\/]/).filter(Boolean).at(-1);
  const activeRepo = useMemo(() => {
    if (routeRepositoryId) return repositories.find(r => r.id === routeRepositoryId);
    if (path.startsWith("/repositories/")) return undefined; // never fall back if inside repository route
    return repositories[0];
  }, [repositories, routeRepositoryId, path]);

  const activeRepositoryName = activeRepo?.displayName ?? (
    !routeRepositoryId && pulseRepositoryName
      ? pulseRepositoryName
      : undefined
  );
  const activeRepositoryId = routeRepositoryId ?? activeRepo?.id;

  // Location breadcrumbs
  const breadcrumbs = useMemo<BreadcrumbItem[]>(() => {
    const items: BreadcrumbItem[] = [
      { label: "ConsistenCy", to: "/repositories", icon: <Layers size={13} /> }
    ];

    if (path.startsWith("/repositories/") && activeRepositoryName) {
      items.push({
        label: activeRepositoryName,
        to: `/repositories/${encodeURIComponent(activeRepositoryId ?? activeRepositoryName)}/overview`
      });
      if (path.includes("/changes")) {
        items.push({ label: zh ? "变更" : "Changes" });
      } else if (path.includes("/history")) {
        items.push({ label: zh ? "Git 提交历史" : "Git History" });
      } else if (path.includes("/pull-requests")) {
        items.push({ label: zh ? "拉取请求" : "Pull Requests" });
      } else if (path.includes("/reviews")) {
        items.push({ label: zh ? "审查" : "Reviews" });
      } else if (path.includes("/workflows")) {
        items.push({ label: zh ? "工作流" : "Workflows" });
      } else {
        items.push({ label: zh ? "概览" : "Overview" });
      }
    } else if (path.startsWith("/runs/") && params.runId) {
      const runId = safeDecodeURIComponent(params.runId);
      const currentJob = runId ? jobs.find(j => j.id === runId) : undefined;
      items.push({ label: zh ? "审查运行" : "Runs", to: "/runs" });
      if (runId) {
        items.push({
          label: currentJob ? `${currentJob.repositoryFullName} · ${runId.substring(0, 7)}` : runId.substring(0, 7),
          to: `/runs/${encodeURIComponent(runId)}/overview`
        });
      } else {
        items.push({ label: zh ? "无效的运行 ID" : "Invalid run ID" });
      }
      if (path.includes("/diff")) items.push({ label: "Diff" });
      else if (path.includes("/evidence")) items.push({ label: zh ? "证据" : "Evidence" });
      else if (path.includes("/notebook")) items.push({ label: "Notebook" });
      else if (path.includes("/runtime")) items.push({ label: "Runtime" });
      else items.push({ label: zh ? "概览" : "Overview" });
    } else if (path.startsWith("/repositories/")) {
      const repositoryId = safeDecodeURIComponent(path.split("/")[2]);
      if (repositoryId) {
        items.push({ label: repositoryId || (zh ? "代码仓库" : "Repositories") });
      } else {
        items.push({ label: zh ? "无效的仓库 ID" : "Invalid repository ID" });
      }
      if (path.includes("/changes")) {
        items.push({ label: zh ? "变更" : "Changes" });
      } else if (path.includes("/history")) {
        items.push({ label: zh ? "Git 提交历史" : "Git History" });
      } else if (path.includes("/pull-requests")) {
        items.push({ label: zh ? "拉取请求" : "Pull Requests" });
      } else if (path.includes("/reviews")) {
        items.push({ label: zh ? "审查" : "Reviews" });
      } else if (path.includes("/workflows")) {
        items.push({ label: zh ? "工作流" : "Workflows" });
      } else {
        items.push({ label: zh ? "概览" : "Overview" });
      }
    } else if (path.startsWith("/repositories")) {
      items.push({ label: zh ? "代码仓库" : "Repositories" });
    } else if (path.startsWith("/runs")) {
      items.push({ label: zh ? "审查运行" : "Runs" });
    } else if (path.startsWith("/findings")) {
      items.push({ label: zh ? "审查发现" : "Findings" });
    } else if (path.startsWith("/workflows")) {
      items.push({ label: zh ? "工作流" : "Workflows" });
    } else if (path.startsWith("/settings")) {
      items.push({ label: zh ? "系统设置" : "Settings" });
    } else if (path.startsWith("/inbox")) {
      items.push({ label: zh ? "收件箱" : "Inbox" });
    }

    return items;
  }, [activeRepositoryName, path, routeRepositoryId, params.runId, jobs, zh]);

  // Primary navigation links
  const navItems = [
    { to: "/inbox", label: zh ? "收件箱" : "Inbox", icon: <Layers size={15} /> },
    { to: "/repositories", label: zh ? "代码仓库" : "Repositories", icon: <FolderGit2 size={15} /> },
    {
      to: "/runs",
      label: zh ? "审查运行" : "Runs",
      icon: <PlayCircle size={15} />,
      badge: jobs.filter(j => j.status === "running").length ? (
        <Badge variant="warning" size="sm" dot>
          {jobs.filter(j => j.status === "running").length}
        </Badge>
      ) : undefined
    },
    { to: "/findings", label: zh ? "审查发现" : "Findings", icon: <ShieldAlert size={15} /> },
    { to: "/workflows", label: zh ? "工作流" : "Workflows", icon: <GitFork size={15} /> }
  ];

  const activeBranch = pulse?.repository.branch || "—";
  const activeModel = health?.llmModel || "";
  const modelProvider = health?.llmProvider || "none";
  const isPulseActive = pulse?.state === "idle" || pulse?.state === "scanning" || pulse?.state === "indexing";
  const apiConnected = health?.ok === true && !healthUnavailable;

  return (
    <div
      className="ds-root audit-shell"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100vw",
        overflow: "hidden"
      }}
    >
      {/* Main Layout (Sidebar + Center Workspace) */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
        {/* SINGLE PERSISTENT SIDEBAR */}
        <nav
          aria-label="Application Navigation"
          className="repo-first-sidebar"
          style={{
            width: "var(--ds-sidebar-width)",
            background: "var(--surface)",
            borderRight: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
            userSelect: "none"
          }}
        >
          {/* Brand Header */}
          <div
            style={{
              height: "var(--ds-topbar-height)",
              padding: "0 12px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div
                style={{
                  width: "20px",
                  height: "20px",
                  borderRadius: "var(--ds-radius-sm)",
                  background: "var(--primary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#ffffff",
                  fontWeight: 700,
                  fontSize: "12px"
                }}
              >
                C
              </div>
              <span style={{ fontWeight: 600, fontSize: "13px", letterSpacing: "-0.2px" }}>
                ConsistenCy
              </span>
              <Badge variant="neutral" size="sm" mono>
                v3
              </Badge>
            </div>
          </div>

          {/* Active Repository Card */}
          <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-subtle)" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "4px"
              }}
            >
              <span style={{ fontSize: "10px", fontWeight: 600, color: "var(--muted)", textTransform: "uppercase" }}>
                 {zh ? "当前仓库" : "Repository"}
              </span>
              <IconButton
                icon={<Plus size={12} />}
                label={zh ? "连接仓库" : "Connect Repository"}
                size="sm"
                onClick={() => setIsConnectOpen(true)}
              />
            </div>

            {activeRepositoryName ? (
              <div
                onClick={() => activeRepositoryId && navigate(`/repositories/${encodeURIComponent(activeRepositoryId)}/overview`)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "5px 8px",
                  borderRadius: "var(--ds-radius-sm)",
                  background: "var(--surface-subtle)",
                  cursor: "pointer",
                  border: "1px solid var(--border)"
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                  <FolderGit2 size={13} style={{ color: "var(--primary)", flexShrink: 0 }} />
                  <span
                    style={{
                      fontSize: "12px",
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap"
                    }}
                  >
                    {activeRepositoryName}
                  </span>
                </div>
                <ChevronDown size={12} style={{ color: "var(--muted)", flexShrink: 0 }} />
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                fullWidth
                icon={<Plus size={12} />}
                onClick={() => setIsConnectOpen(true)}
              >
                {zh ? "连接代码仓库..." : "Connect repo..."}
              </Button>
            )}
          </div>

          {/* Primary Navigation Rows */}
          <div style={{ flex: 1, padding: "6px 8px", display: "flex", flexDirection: "column", gap: "2px", overflowY: "auto" }}>
            {navItems.map(item => (
              <SidebarRow
                key={item.to}
                to={item.to}
                label={item.label}
                icon={item.icon}
                badge={item.badge}
              />
            ))}
          </div>

          {/* Sidebar Footer: Settings gear + Heartbeat daemon indicator */}
          <div
            style={{
              padding: "8px 10px",
              borderTop: "1px solid var(--border)",
              background: "var(--surface-subtle)",
              fontSize: "11px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between"
            }}
          >
            <IconButton
              icon={<Settings size={14} />}
              label={zh ? "设置" : "Settings"}
              size="sm"
              variant="ghost"
              onClick={() => setIsSettingsOpen(true)}
            />
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: isPulseActive ? "var(--success)" : "var(--muted)"
                }}
              />
              <span style={{ color: "var(--muted-strong)" }}>
                {isPulseActive ? (zh ? "守护进程运行中" : "Daemon active") : (zh ? "守护进程待机" : "Daemon idle")}
              </span>
            </div>
            {pulse?.dirtyFileCount !== undefined && pulse.dirtyFileCount > 0 && (
              <Badge variant="neutral" size="sm" mono>
                 <span title={zh ? "已变更与未跟踪文件数量" : "Changed and untracked files"}>
                   {zh ? `${pulse.dirtyFileCount} 个变更与未跟踪文件` : `${pulse.dirtyFileCount} changed/untracked`}
                 </span>
              </Badge>
            )}
          </div>
        </nav>

        {/* Workspace Body Area */}
        <div style={{ display: "flex", flex: 1, minWidth: 0, flexDirection: "column" }}>
          {/* TOP LOCATION BAR */}
          <header
            className="shell-topbar"
            style={{
              height: "var(--ds-topbar-height)",
              padding: "0 14px",
              borderBottom: "1px solid var(--border)",
              background: "var(--surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexShrink: 0
            }}
          >
            {/* Location Breadcrumb */}
            <Breadcrumb items={breadcrumbs} />

            {/* Global Actions */}
            <div className="shell-topbar-actions" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <Button
                className="shell-search-button"
                variant="outline"
                size="sm"
                icon={<Search size={12} />}
                aria-label={zh ? "搜索" : "Search"}
                onClick={() => setIsCommandOpen(true)}
              >
                <span>{zh ? "搜索" : "Search"}</span>
                <span
                  style={{
                    fontSize: "10px",
                    color: "var(--muted)",
                    background: "var(--surface-subtle)",
                    padding: "0 3px",
                    borderRadius: "2px",
                    marginLeft: "2px"
                  }}
                >
                  Ctrl+K
                </span>
              </Button>

              <Button
                className="shell-locale-button"
                variant="ghost"
                size="sm"
                icon={<Languages size={12} aria-hidden="true" />}
                aria-label={locale === "zh-CN" ? "Switch to English" : "切换到中文"}
                onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}
                style={{ fontSize: "11px", padding: "0 6px" }}
              >
                <span>{locale === "zh-CN" ? "中文" : "English"}</span>
              </Button>

              <div role="group" aria-label={zh ? "主题设置" : "Theme settings"} style={{ display: "flex", alignItems: "center", gap: "2px" }}>
                <IconButton
                  icon={<Monitor size={14} />}
                  label={zh ? "跟随系统" : "System"}
                  size="sm"
                  active={themePreference === "system"}
                  onClick={() => setThemePreference ? setThemePreference("system") : cycleTheme()}
                />
                <IconButton
                  icon={<Sun size={14} />}
                  label={zh ? "浅色" : "Light"}
                  size="sm"
                  active={themePreference === "light"}
                  onClick={() => setThemePreference ? setThemePreference("light") : cycleTheme()}
                />
                <IconButton
                  icon={<Moon size={14} />}
                  label={zh ? "深色" : "Dark"}
                  size="sm"
                  active={themePreference === "dark"}
                  onClick={() => setThemePreference ? setThemePreference("dark") : cycleTheme()}
                />
              </div>

              {onRefresh && (
                <IconButton
                  icon={<RefreshCw size={13} className={refreshing ? "ds-spin" : ""} />}
                  label={zh ? "刷新" : "Refresh"}
                  size="sm"
                  onClick={onRefresh}
                />
              )}
            </div>
          </header>

          {/* Notices banner if errors exist */}
          {notices.length > 0 && (
            <div style={{ background: "var(--warning-soft)", borderBottom: "1px solid var(--warning-faint)", padding: "4px 14px" }}>
              {notices.map(n => (
                <div key={n.id} style={{ fontSize: "11px", color: "var(--warning-strong)", display: "flex", alignItems: "center", gap: "6px" }}>
                  <AlertCircle size={12} />
                  <span><strong>{n.label}:</strong> {n.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Main Content Area */}
          <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
            <main
              style={{
                flex: 1,
                minWidth: 0,
                overflowY: "auto",
                background: "var(--background)"
              }}
            >
              {children}
            </main>

            {/* Selection-Driven Contextual Inspector */}
            <aside
              aria-hidden={!inspectorOpen}
              style={{
                width: inspectorOpen ? "380px" : "0px",
                borderLeft: inspectorOpen ? "1px solid var(--border)" : "none",
                background: "var(--surface)",
                display: inspectorOpen ? "flex" : "none",
                flexDirection: "column",
                overflow: "hidden",
                flexShrink: 0
              }}
            >
              {inspectorOpen && (
                <>
                  <div
                    style={{
                      height: "var(--ds-topbar-height)",
                      padding: "0 12px",
                      borderBottom: "1px solid var(--border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      background: "var(--surface-subtle)"
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: "13px" }}>
                      {inspectorContext?.customTitle ||
                        (inspectorContext?.finding ? `审查发现: ${inspectorContext.finding.title}` :
                         inspectorContext?.agent ? `智能体: ${inspectorContext.agent.label}` :
                         inspectorContext?.commit ? `提交: ${inspectorContext.commit.sha?.substring(0, 7)}` :
                         "详情")}
                    </span>
                    <IconButton icon={<X size={14} />} label="Close" size="sm" onClick={() => setInspectorOpen(false)} />
                  </div>
                  <div style={{ padding: "14px", overflowY: "auto", flex: 1 }}>
                    {inspectorContext?.customContent ||
                     (inspectorContext?.finding && (
                       <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "12px" }}>
                         <div style={{ display: "flex", gap: "6px" }}>
                           <Badge variant={findingSeverityVariants[inspectorContext.finding.severity]}>{inspectorContext.finding.severity.toUpperCase()}</Badge>
                           <Badge variant="neutral">{inspectorContext.finding.confidence}</Badge>
                         </div>
                         <div>
                           <div style={{ color: "var(--muted)" }}>位置:</div>
                           <code style={{ fontFamily: "var(--ds-font-mono)" }}>{inspectorContext.finding.file}</code>
                         </div>
                         <div>
                           <div style={{ color: "var(--muted)" }}>证据:</div>
                           <pre style={{ background: "var(--surface-subtle)", padding: "8px", borderRadius: "var(--ds-radius-sm)", fontSize: "11px", margin: "4px 0 0 0", whiteSpace: "pre-wrap" }}>{inspectorContext.finding.evidence}</pre>
                         </div>
                         <div>
                           <div style={{ color: "var(--muted)" }}>建议:</div>
                           <p style={{ margin: "4px 0 0 0" }}>{inspectorContext.finding.recommendation}</p>
                         </div>
                       </div>
                     ))}
                  </div>
                </>
              )}
            </aside>
          </div>
        </div>
      </div>

      {/* COMPACT BOTTOM STATUS BAR */}
      <footer
        style={{
          height: "var(--ds-statusbar-height)",
          padding: "0 10px",
          borderTop: "1px solid var(--border)",
          background: "var(--surface)",
          fontSize: "11px",
          color: "var(--muted-strong)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
          userSelect: "none"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <GitBranch size={11} />
            <span style={{ fontFamily: "var(--ds-font-mono)" }}>{activeBranch}</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <Cpu size={11} />
            <span>
              {modelProvider === "none" || health?.llmConfigured === false
                ? (zh ? "LLM 未配置" : "LLM unconfigured")
                : `LLM: ${modelProvider}${activeModel ? ` · ${activeModel}` : ""}`}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <Activity size={11} color={apiConnected ? "var(--success)" : "var(--warning)"} />
            <span>{apiConnected ? (zh ? "API 已连接" : "API connected") : (zh ? "API 状态未知" : "API unavailable")}</span>
          </div>

          {buildInfo?.commitSha && (
            <span style={{ fontFamily: "var(--ds-font-mono)", opacity: 0.8 }}>
              Build {buildInfo.commitSha.substring(0, 7)}
            </span>
          )}
        </div>
      </footer>

      {/* Quick Connect Dialog */}
      <Dialog
        isOpen={isConnectOpen}
        onClose={() => setIsConnectOpen(false)}
        title={zh ? "连接代码仓库" : "Connect Repository"}
        description={zh ? "选择本地 Git 工作区目录开始审查" : "Select a local Git repository worktree"}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <p style={{ fontSize: "12px", color: "var(--muted)", margin: 0 }}>
            {zh
              ? "在桌面端调用原生文件夹选择器，或在 Web 端配置本地审查根目录。"
              : "Use the desktop native folder picker or configure local roots in Web mode."}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <Button variant="outline" size="sm" onClick={() => setIsConnectOpen(false)}>
              {zh ? "取消" : "Cancel"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<FolderGit2 size={13} />}
              onClick={async () => {
                const bridge = desktopBridge();
                if (bridge) {
                  const res = await bridge.selectRepository();
                  if (!res.canceled && "repository" in res) {
                    setIsConnectOpen(false);
                    navigate(`/repositories/${encodeURIComponent(res.repository.id)}/overview`);
                  }
                }
              }}
            >
              {zh ? "选择本地目录" : "Select Directory"}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Settings Dialog */}
      {isSettingsOpen && (
        <SettingsDialog
          isOpen
          onClose={() => setIsSettingsOpen(false)}
          health={health}
        />
      )}

      {/* Command Palette Dialog */}
      <Dialog
        isOpen={isCommandOpen}
        onClose={() => setIsCommandOpen(false)}
        title={zh ? "快捷命令 (Command Palette)" : "Command Palette"}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <input
            type="text"
            autoFocus
            value={commandQuery}
            onChange={e => setCommandQuery(e.target.value)}
            placeholder={zh ? "输入命令或页面名称..." : "Type a command..."}
            className="ds-input ds-input--sm"
          />
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <Button
              variant="ghost"
              size="sm"
              style={{ justifyContent: "flex-start" }}
              onClick={() => {
                navigate("/repositories");
                setIsCommandOpen(false);
              }}
            >
              跳转到代码仓库 (Repositories)
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ justifyContent: "flex-start" }}
              onClick={() => {
                navigate("/runs");
                setIsCommandOpen(false);
              }}
            >
              跳转到审查运行记录 (Runs)
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ justifyContent: "flex-start" }}
              onClick={() => {
                navigate("/settings");
                setIsCommandOpen(false);
              }}
            >
              跳转到系统设置 (Settings)
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
};
