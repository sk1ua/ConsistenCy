import React, { useState, useEffect, useMemo } from "react";
import {
  FolderGit2,
  PlayCircle,
  ShieldAlert,
  GitFork,
  Settings,
  Plus,
  RefreshCw,
  Sun,
  Moon,
  Search,
  Activity,
  GitBranch,
  Cpu,
  Layers,
  ChevronDown,
  CheckCircle2,
  AlertCircle
} from "lucide-react";
import { NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import type {
  AgentRuntimeSnapshot,
  HeartbeatPulse,
  Repository,
  ReviewFinding,
  ReviewJob,
  ReviewReport
} from "@consistency/schema";
import type { HealthResponse } from "../api/client";
import type { Locale } from "../i18n";
import type { RouteMeta } from "../routes/meta";
import type { ThemePreference } from "../theme";
import { Button } from "../design-system/Button";
import { IconButton } from "../design-system/IconButton";
import { Badge } from "../design-system/Badge";
import { Breadcrumb, type BreadcrumbItem } from "../design-system/Breadcrumb";
import { CommandPalette } from "../design-system/CommandPalette";
import { Inspector } from "../design-system/Inspector";
import { ConnectRepositoryDialog } from "../components/ConnectRepositoryDialog";
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
  commit?: any;
  customTitle?: string;
  customContent?: React.ReactNode;
}

export interface AppShellProps {
  children: React.ReactNode;
  path: string;
  routeHref: string;
  meta: RouteMeta;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  themePreference: ThemePreference;
  themeLabel: string;
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
  return Boolean((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "p") && !e.shiftKey && !e.altKey);
}

export const AppShell: React.FC<AppShellProps> = ({
  children,
  path,
  meta,
  locale = "en-US",
  setLocale = () => {},
  themePreference,
  cycleTheme,
  jobs,
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

  const [isConnectOpen, setIsConnectOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [buildInfo, setBuildInfo] = useState<DesktopBuildInfo | null>(null);

  // Global Ctrl+K / Cmd+K listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setIsCommandPaletteOpen(prev => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Fetch Desktop build info if running in Electron
  useEffect(() => {
    const bridge = desktopBridge();
    if (bridge?.buildInfo) {
      bridge.buildInfo().then(info => setBuildInfo(info)).catch(() => {});
    }
  }, []);

  // Selection-driven Inspector: open when context exists, close when cleared
  useEffect(() => {
    if (inspectorContext && (inspectorContext.finding || inspectorContext.agent || inspectorContext.commit || inspectorContext.customContent)) {
      setInspectorOpen(true);
    } else {
      setInspectorOpen(false);
    }
  }, [inspectorContext]);

  // Derive active repository from URL if present
  const activeRepo = useMemo(() => {
    const match = path.match(/^\/repositories\/([^/]+)/);
    if (match?.[1]) {
      const id = decodeURIComponent(match[1]);
      return repositories.find(r => r.id === id || r.displayName === id) ?? {
        id,
        displayName: id,
        source: "local_git" as const,
        trustLevel: "trusted_local" as const,
        monitoringEnabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }
    return repositories[0];
  }, [path, repositories]);

  // Generate location breadcrumbs
  const breadcrumbs = useMemo<BreadcrumbItem[]>(() => {
    const items: BreadcrumbItem[] = [
      { label: "ConsistenCy", to: "/repositories", icon: <Layers size={14} /> }
    ];

    if (path.startsWith("/repositories/") && activeRepo) {
      items.push({
        label: activeRepo.displayName,
        to: `/repositories/${encodeURIComponent(activeRepo.id)}/overview`
      });
      if (path.includes("/changes")) {
        items.push({ label: "工作区变更 (Changes)" });
      } else if (path.includes("/history")) {
        items.push({ label: "提交历史 (History)" });
      } else if (path.includes("/pull-requests")) {
        items.push({ label: "Pull Requests" });
      } else if (path.includes("/overview")) {
        items.push({ label: "仓库概览 (Overview)" });
      }
    } else if (path.startsWith("/runs/") && params.runId) {
      const runId = decodeURIComponent(params.runId);
      const currentJob = jobs.find(j => j.id === runId);
      items.push({ label: "审查运行记录", to: "/runs" });
      items.push({
        label: currentJob ? `${currentJob.repositoryFullName} · ${runId.substring(0, 8)}` : runId.substring(0, 8),
        to: `/runs/${encodeURIComponent(runId)}/overview`
      });
      if (path.includes("/diff")) items.push({ label: "Diff 视图" });
      else if (path.includes("/evidence")) items.push({ label: "证据链 (Evidence)" });
      else if (path.includes("/notebook")) items.push({ label: "调查记录本 (Notebook)" });
      else if (path.includes("/runtime")) items.push({ label: "运行时 (Runtime)" });
      else if (path.includes("/overview")) items.push({ label: "概览 (Overview)" });
    } else if (path.startsWith("/repositories")) {
      items.push({ label: "代码仓库 (Repositories)" });
    } else if (path.startsWith("/runs")) {
      items.push({ label: "审查运行记录 (Runs)" });
    } else if (path.startsWith("/findings")) {
      items.push({ label: "审查发现 (Findings)" });
    } else if (path.startsWith("/workflows")) {
      items.push({ label: "工作流与触发器 (Workflows)" });
    } else if (path.startsWith("/settings")) {
      items.push({ label: "系统设置 (Settings)" });
    } else if (path.startsWith("/inbox")) {
      items.push({ label: "审查工作区 (Overview)" });
    }

    return items;
  }, [path, activeRepo, params.runId, jobs]);

  const zh = locale === "zh-CN";

  // Primary navigation links
  const navItems = [
    { to: "/inbox", label: zh ? "收件箱" : "Inbox", en: "Inbox", icon: <Layers size={16} /> },
    { to: "/repositories", label: zh ? "代码仓库" : "Repositories", en: "Repositories", icon: <FolderGit2 size={16} /> },
    { to: "/runs", label: zh ? "审查运行" : "Runs", en: "Runs", icon: <PlayCircle size={16} />, badge: jobs.filter(j => j.status === "running").length || undefined },
    { to: "/findings", label: zh ? "审查发现" : "Findings", en: "Findings", icon: <ShieldAlert size={16} /> },
    { to: "/workflows", label: zh ? "工作流" : "Workflows", en: "Workflows", icon: <GitFork size={16} /> },
    { to: "/settings", label: zh ? "系统设置" : "Settings", en: "Settings", icon: <Settings size={16} /> }
  ];

  const activeBranch = pulse?.repository.branch || "main";
  const activeModel = health?.llmModel || (health?.llmProvider === "deepseek" ? "deepseek-v4-flash" : "gpt-4.1-mini");
  const modelProvider = health?.llmProvider || "none";
  const isPulseActive = pulse?.state === "idle" || pulse?.state === "scanning" || pulse?.state === "indexing";

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
      {/* Upper Area: Sidebar + Main Content */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
        {/* ONE Persistent Sidebar */}
        <nav
          aria-label="Application Navigation"
          style={{
            width: "240px",
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
              height: "48px",
              padding: "0 14px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div
                style={{
                  width: "24px",
                  height: "24px",
                  borderRadius: "var(--ds-radius-sm)",
                  background: "var(--primary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#ffffff",
                  fontWeight: 700,
                  fontSize: "13px"
                }}
              >
                C
              </div>
              <span style={{ fontWeight: 600, fontSize: "14px", letterSpacing: "-0.2px" }}>
                ConsistenCy
              </span>
              <Badge variant="neutral" size="sm" mono>
                v3
              </Badge>
            </div>
          </div>

          {/* Repository Selector / Switcher */}
          <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-subtle)" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "6px"
              }}
            >
              <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--muted)", textTransform: "uppercase" }}>
                当前仓库
              </span>
              <IconButton
                icon={<Plus size={13} />}
                label="连接仓库"
                size="sm"
                onClick={() => setIsConnectOpen(true)}
              />
            </div>

            {repositories.length > 0 ? (
              <div
                onClick={() => navigate(`/repositories/${encodeURIComponent(activeRepo?.id || repositories[0]?.id || "")}/overview`)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 8px",
                  borderRadius: "var(--ds-radius-sm)",
                  background: "var(--surface-subtle)",
                  cursor: "pointer",
                  border: "1px solid var(--border)"
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                  <FolderGit2 size={14} style={{ color: "var(--primary)", flexShrink: 0 }} />
                  <span
                    style={{
                      fontSize: "12px",
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap"
                    }}
                  >
                    {activeRepo?.displayName || repositories[0]?.displayName}
                  </span>
                </div>
                <ChevronDown size={13} style={{ color: "var(--muted)", flexShrink: 0 }} />
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                fullWidth
                icon={<Plus size={13} />}
                onClick={() => setIsConnectOpen(true)}
              >
                连接代码仓库...
              </Button>
            )}
          </div>

          {/* Primary Nav Links */}
          <div style={{ flex: 1, padding: "8px 8px", display: "flex", flexDirection: "column", gap: "2px", overflowY: "auto" }}>
            {navItems.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `ds-app-link ${isActive ? "ds-button--active" : ""}`
                }
                style={({ isActive }) => ({
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 10px",
                  borderRadius: "var(--ds-radius-md)",
                  fontSize: "13px",
                  color: isActive ? "var(--primary)" : "var(--foreground)",
                  background: isActive ? "var(--surface-subtle)" : "transparent",
                  fontWeight: isActive ? 600 : 400
                })}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "inherit", display: "inline-flex" }}>{item.icon}</span>
                  <span>{item.label}</span>
                </div>
                {item.badge !== undefined && (
                  <Badge variant="warning" size="sm">
                    {item.badge}
                  </Badge>
                )}
              </NavLink>
            ))}
          </div>

          {/* Sidebar Footer: Heartbeat daemon indicator */}
          <div
            style={{
              padding: "10px 12px",
              borderTop: "1px solid var(--border)",
              background: "var(--surface-subtle)",
              fontSize: "11px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span
                style={{
                  width: "7px",
                  height: "7px",
                  borderRadius: "50%",
                  background: isPulseActive ? "var(--success)" : "var(--muted)"
                }}
              />
              <span style={{ color: "var(--muted-strong)" }}>
                {isPulseActive ? "守护进程运行中" : "守护进程待机"}
              </span>
            </div>
            {pulse?.dirtyFileCount !== undefined && pulse.dirtyFileCount > 0 && (
              <Badge variant="neutral" size="sm" mono>
                {pulse.dirtyFileCount} 变更
              </Badge>
            )}
          </div>
        </nav>

        {/* Main Center + Inspector Area */}
        <div style={{ display: "flex", flex: 1, minWidth: 0, flexDirection: "column" }}>
          {/* ONE Top Location Bar */}
          <header
            style={{
              height: "48px",
              padding: "0 16px",
              borderBottom: "1px solid var(--border)",
              background: "var(--surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexShrink: 0
            }}
          >
            {/* Breadcrumb Hierarchy */}
            <Breadcrumb items={breadcrumbs} />

            {/* Global Actions */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Button
                variant="outline"
                size="sm"
                icon={<Search size={13} />}
                onClick={() => setIsCommandPaletteOpen(true)}
              >
                <span>搜索...</span>
                <span
                  style={{
                    fontSize: "10px",
                    color: "var(--muted)",
                    background: "var(--surface-subtle)",
                    padding: "1px 4px",
                    borderRadius: "3px",
                    marginLeft: "4px"
                  }}
                >
                  Ctrl+K
                </span>
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}
                style={{ fontSize: "12px", padding: "0 8px" }}
              >
                {locale === "zh-CN" ? "中文" : "English"}
              </Button>

              <IconButton
                icon={themePreference === "dark" ? <Sun size={15} /> : <Moon size={15} />}
                label={`切换主题 (${themePreference})`}
                size="sm"
                onClick={cycleTheme}
              />

              {onRefresh && (
                <IconButton
                  icon={<RefreshCw size={14} className={refreshing ? "ds-spin" : ""} />}
                  label="刷新数据"
                  size="sm"
                  onClick={onRefresh}
                />
              )}
            </div>
          </header>

          {/* Notices banner if errors exist */}
          {notices.length > 0 && (
            <div style={{ background: "var(--warning-soft)", borderBottom: "1px solid var(--warning-faint)", padding: "6px 16px" }}>
              {notices.map(n => (
                <div key={n.id} style={{ fontSize: "12px", color: "var(--warning-strong)", display: "flex", alignItems: "center", gap: "6px" }}>
                  <AlertCircle size={13} />
                  <span><strong>{n.label}:</strong> {n.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Workspace Body: Content + Contextual Inspector */}
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

            {/* Selection-Driven Inspector */}
            <Inspector
              isOpen={inspectorOpen}
              onClose={() => setInspectorOpen(false)}
              title={
                inspectorContext?.customTitle ||
                (inspectorContext?.finding ? `审查发现: ${inspectorContext.finding.title}` :
                 inspectorContext?.agent ? `智能体: ${inspectorContext.agent.label}` :
                 inspectorContext?.commit ? `提交记录: ${inspectorContext.commit.sha?.substring(0, 7)}` :
                 "上下文详情")
              }
              subtitle={
                inspectorContext?.finding?.file ? `${inspectorContext.finding.file}:${inspectorContext.finding.startLine ?? ""}` :
                inspectorContext?.agent?.state ? `状态: ${inspectorContext.agent.state}` : undefined
              }
            >
              {inspectorContext?.customContent ? (
                inspectorContext.customContent
              ) : inspectorContext?.finding ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <Badge variant={inspectorContext.finding.severity as any}>
                      {inspectorContext.finding.severity.toUpperCase()}
                    </Badge>
                    <Badge variant="neutral">{inspectorContext.finding.confidence}</Badge>
                    <Badge variant="neutral">{inspectorContext.finding.agent}</Badge>
                  </div>

                  <div>
                    <h4 style={{ margin: "0 0 4px 0", fontSize: "12px", color: "var(--muted)" }}>位置</h4>
                    <div style={{ fontFamily: "var(--ds-font-mono)", fontSize: "12px" }}>
                      {inspectorContext.finding.file}
                      {inspectorContext.finding.startLine !== undefined && `:${inspectorContext.finding.startLine}`}
                    </div>
                  </div>

                  <div>
                    <h4 style={{ margin: "0 0 4px 0", fontSize: "12px", color: "var(--muted)" }}>事实证据</h4>
                    <pre
                      style={{
                        padding: "8px",
                        borderRadius: "var(--ds-radius-sm)",
                        background: "var(--surface-muted)",
                        border: "1px solid var(--border)",
                        fontSize: "11px",
                        fontFamily: "var(--ds-font-mono)",
                        whiteSpace: "pre-wrap",
                        margin: 0
                      }}
                    >
                      {inspectorContext.finding.evidence}
                    </pre>
                  </div>

                  <div>
                    <h4 style={{ margin: "0 0 4px 0", fontSize: "12px", color: "var(--muted)" }}>分析推理</h4>
                    <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.5 }}>
                      {inspectorContext.finding.reasoning}
                    </p>
                  </div>

                  <div>
                    <h4 style={{ margin: "0 0 4px 0", fontSize: "12px", color: "var(--muted)" }}>整改建议</h4>
                    <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.5, color: "var(--success-strong)" }}>
                      {inspectorContext.finding.recommendation}
                    </p>
                  </div>
                </div>
              ) : inspectorContext?.agent ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <Badge variant={inspectorContext.agent.state === "succeeded" || inspectorContext.agent.state === "active" ? "success" : "neutral"}>
                      {inspectorContext.agent.state.toUpperCase()}
                    </Badge>
                    <Badge variant="neutral" mono>
                      Ring {inspectorContext.agent.logicalRing}
                    </Badge>
                  </div>
                  <div>
                    <h4 style={{ margin: "0 0 4px 0", fontSize: "12px", color: "var(--muted)" }}>智能体标识</h4>
                    <p style={{ margin: 0, fontSize: "13px", fontFamily: "var(--ds-font-mono)" }}>{inspectorContext.agent.label} ({inspectorContext.agent.agentId})</p>
                  </div>
                  <div>
                    <h4 style={{ margin: "0 0 4px 0", fontSize: "12px", color: "var(--muted)" }}>执行域</h4>
                    <p style={{ margin: 0, fontSize: "13px" }}>{inspectorContext.agent.executionDomain}</p>
                  </div>
                  <div>
                    <h4 style={{ margin: "0 0 4px 0", fontSize: "12px", color: "var(--muted)" }}>已授权能力句柄</h4>
                    <div style={{ fontSize: "13px", fontWeight: 600 }}>{inspectorContext.agent.capabilities.length} 项能力</div>
                  </div>
                </div>
              ) : null}
            </Inspector>
          </div>
        </div>
      </div>

      {/* ONE Bottom Status Bar */}
      <footer
        style={{
          height: "28px",
          padding: "0 12px",
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
            <GitBranch size={12} />
            <span style={{ fontFamily: "var(--ds-font-mono)" }}>{activeBranch}</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <Cpu size={12} />
            <span>LLM: {modelProvider} · {activeModel}</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <Activity size={12} color="var(--success)" />
            <span>{zh ? "API 已连接" : "API connected"}</span>
          </div>

          <span style={{ fontFamily: "var(--ds-font-mono)", opacity: 0.8 }}>
            Build {buildInfo?.commitSha?.substring(0, 7) || "v3-pr2"}
          </span>
        </div>
      </footer>

      {/* Central Modals */}
      <ConnectRepositoryDialog
        isOpen={isConnectOpen}
        onClose={() => setIsConnectOpen(false)}
        onSuccess={repo => {
          if (repo?.id) {
            navigate(`/repositories/${encodeURIComponent(repo.id)}/overview`);
          }
        }}
      />

      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        customCommands={[
          {
            id: "action-connect",
            title: "连接新代码仓库...",
            category: "Actions",
            icon: <Plus size={16} />,
            onSelect: () => {
              setIsCommandPaletteOpen(false);
              setIsConnectOpen(true);
            }
          }
        ]}
      />
    </div>
  );
};
