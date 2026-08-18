import type {
  AgentRuntimeSnapshot,
  HeartbeatPulse,
  Repository,
  ReviewFinding,
  ReviewJob,
  ReviewReport
} from "@consistency/schema";
import {
  Activity,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  FileCode2,
  FileSearch2,
  FlaskConical,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Globe2,
  Inbox,
  Layers,
  Menu,
  Monitor,
  Moon,
  PanelRight,
  Plus,
  Radio,
  RefreshCw,
  ScanSearch,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  Workflow,
  X
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode
} from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import type { HealthResponse } from "../api/client";
import type { Locale } from "../i18n";
import type { RouteMeta } from "../routes/meta";
import type { ThemePreference } from "../theme";
import { nextTabId } from "../utils/tabNavigation";
import { useWorkbenchLayout, WORKBENCH_BOUNDS } from "./useWorkbenchLayout";
import { AgentInspectorContent } from "../components/runtime/RuntimePanel";

export type DataNotice = {
  id: string;
  label: string;
  message: string;
};

type Copy = {
  primaryNavigation: string;
  workbenchTabs: string;
  workspace: string;
  inbox: string;
  repositories: string;
  reviews: string;
  runs: string;
  findings: string;
  automations: string;
  workflows: string;
  settings: string;
  monitoredRepositories: string;
  reviewSources: string;
  noMonitor: string;
  noSources: string;
  openRepositoryView: string;
  inspector: string;
  evidence: string;
  agent: string;
  decision: string;
  inspectorEmpty: string;
  inspectorHint: string;
  evidenceStages: string[];
  notRecorded: string;
  runLedger: string;
  noActiveRuns: string;
  activeRuns: string;
  queued: string;
  refresh: string;
  retry: string;
  theme: string;
  language: string;
  openNavigation: string;
  closeNavigation: string;
  resizeExplorer: string;
  resizeInspector: string;
  loadDemo: string;
  demoMode: string;
  source: string;
  connected: string;
  unavailable: string;
  checking: string;
  worker: string;
  model: string;
  localHarness: string;
  selectedRun: string;
  findingsRecorded: string;
  evidenceItems: string;
  legacyDecisionSignal: string;
  humanDecisionPending: string;
  noAgentRuns: string;
  publicReadTrigger: string;
  githubTrigger: string;
  localTrigger: string;
  branch: string;
  trust: string;
  engine: string;
  lastScan: string;
  noScan: string;
  localFirst: string;
  commandPalette: string;
  commandPlaceholder: string;
  noCommands: string;
};

const copyByLocale: Record<Locale, Copy> = {
  "en-US": {
    primaryNavigation: "Primary navigation",
    workbenchTabs: "Open workbench tabs",
    workspace: "Workspace",
    inbox: "Inbox",
    repositories: "Repositories",
    reviews: "Reviews",
    runs: "Runs",
    findings: "Findings",
    automations: "Automations",
    workflows: "Workflows",
    settings: "Settings",
    monitoredRepositories: "Monitored repositories",
    reviewSources: "Review sources",
    noMonitor: "No live monitor connected",
    noSources: "No review sources yet",
    openRepositoryView: "Open repository hub",
    inspector: "Context Inspector",
    evidence: "Evidence",
    agent: "Agent",
    decision: "Decision",
    inspectorEmpty: "Nothing selected",
    inspectorHint: "Select an agent, finding, evidence, or commit to inspect details.",
    evidenceStages: ["Trigger", "Snapshot SHA", "Deterministic signal", "Evidence pack", "LLM explanation", "Human decision"],
    notRecorded: "Not recorded",
    runLedger: "Run ledger",
    noActiveRuns: "No active runs",
    activeRuns: "active",
    queued: "queued",
    refresh: "Refresh workspace",
    retry: "Retry failed sources",
    theme: "Theme",
    language: "Language",
    openNavigation: "Open workspace explorer",
    closeNavigation: "Close workspace explorer",
    resizeExplorer: "Resize workspace explorer",
    resizeInspector: "Resize context inspector",
    loadDemo: "Load demo data",
    demoMode: "Mock model",
    source: "Source",
    connected: "API connected",
    unavailable: "API unavailable",
    checking: "Checking API",
    worker: "Worker",
    model: "Model",
    localHarness: "Local audit harness",
    selectedRun: "Selected run",
    findingsRecorded: "findings recorded",
    evidenceItems: "evidence items",
    legacyDecisionSignal: "Legacy quality signal",
    humanDecisionPending: "No human disposition has been recorded.",
    noAgentRuns: "No agent runs were recorded.",
    publicReadTrigger: "Public PR · read-only",
    githubTrigger: "GitHub App PR",
    localTrigger: "Local manual review",
    branch: "Branch",
    trust: "Trust",
    engine: "Engine",
    lastScan: "Last scan",
    noScan: "not recorded",
    localFirst: "Local-first",
    commandPalette: "Command palette",
    commandPlaceholder: "Go to a workspace…",
    noCommands: "No matching workspace"
  },
  "zh-CN": {
    primaryNavigation: "主导航",
    workbenchTabs: "已打开的工作台标签",
    workspace: "工作区",
    inbox: "收件箱",
    repositories: "仓库",
    reviews: "审查",
    runs: "运行",
    findings: "发现",
    automations: "自动化",
    workflows: "工作流",
    settings: "设置",
    monitoredRepositories: "监控仓库",
    reviewSources: "审查来源",
    noMonitor: "尚未连接实时监控",
    noSources: "尚无审查来源",
    openRepositoryView: "打开仓库视图",
    inspector: "上下文检查器",
    evidence: "证据",
    agent: "智能体",
    decision: "决策",
    inspectorEmpty: "尚未选择内容",
    inspectorHint: "在工作台中选择智能体、发现、证据或提交以查看详情。",
    evidenceStages: ["触发", "快照 SHA", "确定性信号", "证据包", "LLM 解释", "人工决策"],
    notRecorded: "未记录",
    runLedger: "运行账本",
    noActiveRuns: "没有活跃运行",
    activeRuns: "运行中",
    queued: "排队中",
    refresh: "刷新工作区",
    retry: "重试失败来源",
    theme: "主题",
    language: "语言",
    openNavigation: "打开工作区浏览器",
    closeNavigation: "关闭工作区浏览器",
    resizeExplorer: "调整工作区浏览器宽度",
    resizeInspector: "调整上下文检查器宽度",
    loadDemo: "加载演示数据",
    demoMode: "Mock 模型",
    source: "来源",
    connected: "API 已连接",
    unavailable: "API 不可用",
    checking: "正在检查 API",
    worker: "工作进程",
    model: "模型",
    localHarness: "本地审计 Harness",
    selectedRun: "当前运行",
    findingsRecorded: "项发现已记录",
    evidenceItems: "条证据",
    legacyDecisionSignal: "旧版质量信号",
    humanDecisionPending: "尚未记录人工处置。",
    noAgentRuns: "尚未记录智能体运行。",
    publicReadTrigger: "公开 PR · 只读",
    githubTrigger: "GitHub App PR",
    localTrigger: "本地手动审查",
    branch: "分支",
    trust: "信任",
    engine: "引擎",
    lastScan: "最近扫描",
    noScan: "未记录",
    localFirst: "本地优先",
    commandPalette: "命令面板",
    commandPlaceholder: "转到工作区…",
    noCommands: "没有匹配的工作区"
  }
};

export type InspectorContext = {
  runId?: string;
  job?: ReviewJob;
  report?: ReviewReport;
  agent?: AgentRuntimeSnapshot;
  finding?: ReviewFinding;
};

export type WorkbenchTabId = "inbox" | "current";

export function nextWorkbenchTabId(tabs: readonly WorkbenchTabId[], current: WorkbenchTabId, key: string): WorkbenchTabId | undefined {
  if (!(["ArrowLeft", "ArrowRight", "Home", "End"] as const).includes(key as "ArrowLeft" | "ArrowRight" | "Home" | "End")) {
    return undefined;
  }
  return nextTabId(tabs, current, key);
}

export function isCommandPaletteShortcut(event: Pick<globalThis.KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  const key = event.key.toLowerCase();
  return !event.altKey && !event.shiftKey && (event.ctrlKey || event.metaKey) && (key === "k" || key === "p");
}

function repositoryName(pulse: HeartbeatPulse): string {
  if (pulse.repository.root === "unknown") return "Local repository";
  return pulse.repository.root.split(/[\\/]/).filter(Boolean).at(-1) ?? "Local repository";
}

function ResizeHandle({ value, min, max, direction, label, onChange }: {
  value: number;
  min: number;
  max: number;
  direction: 1 | -1;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <div
      className="workbench-resize-handle"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={event => {
        if (event.key === "Home") onChange(min);
        else if (event.key === "End") onChange(max);
        else if (event.key === "ArrowLeft") onChange(value - 12 * direction);
        else if (event.key === "ArrowRight") onChange(value + 12 * direction);
        else return;
        event.preventDefault();
      }}
      onPointerDown={event => {
        event.preventDefault();
        const originX = event.clientX;
        const originValue = value;
        const pointerId = event.pointerId;
        event.currentTarget.setPointerCapture(pointerId);
        const move = (moveEvent: PointerEvent) => onChange(originValue + (moveEvent.clientX - originX) * direction);
        const stop = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", stop);
          window.removeEventListener("pointercancel", stop);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop, { once: true });
        window.addEventListener("pointercancel", stop, { once: true });
      }}
    />
  );
}

function RepositorySidebar({
  open,
  hidden,
  jobs,
  repositories,
  pulse,
  copy,
  currentPath,
  zh,
  onNavigate,
  onClose
}: {
  open: boolean;
  hidden: boolean;
  jobs: ReviewJob[];
  repositories: Repository[];
  pulse: HeartbeatPulse | null;
  copy: Copy;
  currentPath: string;
  zh: boolean;
  onNavigate: () => void;
  onClose: () => void;
}) {
  const registeredRemoteNames = useMemo(() => new Set(repositories.map(r => r.remoteFullName).filter(Boolean)), [repositories]);
  const hasLocalPulse = Boolean(pulse);
  const historyRepoNames = useMemo(() => {
    return [...new Set(jobs.map(job => job.repositoryFullName).filter(name => {
      if (registeredRemoteNames.has(name)) return false;
      // If local repository is active, unify sk1ua/ConsistenCy with the local entry
      if (hasLocalPulse && (name === "sk1ua/ConsistenCy" || name === "ConsistenCy")) return false;
      return true;
    }))];
  }, [jobs, registeredRemoteNames, hasLocalPulse]);
  const recentRuns = useMemo(() => jobs.slice(0, 4), [jobs]);

  return (
    <aside className={`context-explorer repo-first-sidebar${open ? " open" : ""}`} aria-label={copy.workspace} aria-hidden={hidden || undefined} inert={hidden || undefined}>
      <div className="context-explorer-head">
        <NavLink to="/repositories" className="sidebar-brand-link" onClick={onNavigate}>
          <img src="/consistency-logo.png" alt="" className="brand-icon-small" />
          <div>
            <strong>ConsistenCy</strong>
            <span>{copy.localHarness}</span>
          </div>
        </NavLink>
        <button type="button" onClick={onClose} aria-label={copy.closeNavigation}>×</button>
      </div>

      <div className="context-explorer-scroll">
        {/* Repositories Section */}
        <section className="explorer-section">
          <div className="explorer-section-title">
            <span>{copy.repositories}</span>
            <NavLink to="/repositories" onClick={onNavigate} title={zh ? "连接代码仓库" : "Connect repository"} className="sidebar-connect-link">
              <Plus size={13} /> {zh ? "连接" : "Connect"}
            </NavLink>
          </div>

          <div className="sidebar-repo-list" role="list">
            {/* Unified Local Pulse Repository (Model A) */}
            {pulse && (
              <NavLink
                to={`/repositories/${encodeURIComponent("sk1ua/ConsistenCy")}`}
                className={`sidebar-repo-item ${currentPath.includes("ConsistenCy") || currentPath.includes("sk1ua%2FConsistenCy") ? "active" : ""}`}
                onClick={onNavigate}
              >
                <span className="repo-dot monitored" />
                <FolderGit2 size={14} className="repo-icon" />
                <div className="repo-text-group">
                  <strong>ConsistenCy</strong>
                  <small>{zh ? "本地 Git · GitHub 公开" : "local · GitHub public"} · {pulse.repository.branch ?? "v3-pr2"}</small>
                </div>
              </NavLink>
            )}

            {/* Registered Repositories (non-local pulse) */}
            {repositories.filter(r => !pulse || (r.displayName !== repositoryName(pulse) && r.remoteFullName !== "sk1ua/ConsistenCy")).map(repo => {
              const active = currentPath.startsWith(`/repositories/${encodeURIComponent(repo.id)}`) || currentPath.startsWith(`/repositories/${encodeURIComponent(repo.remoteFullName ?? "")}`);
              return (
                <NavLink
                  key={repo.id}
                  to={`/repositories/${encodeURIComponent(repo.id)}`}
                  className={`sidebar-repo-item ${active ? "active" : ""}`}
                  onClick={onNavigate}
                >
                  <span className={`repo-dot ${repo.monitoringEnabled ? "monitored" : ""}`} />
                  <FolderGit2 size={14} className="repo-icon" />
                  <div className="repo-text-group">
                    <strong>{repo.displayName}</strong>
                    <small>{repo.source === "local_git" ? (zh ? "本地 Git" : "local") : (zh ? "GitHub 远端" : "GitHub")} · {repo.defaultBranch ?? "main"}</small>
                  </div>
                </NavLink>
              );
            })}

            {/* History Review Repositories (Fixture) */}
            {historyRepoNames.map(name => {
              const active = currentPath.startsWith(`/repositories/${encodeURIComponent(name)}`);
              const isDemo = name.startsWith("acme/") || name.startsWith("studio/");
              return (
                <NavLink
                  key={name}
                  to={`/repositories/${encodeURIComponent(name)}`}
                  className={`sidebar-repo-item ${active ? "active" : ""}`}
                  onClick={onNavigate}
                >
                  <span className="repo-dot" />
                  <FolderGit2 size={14} className="repo-icon" />
                  <div className="repo-text-group">
                    <strong>{name}</strong>
                    <small>{isDemo ? (zh ? "演示数据 · FIXTURE" : "fixture") : (zh ? "GitHub · 公开" : "GitHub · public")}</small>
                  </div>
                </NavLink>
              );
            })}

            {repositories.length === 0 && !pulse && historyRepoNames.length === 0 && (
              <div className="explorer-empty">
                <FolderPlus size={14} />
                <span>{copy.noSources}</span>
              </div>
            )}
          </div>
        </section>

        {/* Recent Review Runs */}
        <section className="explorer-section">
          <div className="explorer-section-title">
            <span>{copy.reviews}</span>
            <NavLink to="/runs" onClick={onNavigate}>{zh ? "全部" : "All"}</NavLink>
          </div>

          <div className="sidebar-recent-runs" role="list">
            {recentRuns.length > 0 ? (
              recentRuns.map(job => {
                const isDemo = job.id.startsWith("job_demo");
                return (
                  <NavLink
                    key={job.id}
                    to={`/runs/${encodeURIComponent(job.id)}/overview`}
                    className={`sidebar-run-item ${currentPath.includes(job.id) ? "active" : ""}`}
                    onClick={onNavigate}
                  >
                    <span className={`ledger-state ${job.status}`} />
                    <div className="run-text-group">
                      <strong>{job.pullRequestNumber ? `PR #${job.pullRequestNumber}` : job.id.slice(0, 8)}</strong>
                      <small>{job.repositoryFullName}{isDemo ? ` · ${zh ? "演示数据" : "FIXTURE"}` : ""}</small>
                    </div>
                  </NavLink>
                );
              })
            ) : (
              <div className="explorer-empty">{copy.noActiveRuns}</div>
            )}
          </div>
        </section>
      </div>

      {/* Fixed Bottom Navigation (No implementation labels) */}
      <nav className="sidebar-bottom-nav" aria-label={copy.primaryNavigation}>
        <NavLink to="/runs" onClick={onNavigate} className={({ isActive }) => isActive ? "active" : ""}><ScanSearch size={14} /><span>{copy.runs}</span></NavLink>
        <NavLink to="/inbox" onClick={onNavigate} className={({ isActive }) => isActive ? "active" : ""}><Inbox size={14} /><span>{copy.inbox}</span></NavLink>
        <NavLink to="/findings" onClick={onNavigate} className={({ isActive }) => isActive ? "active" : ""}><FileSearch2 size={14} /><span>{copy.findings}</span></NavLink>
        <NavLink to="/automations" onClick={onNavigate} className={({ isActive }) => isActive ? "active" : ""}><CalendarClock size={14} /><span>{copy.automations}</span></NavLink>
        <NavLink to="/workflows" onClick={onNavigate} className={({ isActive }) => isActive ? "active" : ""}><Workflow size={14} /><span>{copy.workflows}</span></NavLink>
        <NavLink to="/settings" onClick={onNavigate} className={({ isActive }) => isActive ? "active" : ""}><Settings size={14} /><span>{copy.settings}</span></NavLink>
      </nav>
    </aside>
  );
}

function ContextInspectorDock({
  open,
  width,
  copy,
  context,
  activeTab,
  zh,
  onTab,
  onResize,
  onClose
}: {
  open: boolean;
  width: number;
  copy: Copy;
  context?: InspectorContext;
  activeTab: "evidence" | "agent" | "decision";
  zh: boolean;
  onTab: (tab: "evidence" | "agent" | "decision") => void;
  onResize: (value: number) => void;
  onClose: () => void;
}) {
  const scope = useId();
  const report = context?.report;
  const job = context?.job;
  const agent = context?.agent;

  const stages = useMemo(() => [
    job ? (job.accessMode === "public_read" ? copy.publicReadTrigger : job.accessMode === "local_git" ? copy.localTrigger : copy.githubTrigger) : undefined,
    job?.headSha,
    report ? `${report.findings.length} ${copy.findingsRecorded}` : undefined,
    report?.retrieval ? `${report.retrieval.packs.length} packs · ${report.retrieval.summary.total_selected_evidence} ${copy.evidenceItems}` : undefined,
    report?.summary,
    undefined
  ], [copy, job, report]);

  const tabs: Array<{ id: "evidence" | "agent" | "decision"; label: string; icon: typeof FileSearch2 }> = [
    { id: "evidence", label: copy.evidence, icon: FileSearch2 },
    { id: "agent", label: copy.agent, icon: Terminal },
    { id: "decision", label: copy.decision, icon: Activity }
  ];

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>, current: "evidence" | "agent" | "decision") {
    const next = nextTabId(tabs.map(t => t.id), current, event.key);
    if (!next) return;
    event.preventDefault();
    onTab(next);
    window.requestAnimationFrame(() => document.getElementById(`${scope}-inspector-tab-${next}`)?.focus());
  }

  return (
    <aside className={`inspector-dock ${open ? "open" : ""}`} aria-label={copy.inspector}>
      <ResizeHandle value={width} min={WORKBENCH_BOUNDS.inspector.min} max={WORKBENCH_BOUNDS.inspector.max} direction={-1} label={copy.resizeInspector} onChange={onResize} />
      <div className="inspector-head">
        <strong>{copy.inspector}</strong>
        <button type="button" onClick={onClose} aria-label="Close inspector">×</button>
      </div>

      {agent ? (
        <div className="inspector-scroll-body">
          <AgentInspectorContent agent={agent} zh={zh} />
        </div>
      ) : (
        <>
          <div className="inspector-tabs" role="tablist" aria-label={copy.inspector}>
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                id={`${scope}-inspector-tab-${id}`}
                key={id}
                type="button"
                role="tab"
                aria-selected={activeTab === id}
                aria-controls={`${scope}-inspector-panel`}
                tabIndex={activeTab === id ? 0 : -1}
                className={activeTab === id ? "active" : ""}
                onKeyDown={event => handleTabKey(event, id)}
                onClick={() => onTab(id)}
              >
                <Icon aria-hidden="true" size={14} />
                {label}
              </button>
            ))}
          </div>

          <div id={`${scope}-inspector-panel`} className="inspector-empty" role="tabpanel" aria-labelledby={`${scope}-inspector-tab-${activeTab}`} tabIndex={0}>
            <strong>{context?.runId ? `${copy.selectedRun} · ${context.runId}` : copy.inspectorEmpty}</strong>
            {!context?.runId && <p>{copy.inspectorHint}</p>}
            {activeTab === "evidence" ? (
              <ol className="evidence-spine" aria-label={copy.evidence}>
                {copy.evidenceStages.map((stage, index) => (
                  <li className={stages[index] ? "recorded" : "missing"} key={stage}>
                    <i aria-hidden="true" />
                    <span>
                      <strong>{stage}</strong>
                      <small>{stages[index] ?? copy.notRecorded}</small>
                    </span>
                  </li>
                ))}
              </ol>
            ) : activeTab === "agent" ? (
              <div className="inspector-agent-list">
                {report?.agentRuns.length ? (
                  report.agentRuns.map(run => (
                    <article key={run.id}>
                      <span className={`ledger-state ${run.status}`} />
                      <div>
                        <strong>{run.agentName}</strong>
                        <small>{run.provider ? `${run.provider}${run.model ? ` / ${run.model}` : ""}` : copy.notRecorded}</small>
                      </div>
                      <code>{run.status}</code>
                    </article>
                  ))
                ) : (
                  <p>{copy.noAgentRuns}</p>
                )}
              </div>
            ) : (
              <div className="inspector-decision">
                <strong>{report ? `${copy.legacyDecisionSignal} · ${report.score}/100` : copy.notRecorded}</strong>
                {report && <p>{report.summary}</p>}
                <small>{copy.humanDecisionPending}</small>
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function StatusBar({ health, healthUnavailable, pulse, selectedRepository, jobs, copy }: {
  health?: HealthResponse;
  healthUnavailable: boolean;
  pulse: HeartbeatPulse | null;
  selectedRepository?: Repository;
  jobs: ReviewJob[];
  copy: Copy;
}) {
  const activeJobs = jobs.filter(j => j.status === "running" || j.status === "queued");
  const apiLabel = healthUnavailable ? copy.unavailable : health ? copy.connected : copy.checking;

  return (
    <footer className="audit-status-bar">
      <span><i className={health?.ok ? "online" : "offline"} />{apiLabel}</span>
      <span><GitBranch size={11} />{copy.branch}: {pulse?.repository.branch ?? "—"}</span>
      <span><ShieldCheck size={11} />{copy.trust}: {selectedRepository?.trustLevel ?? "—"}</span>
      <span><Radio size={11} />{copy.engine}: {health?.deterministicAnalyzer?.running ? "active" : "idle"}</span>
      <span>{copy.worker}: {health ? `${health.worker.activeJobs}/${health.worker.concurrency}` : "—"}</span>
      <span>{copy.model}: {health?.llmModel ?? health?.llmProvider ?? "—"}</span>
      <Link to="/runs" className="status-runs-link">
        <Activity size={11} />
        {activeJobs.length > 0
          ? `${activeJobs.filter(j => j.status === "running").length} ${copy.activeRuns} · ${activeJobs.filter(j => j.status === "queued").length} ${copy.queued}`
          : copy.noActiveRuns}
      </Link>
      <span className="status-spacer" />
      <span><ShieldCheck size={11} />{copy.localFirst}</span>
    </footer>
  );
}

function CommandPalette({ copy, onClose, onNavigate }: {
  copy: Copy;
  onClose: () => void;
  onNavigate: (to: string) => void;
}) {
  const scope = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const commands = useMemo(() => [
    { to: "/repositories", label: copy.repositories, group: copy.workspace },
    { to: "/runs", label: copy.runs, group: copy.reviews },
    { to: "/inbox", label: copy.inbox, group: copy.reviews },
    { to: "/findings", label: copy.findings, group: copy.reviews },
    { to: "/automations", label: copy.automations, group: "Harness" },
    { to: "/workflows", label: copy.workflows, group: "Harness" },
    { to: "/settings", label: copy.settings, group: copy.workspace }
  ], [copy]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle.length === 0
      ? commands
      : commands.filter(command => `${command.label} ${command.group}`.toLocaleLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex(index => Math.min(index, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  function activate(index: number) {
    const command = filtered[index];
    if (command) onNavigate(command.to);
  }

  function handleDialogKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("input, button") ?? [])]
      .filter(element => !element.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey
      ? (current <= 0 ? focusable.length - 1 : current - 1)
      : (current >= focusable.length - 1 ? 0 : current + 1);
    event.preventDefault();
    focusable[next]?.focus();
  }

  return (
    <div className="command-palette-backdrop" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="command-palette" role="dialog" aria-modal="true" aria-labelledby={`${scope}-title`} onKeyDown={handleDialogKey}>
        <header>
          <div>
            <Search aria-hidden="true" size={16} />
            <strong id={`${scope}-title`}>{copy.commandPalette}</strong>
          </div>
          <button type="button" aria-label={copy.closeNavigation} onClick={onClose}><X aria-hidden="true" size={15} /></button>
        </header>
        <div className="command-palette-search">
          <Search aria-hidden="true" size={15} />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-controls={`${scope}-commands`}
            aria-expanded="true"
            aria-activedescendant={filtered[activeIndex] ? `${scope}-command-${activeIndex}` : undefined}
            aria-label={copy.commandPlaceholder}
            placeholder={copy.commandPlaceholder}
            value={query}
            onChange={event => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={event => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex(index => filtered.length === 0 ? 0 : (index + 1) % filtered.length);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex(index => filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(Math.max(filtered.length - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                activate(activeIndex);
              }
            }}
          />
          <kbd>Ctrl K</kbd>
        </div>
        <div id={`${scope}-commands`} className="command-palette-list" role="listbox" aria-label={copy.commandPalette}>
          {filtered.length === 0 ? <p role="status">{copy.noCommands}</p> : filtered.map((command, index) => (
            <button
              id={`${scope}-command-${index}`}
              key={command.to}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "active" : ""}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => activate(index)}
            >
              <span>
                <strong>{command.label}</strong>
                <small>{command.group}</small>
              </span>
              <code>{command.to}</code>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export function AppShell({
  children,
  path,
  meta,
  locale,
  setLocale,
  themePreference,
  themeLabel,
  cycleTheme,
  jobs,
  repositories = [],
  pulse,
  health,
  healthUnavailable,
  inspectorContext,
  notices,
  refreshing,
  onRefresh
}: {
  children: ReactNode;
  path: string;
  routeHref?: string;
  meta: RouteMeta;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  themePreference: ThemePreference;
  themeLabel: string;
  cycleTheme: () => void;
  jobs: ReviewJob[];
  repositories?: Repository[];
  pulse: HeartbeatPulse | null;
  health?: HealthResponse;
  healthUnavailable: boolean;
  inspectorContext?: InspectorContext;
  demoMode?: boolean;
  notices: DataNotice[];
  refreshing: boolean;
  canSeedDemo?: boolean;
  seedingDemo?: boolean;
  onRefresh: () => void;
  onSeedDemo?: () => void;
}) {
  const copy = copyByLocale[locale];
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const commandButtonRef = useRef<HTMLButtonElement>(null);
  const [inspectorTab, setInspectorTab] = useState<"evidence" | "agent" | "decision">("evidence");
  const [compactExplorer, setCompactExplorer] = useState(false);
  const { layout, setExplorerCollapsed, setExplorerWidth, setInspectorOpen, setInspectorWidth } = useWorkbenchLayout();
  const themeIcon = themePreference === "dark" ? <Moon size={15} /> : themePreference === "light" ? <Sun size={15} /> : <Monitor size={15} />;

  const selectedRepository = useMemo(() => {
    const match = path.match(/^\/repositories\/([^/]+)/);
    if (!match?.[1]) return undefined;
    try {
      const id = decodeURIComponent(match[1]);
      return repositories.find(repository => repository.id === id || repository.remoteFullName === id || repository.displayName === id);
    } catch {
      return undefined;
    }
  }, [path, repositories]);

  const explorerHidden = compactExplorer ? !explorerOpen : layout.explorerCollapsed;
  const shellStyle = {
    "--explorer-width": `${layout.explorerWidth}px`,
    "--inspector-width": `${layout.inspectorWidth}px`
  } as CSSProperties;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1100px)");
    const update = () => setCompactExplorer(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (!isCommandPaletteShortcut(event)) return;
      event.preventDefault();
      setCommandPaletteOpen(true);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  // Compute location breadcrumbs for the top bar
  const breadcrumb = useMemo(() => {
    const repoMatch = path.match(/^\/repositories\/([^/]+)(?:\/([^/]+))?/);
    if (repoMatch?.[1]) {
      const rawId = decodeURIComponent(repoMatch[1]);
      const sub = repoMatch[2];
      const repoObj = repositories.find(r => r.id === rawId || r.remoteFullName === rawId || r.displayName === rawId);
      const repoDisplayName = repoObj?.displayName ?? (rawId.startsWith("local:") ? rawId.replace(/^local:/, "") : rawId);
      const subLabel = sub === "changes" ? (zh ? "变更" : "Changes")
        : sub === "history" ? (zh ? "提交历史" : "Git History")
        : sub === "pull-requests" ? (zh ? "拉取请求" : "Pull Requests")
        : sub === "runs" ? (zh ? "审查" : "Reviews")
        : sub === "automations" ? (zh ? "自动化" : "Automations")
        : (zh ? "概览" : "Overview");

      return (
        <div className="location-breadcrumbs">
          <Link to="/repositories">{copy.repositories}</Link>
          <span className="breadcrumb-sep">/</span>
          <Link to={`/repositories/${encodeURIComponent(rawId)}`}><strong>{repoDisplayName}</strong></Link>
          {sub && (
            <>
              <span className="breadcrumb-sep">/</span>
              <span>{subLabel}</span>
            </>
          )}
        </div>
      );
    }

    const runMatch = path.match(/^\/runs\/([^/]+)(?:\/([^/]+))?/);
    if (runMatch?.[1]) {
      const runId = decodeURIComponent(runMatch[1]);
      const mode = runMatch[2] ?? "overview";
      const job = jobs.find(j => j.id === runId);
      const repoName = job?.repositoryFullName ?? (zh ? "审查" : "Review");
      const prText = job?.pullRequestNumber ? `PR #${job.pullRequestNumber}` : (zh ? "任务" : "Task");
      const modeLabel = mode === "diff" ? (zh ? "差异" : "Diff")
        : mode === "evidence" ? (zh ? "证据" : "Evidence")
        : mode === "notebook" ? (zh ? "笔记本" : "Notebook")
        : mode === "runtime" ? (zh ? "运行流程" : "Runtime")
        : (zh ? "概览" : "Overview");

      return (
        <div className="location-breadcrumbs">
          <Link to={job?.repositoryFullName ? `/repositories/${encodeURIComponent(job.repositoryFullName)}` : "/runs"}>
            {repoName}
          </Link>
          <span className="breadcrumb-sep">/</span>
          <Link to={`/runs/${encodeURIComponent(runId)}/overview`}><strong>{prText}</strong></Link>
          <span className="breadcrumb-sep">/</span>
          <span>{modeLabel}</span>
        </div>
      );
    }

    if (path === "/inbox") {
      return (
        <div className="location-breadcrumbs">
          <strong>{copy.inbox}</strong>
        </div>
      );
    }

    if (path === "/runs") {
      return (
        <div className="location-breadcrumbs">
          <strong>{copy.runs}</strong>
        </div>
      );
    }

    if (path === "/findings") {
      return (
        <div className="location-breadcrumbs">
          <strong>{copy.findings}</strong>
        </div>
      );
    }

    if (path === "/settings") {
      return (
        <div className="location-breadcrumbs">
          <strong>{copy.settings}</strong>
        </div>
      );
    }

    return (
      <div className="location-breadcrumbs">
        <span>{meta.section}</span>
        <span className="breadcrumb-sep">/</span>
        <strong>{meta.shortTitle}</strong>
      </div>
    );
  }, [copy.inbox, copy.findings, copy.repositories, copy.runs, copy.settings, jobs, meta.section, meta.shortTitle, path, repositories, zh]);

  function closeCommandPalette() {
    setCommandPaletteOpen(false);
    window.requestAnimationFrame(() => commandButtonRef.current?.focus());
  }

  return (
    <div className={`audit-shell${layout.explorerCollapsed ? " explorer-collapsed" : ""}`} style={shellStyle}>
      {/* 1. Single Repository-First Left Sidebar */}
      <RepositorySidebar
        open={explorerOpen}
        hidden={explorerHidden}
        jobs={jobs}
        repositories={repositories}
        pulse={pulse}
        copy={copy}
        currentPath={path}
        zh={zh}
        onNavigate={() => setExplorerOpen(false)}
        onClose={() => setExplorerOpen(false)}
      />
      {compactExplorer && explorerOpen && (
        <button type="button" className="explorer-backdrop" aria-label={copy.closeNavigation} onClick={() => setExplorerOpen(false)} />
      )}

      {/* 2. Main Stage with Location Header */}
      <section className="audit-stage">
        <header className="workbench-header">
          <button
            className="workbench-menu"
            type="button"
            aria-label={explorerHidden ? copy.openNavigation : copy.closeNavigation}
            aria-expanded={!explorerHidden}
            onClick={() => compactExplorer ? setExplorerOpen(value => !value) : setExplorerCollapsed(!layout.explorerCollapsed)}
          >
            <Menu size={18} />
          </button>

          <div className="workbench-heading">
            {breadcrumb}
          </div>

          <div className="workbench-actions">
            {health?.llmConfigured ? (
              <span className="shell-provider-status" title={zh ? "已配置的大语言模型" : "Configured LLM"}><Sparkles size={13} />{health.llmProvider}{health.llmModel ? ` · ${health.llmModel}` : ""}</span>
            ) : health && (
              <Link to="/settings" className="shell-provider-unconfigured" title={zh ? "前往设置配置 LLM" : "Configure LLM"}><ShieldAlert size={13} />{zh ? "LLM 未配置" : "LLM not configured"}</Link>
            )}
            <button
              ref={commandButtonRef}
              type="button"
              className="shell-command-button"
              aria-label={copy.commandPalette}
              aria-haspopup="dialog"
              aria-expanded={commandPaletteOpen}
              aria-keyshortcuts="Control+K Meta+K Control+P Meta+P"
              onClick={() => setCommandPaletteOpen(true)}
            >
              <Search aria-hidden="true" size={14} />
              <span>{copy.commandPalette}</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button
              type="button"
              className="shell-icon-button"
              aria-label={`${copy.theme}: ${themeLabel}`}
              title={`${copy.theme}: ${themeLabel}`}
              onClick={cycleTheme}
            >
              {themeIcon}
            </button>
            <label className="shell-language">
              <Globe2 size={13} />
              <span className="sr-only">{copy.language}</span>
              <select aria-label={copy.language} value={locale} onChange={event => setLocale(event.target.value as Locale)}>
                <option value="zh-CN">中文</option>
                <option value="en-US">English</option>
              </select>
            </label>
            <button
              type="button"
              className="shell-icon-button"
              aria-label={copy.refresh}
              title={copy.refresh}
              onClick={onRefresh}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? "spinning" : ""} size={15} />
            </button>
            <button
              type="button"
              className={layout.inspectorOpen ? "shell-icon-button active" : "shell-icon-button"}
              aria-label={copy.inspector}
              aria-expanded={layout.inspectorOpen}
              onClick={() => setInspectorOpen(!layout.inspectorOpen)}
            >
              <PanelRight size={16} />
            </button>
          </div>
        </header>

        {/* 3. Main Workspace + Single Adaptive Context Inspector */}
        <div className={`workbench-frame${layout.inspectorOpen ? " inspector-open" : ""}`}>
          <main className="audit-workbench">
            <div className="audit-route-scroll" role="region" aria-label={meta.title} tabIndex={0}>
              <div className="app-content audit-route-content">
                {notices.length > 0 && (
                  <div className="route-notice-stack">
                    {notices.map(notice => (
                      <div className="route-query-notice" role="status" key={notice.id}>
                        <span><strong>{notice.label}</strong><small>{notice.message}</small></span>
                        <button type="button" onClick={onRefresh}>{copy.retry}</button>
                      </div>
                    ))}
                  </div>
                )}
                {children}
              </div>
            </div>
          </main>
          <ContextInspectorDock
            open={layout.inspectorOpen}
            width={layout.inspectorWidth}
            onResize={setInspectorWidth}
            copy={copy}
            context={inspectorContext}
            activeTab={inspectorTab}
            zh={zh}
            onTab={setInspectorTab}
            onClose={() => setInspectorOpen(false)}
          />
        </div>
      </section>

      {/* 4. Minimal Status Bar */}
      <StatusBar health={health} healthUnavailable={healthUnavailable} pulse={pulse} selectedRepository={selectedRepository} jobs={jobs} copy={copy} />
      {commandPaletteOpen && <CommandPalette copy={copy} onClose={closeCommandPalette} onNavigate={to => { navigate(to); closeCommandPalette(); }} />}
    </div>
  );
}
