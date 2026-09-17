import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Cpu,
  FolderGit2,
  FolderTree,
  GitBranch,
  Languages,
  Monitor,
  Moon,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Sun,
  User,
  Zap
} from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
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
import { Badge } from "../design-system/Badge";
import type { BadgeVariant } from "../design-system/Badge";
import { Breadcrumb, type BreadcrumbItem } from "../design-system/Breadcrumb";
import { Dialog } from "../design-system/Dialog";
import { SettingsDialog } from "../components/SettingsDialog";
import { closeSettingsDialog, openSettingsDialog, useSettingsDialogOpen } from "../settingsDialogStore";
import { desktopBridge, type DesktopBuildInfo } from "../desktop";
import { RelatedCards, type RelatedCardsFocus } from "./RelatedCards";
import { RepoDirectoryPanel } from "./RepoDirectoryPanel";

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
  } catch {
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
  const params = useParams();
  const zh = locale === "zh-CN";

  const [isConnectOpen, setIsConnectOpen] = useState(false);
  const isSettingsOpen = useSettingsDialogOpen();
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [buildInfo, setBuildInfo] = useState<DesktopBuildInfo | null>(null);
  const [directoryRepoId, setDirectoryRepoId] = useState<string | null>(null);
  const [relatedFocus, setRelatedFocus] = useState<RelatedCardsFocus>(null);
  const statusCardRef = useRef<HTMLElement | null>(null);

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

  useEffect(() => {
    const bridge = desktopBridge();
    if (bridge?.buildInfo) {
      void bridge.buildInfo().then(info => setBuildInfo(info), () => undefined);
    }
  }, []);

  useEffect(() => {
    if (relatedFocus === "status" && statusCardRef.current) {
      statusCardRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [relatedFocus, path]);

  const routeRepositoryId = useMemo(() => {
    const match = path.match(/^\/repositories\/([^/]+)/);
    return safeDecodeURIComponent(match?.[1]);
  }, [path]);

  const pulseRepositoryName = pulse?.repository.root?.split(/[\\/]/).filter(Boolean).at(-1);

  const activeRepo = useMemo(() => {
    if (routeRepositoryId) return repositories.find(r => r.id === routeRepositoryId);
    if (path.startsWith("/repositories/")) return undefined;
    return repositories[0];
  }, [repositories, routeRepositoryId, path]);

  const activeRepositoryName = activeRepo?.displayName ?? (
    !routeRepositoryId && pulseRepositoryName ? pulseRepositoryName : undefined
  );
  const activeRepositoryId = routeRepositoryId ?? activeRepo?.id;

  const filteredRepos = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    if (!q) return repositories;
    return repositories.filter(r =>
      r.displayName.toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q) ||
      (r.remoteFullName?.toLowerCase().includes(q) ?? false)
    );
  }, [projectQuery, repositories]);

  const breadcrumbs = useMemo<BreadcrumbItem[]>(() => {
    const items: BreadcrumbItem[] = [
      { label: "ConsistenCy", to: "/inbox", icon: <FolderGit2 size={13} /> }
    ];

    if (path.startsWith("/automation")) {
      items.push({ label: zh ? "自动化" : "Automation" });
      return items;
    }
    if (path.startsWith("/plugins")) {
      items.push({ label: zh ? "插件市场" : "Plugin marketplace" });
      return items;
    }
    if (path === "/inbox" || path === "/") {
      items.push({ label: zh ? "审查工作台" : "Review workbench" });
      if (activeRepositoryName) items.push({ label: activeRepositoryName });
      return items;
    }

    if (path.startsWith("/repositories/") && activeRepositoryName) {
      items.push({
        label: activeRepositoryName,
        to: `/repositories/${encodeURIComponent(activeRepositoryId ?? activeRepositoryName)}/overview`
      });
      if (path.includes("/changes")) items.push({ label: zh ? "变更" : "Changes" });
      else if (path.includes("/history")) items.push({ label: zh ? "Git 提交历史" : "Git History" });
      else if (path.includes("/pull-requests")) items.push({ label: zh ? "拉取请求" : "Pull Requests" });
      else if (path.includes("/reviews")) items.push({ label: zh ? "审查" : "Reviews" });
      else if (path.includes("/workflows")) items.push({ label: zh ? "工作流" : "Workflows" });
      else items.push({ label: zh ? "概览" : "Overview" });
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
      if (repositoryId) items.push({ label: repositoryId || (zh ? "代码仓库" : "Repositories") });
      else items.push({ label: zh ? "无效的仓库 ID" : "Invalid repository ID" });
      if (path.includes("/changes")) items.push({ label: zh ? "变更" : "Changes" });
      else if (path.includes("/history")) items.push({ label: zh ? "Git 提交历史" : "Git History" });
      else if (path.includes("/pull-requests")) items.push({ label: zh ? "拉取请求" : "Pull Requests" });
      else if (path.includes("/reviews")) items.push({ label: zh ? "审查" : "Reviews" });
      else if (path.includes("/workflows")) items.push({ label: zh ? "工作流" : "Workflows" });
      else items.push({ label: zh ? "概览" : "Overview" });
    } else if (path.startsWith("/repositories")) {
      items.push({ label: zh ? "代码仓库" : "Repositories" });
    } else if (path.startsWith("/runs")) {
      items.push({ label: zh ? "审查运行" : "Runs" });
    } else if (path.startsWith("/findings")) {
      items.push({ label: zh ? "审查发现" : "Findings" });
    } else if (path.startsWith("/workflows")) {
      items.push({ label: zh ? "工作流" : "Workflows" });
    }

    return items;
  }, [activeRepositoryName, activeRepositoryId, path, params.runId, jobs, zh]);

  const activeBranch = pulse?.repository.branch || "—";
  const activeModel = health?.llmModel || "";
  const modelProvider = health?.llmProvider || "none";
  const apiConnected = health?.ok === true && !healthUnavailable;
  const directoryRepo = repositories.find(r => r.id === directoryRepoId);

  const openRepoStatus = (repo: Repository) => {
    setRelatedFocus("status");
    navigate(`/repositories/${encodeURIComponent(repo.id)}/overview`);
  };

  const openRepoDirectory = (repo: Repository) => {
    setDirectoryRepoId(repo.id);
  };

  const selectRepo = (repo: Repository) => {
    navigate(`/repositories/${encodeURIComponent(repo.id)}/overview`);
  };

  const commandItems = [
    { label: zh ? "审查工作台" : "Review workbench", to: "/inbox" },
    { label: zh ? "自动化" : "Automation", to: "/automation" },
    { label: zh ? "插件市场" : "Plugin marketplace", to: "/plugins" },
    { label: zh ? "代码仓库" : "Repositories", to: "/repositories" },
    { label: zh ? "工作流 Studio" : "Workflow Studio", to: "/workflows" },
    { label: zh ? "审查运行" : "Runs", to: "/runs" },
    { label: zh ? "审查发现" : "Findings", to: "/findings" },
    { label: zh ? "系统设置" : "Settings", action: () => openSettingsDialog() }
  ].filter(item => {
    const q = commandQuery.trim().toLowerCase();
    if (!q) return true;
    return item.label.toLowerCase().includes(q);
  });

  const showRelatedRail = Boolean(activeRepo) || path.startsWith("/repositories/") || path === "/inbox" || path === "/";

  return (
    <div className="ds-root audit-shell agent-shell">
      <div className="agent-shell__frame">
        <div className="agent-shell__columns">
          {/* LEFT — project rail */}
          <nav className="agent-shell__left repo-first-sidebar" aria-label={zh ? "项目导航" : "Project navigation"}>
            <div className="agent-shell__brand">
              <div className="shell-brand-mark">C</div>
              <div className="agent-shell__brand-text">
                <strong>ConsistenCy</strong>
                <span>{zh ? "证据审查" : "Evidence review"}</span>
              </div>
              <Badge variant="neutral" size="sm" mono>v3</Badge>
            </div>

            <div className="agent-shell__search">
              <Search size={13} aria-hidden="true" />
              <input
                type="search"
                value={projectQuery}
                onChange={e => setProjectQuery(e.target.value)}
                placeholder={zh ? "搜索项目 / 仓库…" : "Search projects / repos…"}
                aria-label={zh ? "项目搜索" : "Project search"}
              />
            </div>

            <div className="agent-shell__entries">
              <button
                type="button"
                className={`agent-shell__entry${path.startsWith("/automation") ? " is-active" : ""}`}
                onClick={() => navigate("/automation")}
              >
                <Zap size={14} />
                <span>{zh ? "自动化" : "Automation"}</span>
              </button>
              <button
                type="button"
                className={`agent-shell__entry${path.startsWith("/plugins") ? " is-active" : ""}`}
                onClick={() => navigate("/plugins")}
              >
                <Puzzle size={14} />
                <span>{zh ? "插件市场" : "Plugin marketplace"}</span>
              </button>
            </div>

            <div className="agent-shell__repo-section">
              <div className="agent-shell__section-label">
                <span>{zh ? "已连接仓库" : "Connected repositories"}</span>
                <IconButton
                  icon={<Plus size={12} />}
                  label={zh ? "连接仓库" : "Connect repository"}
                  size="sm"
                  onClick={() => setIsConnectOpen(true)}
                />
              </div>

              <div className="agent-shell__repo-list">
                {filteredRepos.length === 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    fullWidth
                    icon={<Plus size={12} />}
                    onClick={() => setIsConnectOpen(true)}
                  >
                    {zh ? "连接代码仓库…" : "Connect repo…"}
                  </Button>
                ) : (
                  filteredRepos.map(repo => {
                    const active = repo.id === activeRepositoryId;
                    return (
                      <div
                        key={repo.id}
                        className={`agent-shell__repo-row${active ? " is-active" : ""}`}
                      >
                        <button
                          type="button"
                          className="agent-shell__repo-main"
                          onClick={() => selectRepo(repo)}
                          title={repo.displayName}
                        >
                          <FolderGit2 size={13} />
                          <span>{repo.displayName}</span>
                        </button>
                        <div className="agent-shell__repo-actions">
                          <button
                            type="button"
                            className="agent-shell__repo-action"
                            title={zh ? "仓库情况" : "Repo status"}
                            aria-label={zh ? "仓库情况" : "Repo status"}
                            onClick={() => openRepoStatus(repo)}
                          >
                            <Activity size={12} />
                            <span>{zh ? "情况" : "Status"}</span>
                          </button>
                          <button
                            type="button"
                            className="agent-shell__repo-action"
                            title={zh ? "仓库目录" : "Repo directory"}
                            aria-label={zh ? "仓库目录" : "Repo directory"}
                            onClick={() => openRepoDirectory(repo)}
                          >
                            <FolderTree size={12} />
                            <span>{zh ? "目录" : "Tree"}</span>
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="agent-shell__left-footer">
              <IconButton
                icon={<Settings size={14} />}
                label={zh ? "设置" : "Settings"}
                size="sm"
                variant="ghost"
                onClick={openSettingsDialog}
              />
              <div className="agent-shell__user" title={zh ? "用户" : "User"}>
                <User size={13} />
                <span>{zh ? "本地用户" : "Local user"}</span>
              </div>
            </div>
          </nav>

          {/* CENTER — workbench / routes */}
          <div className="agent-shell__center">
            <header className="shell-topbar agent-shell__topbar">
              <Breadcrumb items={breadcrumbs} />
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
                  <span className="agent-shell__kbd">Ctrl+K</span>
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

            {notices.length > 0 && (
              <div className="agent-shell__notices">
                {notices.map(n => (
                  <div key={n.id}>
                    <AlertCircle size={12} />
                    <span><strong>{n.label}:</strong> {n.message}</span>
                  </div>
                ))}
              </div>
            )}

            <main className="shell-main-canvas agent-shell__main">
              {children}
            </main>
          </div>

          {/* RIGHT — related cards */}
          {showRelatedRail && (
            <RelatedCards
              locale={locale === "zh-CN" ? "zh-CN" : "en-US"}
              repository={activeRepo}
              jobs={jobs}
              focus={relatedFocus}
              statusCardRef={statusCardRef}
            />
          )}
        </div>

        <footer className="agent-shell__status" data-shell-status>
          <div className="agent-shell__status-left">
            <span><GitBranch size={11} /> <code className="shell-status-mono">{activeBranch}</code></span>
            <span>
              <Cpu size={11} />
              {modelProvider === "none" || health?.llmConfigured === false
                ? (zh ? "LLM 未配置" : "LLM unconfigured")
                : `LLM: ${modelProvider}${activeModel ? ` · ${activeModel}` : ""}`}
            </span>
          </div>
          <div className="agent-shell__status-right">
            <span>
              <Activity size={11} color={apiConnected ? "var(--success)" : "var(--warning)"} />
              {apiConnected ? (zh ? "API 已连接" : "API connected") : (zh ? "API 状态未知" : "API unavailable")}
            </span>
            {buildInfo?.commitSha && (
              <span className="shell-status-mono">Build {buildInfo.commitSha.substring(0, 7)}</span>
            )}
          </div>
        </footer>
      </div>

      {/* Selection inspector overlay (secondary; not primary chat) */}
      {inspectorContext && (inspectorContext.finding || inspectorContext.customContent) && (
        <aside className="agent-shell__inspector" aria-label={zh ? "详情" : "Details"}>
          <header>
            <span>
              {inspectorContext.customTitle ||
                (inspectorContext.finding
                  ? `${zh ? "审查发现" : "Finding"}: ${inspectorContext.finding.title}`
                  : (zh ? "详情" : "Details"))}
            </span>
          </header>
          <div>
            {inspectorContext.customContent ||
              (inspectorContext.finding && (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "12px" }}>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <Badge variant={findingSeverityVariants[inspectorContext.finding.severity]}>
                      {inspectorContext.finding.severity.toUpperCase()}
                    </Badge>
                    <Badge variant="neutral">{inspectorContext.finding.confidence}</Badge>
                  </div>
                  <div>
                    <div style={{ color: "var(--muted)" }}>{zh ? "位置" : "Location"}:</div>
                    <code style={{ fontFamily: "var(--ds-font-mono)" }}>{inspectorContext.finding.file}</code>
                  </div>
                  <div>
                    <div style={{ color: "var(--muted)" }}>{zh ? "证据" : "Evidence"}:</div>
                    <pre style={{ background: "var(--surface-subtle)", padding: "8px", borderRadius: "8px", fontSize: "11px", margin: "4px 0 0 0", whiteSpace: "pre-wrap" }}>
                      {inspectorContext.finding.evidence}
                    </pre>
                  </div>
                </div>
              ))}
          </div>
        </aside>
      )}

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
                } else {
                  setIsConnectOpen(false);
                  navigate("/repositories");
                }
              }}
            >
              {zh ? "选择本地目录" : "Select Directory"}
            </Button>
          </div>
        </div>
      </Dialog>

      {isSettingsOpen && (
        <SettingsDialog isOpen onClose={closeSettingsDialog} health={health} />
      )}

      <Dialog
        isOpen={isCommandOpen}
        onClose={() => setIsCommandOpen(false)}
        title={zh ? "快捷命令" : "Command Palette"}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <input
            type="text"
            autoFocus
            value={commandQuery}
            onChange={e => setCommandQuery(e.target.value)}
            placeholder={zh ? "输入命令或页面名称…" : "Type a command…"}
            className="ds-input ds-input--sm"
          />
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {commandItems.map(item => (
              <Button
                key={item.label}
                variant="ghost"
                size="sm"
                style={{ justifyContent: "flex-start" }}
                onClick={() => {
                  if ("action" in item && item.action) item.action();
                  else if ("to" in item && item.to) navigate(item.to);
                  setIsCommandOpen(false);
                  setCommandQuery("");
                }}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </div>
      </Dialog>

      {directoryRepo && (
        <RepoDirectoryPanel
          isOpen={Boolean(directoryRepoId)}
          onClose={() => setDirectoryRepoId(null)}
          repositoryId={directoryRepo.id}
          displayName={directoryRepo.displayName}
          locale={locale === "zh-CN" ? "zh-CN" : "en-US"}
        />
      )}
    </div>
  );
};
