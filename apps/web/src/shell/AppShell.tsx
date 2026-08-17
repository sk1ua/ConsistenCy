import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import type { HeartbeatPulse, Repository, ReviewJob, ReviewReport } from "@consistency/schema";
import {
  Activity,
  Bot,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  FileSearch2,
  FlaskConical,
  FolderGit2,
  GitBranch,
  Globe2,
  Inbox,
  Menu,
  Monitor,
  Moon,
  PanelRight,
  Radio,
  RefreshCw,
  ScanSearch,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Workflow,
  X
} from "lucide-react";
import type { HealthResponse } from "../api/client";
import type { Locale } from "../i18n";
import type { ThemePreference } from "../theme";
import type { RouteMeta } from "../routes/meta";
import { nextTabId } from "../utils/tabNavigation";
import { useWorkbenchLayout, WORKBENCH_BOUNDS } from "./useWorkbenchLayout";

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
    openRepositoryView: "Open repository view",
    inspector: "Context inspector",
    evidence: "Evidence",
    agent: "Agent",
    decision: "Decision",
    inspectorEmpty: "Nothing selected",
    inspectorHint: "Select a finding, run, or evidence marker in the workbench.",
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
    demoMode: "Demo mode",
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
    inspectorHint: "在工作台中选择发现、运行或证据标记。",
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
    demoMode: "演示模式",
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
  runId: string;
  job?: ReviewJob;
  report?: ReviewReport;
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

function activityActive(path: string, target: string): boolean {
  if (target === "/inbox") return path === "/" || path.startsWith("/inbox");
  if (target === "/runs") return path.startsWith("/runs") || path.startsWith("/jobs") || path.startsWith("/reports");
  return path.startsWith(target);
}

function ActivityRail({ path, copy, onNavigate }: { path: string; copy: Copy; onNavigate: () => void }) {
  const items = [
    { to: "/inbox", label: copy.inbox, icon: Inbox },
    { to: "/repositories", label: copy.repositories, icon: FolderGit2 },
    { to: "/runs", label: copy.runs, icon: ScanSearch },
    { to: "/findings", label: copy.findings, icon: FileSearch2 },
    { to: "/automations", label: copy.automations, icon: CalendarClock },
    { to: "/workflows", label: copy.workflows, icon: Workflow }
  ];
  return <aside className="activity-rail">
    <NavLink className="activity-brand" to="/inbox" aria-label="ConsistenCy"><img src="/consistency-logo.png" alt="" /></NavLink>
    <nav aria-label={copy.primaryNavigation}>{items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} title={label} aria-label={label} aria-current={activityActive(path, to) ? "page" : undefined} className={activityActive(path, to) ? "active" : ""} onClick={onNavigate}><Icon aria-hidden="true" size={19} /></NavLink>)}</nav>
    <NavLink className={activityActive(path, "/settings") ? "activity-settings active" : "activity-settings"} to="/settings" title={copy.settings} aria-label={copy.settings} aria-current={activityActive(path, "/settings") ? "page" : undefined} onClick={onNavigate}><Settings aria-hidden="true" size={19} /></NavLink>
  </aside>;
}

function ResizeHandle({ value, min, max, direction, label, onChange }: {
  value: number;
  min: number;
  max: number;
  direction: 1 | -1;
  label: string;
  onChange: (value: number) => void;
}) {
  return <div
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
  />;
}

function ContextExplorer({ open, hidden, jobs, repositories, pulse, copy, explorerWidth, onResize, onNavigate, onClose }: {
  open: boolean;
  hidden: boolean;
  jobs: ReviewJob[];
  repositories: Repository[];
  pulse: HeartbeatPulse | null;
  copy: Copy;
  explorerWidth: number;
  onResize: (value: number) => void;
  onNavigate: () => void;
  onClose: () => void;
}) {
  const monitored = useMemo(() => repositories.filter(repository => repository.monitoringEnabled).slice(0, 4), [repositories]);
  const registeredRemoteNames = useMemo(() => new Set(repositories.map(repository => repository.remoteFullName).filter(Boolean)), [repositories]);
  const repositoryNames = useMemo(() => [...new Set(jobs.map(job => job.repositoryFullName).filter(name => !registeredRemoteNames.has(name)))].slice(0, 4), [jobs, registeredRemoteNames]);
  return <aside className={`context-explorer${open ? " open" : ""}`} aria-label={copy.workspace} aria-hidden={hidden || undefined} inert={hidden || undefined}>
    <div className="context-explorer-head"><div><strong>ConsistenCy</strong><span>{copy.localHarness}</span></div><button type="button" onClick={onClose} aria-label={copy.closeNavigation}>×</button></div>
    <div className="context-explorer-scroll">
      <section className="explorer-section">
        <div className="explorer-section-title"><span>{copy.monitoredRepositories}</span><NavLink to="/repositories" onClick={onNavigate}>{copy.openRepositoryView}</NavLink></div>
        {monitored.length > 0 ? monitored.map(repository => <NavLink className="explorer-repository live" key={repository.id} to={`/repositories/${encodeURIComponent(repository.id)}`} onClick={onNavigate}><span><i /><FolderGit2 size={15} /></span><strong>{repository.displayName}</strong><small>{repository.trustLevel === "trusted_local" ? "trusted local" : "static read-only"}</small></NavLink>)
          : pulse ? <NavLink className="explorer-repository live" to={`/repositories/${encodeURIComponent(`local:${repositoryName(pulse)}`)}`} onClick={onNavigate}><span><i /><FolderGit2 size={15} /></span><strong>{repositoryName(pulse)}</strong><small>{pulse.repository.branch ?? pulse.state}</small></NavLink>
          : <div className="explorer-empty"><Radio size={14} />{copy.noMonitor}</div>}
      </section>
      <section className="explorer-section">
        <div className="explorer-section-title"><span>{copy.reviewSources}</span><small>{repositoryNames.length}</small></div>
        {repositoryNames.length > 0 ? repositoryNames.map(name => <NavLink className="explorer-repository" key={name} to={`/repositories/${encodeURIComponent(name)}`} onClick={onNavigate}><FolderGit2 size={14} /><strong>{name}</strong></NavLink>) : <div className="explorer-empty"><FolderGit2 size={14} />{copy.noSources}</div>}
      </section>
      <section className="explorer-section explorer-navigation">
        <span className="explorer-section-label">{copy.reviews}</span>
        <NavLink to="/inbox" onClick={onNavigate}><Inbox size={15} />{copy.inbox}</NavLink>
        <NavLink to="/runs" onClick={onNavigate}><ScanSearch size={15} />{copy.runs}</NavLink>
        <NavLink to="/findings" onClick={onNavigate}><FileSearch2 size={15} />{copy.findings}</NavLink>
        <span className="explorer-section-label">Harness</span>
        <NavLink to="/automations" onClick={onNavigate}><CalendarClock size={15} />{copy.automations}</NavLink>
        <NavLink to="/workflows" onClick={onNavigate}><Workflow size={15} />{copy.workflows}</NavLink>
      </section>
    </div>
    <ResizeHandle value={explorerWidth} min={WORKBENCH_BOUNDS.explorer.min} max={WORKBENCH_BOUNDS.explorer.max} direction={1} label={copy.resizeExplorer} onChange={onResize} />
  </aside>;
}

function InspectorDock({ open, width, copy, context, activeTab, onResize, onTab, onClose }: {
  open: boolean;
  width: number;
  copy: Copy;
  context?: InspectorContext;
  activeTab: "evidence" | "agent" | "decision";
  onResize: (value: number) => void;
  onTab: (tab: "evidence" | "agent" | "decision") => void;
  onClose: () => void;
}) {
  const scope = useId();
  if (!open) return null;
  const tabs = [
    { id: "evidence" as const, label: copy.evidence, icon: ShieldCheck },
    { id: "agent" as const, label: copy.agent, icon: Bot },
    { id: "decision" as const, label: copy.decision, icon: Activity }
  ];
  const report = context?.job && context.report?.jobId === context.job.id ? context.report : undefined;
  const deterministic = report?.agentRuns.find(run => run.agentName === "DeterministicAnalyzer");
  const synthesizer = report?.agentRuns.find(run => run.agentName === "Synthesizer");
  const selectedEvidence = report?.retrieval?.packs.reduce(
    (count, pack) => count + pack.selected_evidence.length,
    0
  );
  const trigger = context?.job
    ? context.job.accessMode === "public_read" ? copy.publicReadTrigger
      : context.job.accessMode === "local_git" ? copy.localTrigger : copy.githubTrigger
    : undefined;
  const stages = [
    trigger,
    context?.job?.headSha,
    deterministic ? `${deterministic.status} · ${deterministic.findings.length} ${copy.findingsRecorded}` : undefined,
    selectedEvidence !== undefined ? `${report?.retrieval?.packs.length ?? 0} packs · ${selectedEvidence} ${copy.evidenceItems}` : undefined,
    synthesizer ? `${synthesizer.status}${synthesizer.provider ? ` · ${synthesizer.provider}${synthesizer.model ? ` / ${synthesizer.model}` : ""}` : ""}` : undefined,
    undefined
  ];

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>, current: "evidence" | "agent" | "decision") {
    const next = nextTabId(tabs.map(tab => tab.id), current, event.key);
    if (!next) return;
    event.preventDefault();
    onTab(next);
    window.requestAnimationFrame(() => document.getElementById(`${scope}-inspector-tab-${next}`)?.focus());
  }

  return <aside className="inspector-dock" aria-label={copy.inspector}>
    <ResizeHandle value={width} min={WORKBENCH_BOUNDS.inspector.min} max={WORKBENCH_BOUNDS.inspector.max} direction={-1} label={copy.resizeInspector} onChange={onResize} />
    <div className="inspector-head"><strong>{copy.inspector}</strong><button type="button" onClick={onClose} aria-label="Close inspector">×</button></div>
    <div className="inspector-tabs" role="tablist" aria-label={copy.inspector}>{tabs.map(({ id, label, icon: Icon }) => <button id={`${scope}-inspector-tab-${id}`} key={id} type="button" role="tab" aria-selected={activeTab === id} aria-controls={`${scope}-inspector-panel`} tabIndex={activeTab === id ? 0 : -1} className={activeTab === id ? "active" : ""} onKeyDown={event => handleTabKey(event, id)} onClick={() => onTab(id)}><Icon aria-hidden="true" size={14} />{label}</button>)}</div>
    <div id={`${scope}-inspector-panel`} className="inspector-empty" role="tabpanel" aria-labelledby={`${scope}-inspector-tab-${activeTab}`} tabIndex={0}>
      <strong>{context ? `${copy.selectedRun} · ${context.runId}` : copy.inspectorEmpty}</strong>
      {!context && <p>{copy.inspectorHint}</p>}
      {activeTab === "evidence" ? <ol className="evidence-spine" aria-label={copy.evidence}>{copy.evidenceStages.map((stage, index) => <li className={stages[index] ? "recorded" : "missing"} key={stage}><i aria-hidden="true" /><span><strong>{stage}</strong><small>{stages[index] ?? copy.notRecorded}</small></span></li>)}</ol>
        : activeTab === "agent" ? <div className="inspector-agent-list">{report?.agentRuns.length ? report.agentRuns.map(run => <article key={run.id}><span className={`ledger-state ${run.status}`} /><div><strong>{run.agentName}</strong><small>{run.provider ? `${run.provider}${run.model ? ` / ${run.model}` : ""}` : copy.notRecorded}</small></div><code>{run.status}</code></article>) : <p>{copy.noAgentRuns}</p>}</div>
          : <div className="inspector-decision"><strong>{report ? `${copy.legacyDecisionSignal} · ${report.score}/100` : copy.notRecorded}</strong>{report && <p>{report.summary}</p>}<small>{copy.humanDecisionPending}</small></div>}
    </div>
  </aside>;
}

function RunLedger({ open, jobs, copy, onToggle }: { open: boolean; jobs: ReviewJob[]; copy: Copy; onToggle: () => void }) {
  const active = jobs.filter(job => job.status === "running" || job.status === "queued");
  return <section className={`run-ledger${open ? " open" : ""}`}>
    <button className="run-ledger-toggle" type="button" aria-expanded={open} aria-controls="run-ledger-content" onClick={onToggle}><span><Activity size={14} /><strong>{copy.runLedger}</strong><small>{active.length > 0 ? `${active.filter(job => job.status === "running").length} ${copy.activeRuns} · ${active.filter(job => job.status === "queued").length} ${copy.queued}` : copy.noActiveRuns}</small></span>{open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button>
    {open && <div id="run-ledger-content" className="run-ledger-content">{active.length === 0 ? <div className="ledger-empty"><Radio size={15} />{copy.noActiveRuns}</div> : active.slice(0, 5).map(job => <NavLink key={job.id} to={`/runs/${encodeURIComponent(job.id)}/overview`}><span className={`ledger-state ${job.status}`} /><strong>{job.repositoryFullName}</strong><small>{job.pullRequestNumber ? `PR #${job.pullRequestNumber}` : job.id}</small><code>{job.status}</code></NavLink>)}</div>}
  </section>;
}

function StatusBar({ health, healthUnavailable, pulse, selectedRepository, copy }: { health?: HealthResponse; healthUnavailable: boolean; pulse: HeartbeatPulse | null; selectedRepository?: Repository; copy: Copy }) {
  const apiLabel = healthUnavailable ? copy.unavailable : health ? copy.connected : copy.checking;
  return <footer className="audit-status-bar">
    <span><i className={health?.ok ? "online" : "offline"} />{apiLabel}</span>
    <span><GitBranch size={11} />{copy.branch}: {pulse?.repository.branch ?? "—"}</span>
    <span><ShieldCheck size={11} />{copy.trust}: {selectedRepository?.trustLevel ?? "—"}</span>
    <span><Radio size={11} />{copy.engine}: {health?.deterministicAnalyzer?.running ? "active" : "idle"}</span>
    <span>{copy.worker}: {health ? `${health.worker.activeJobs}/${health.worker.concurrency}` : "—"}</span>
    <span>{copy.model}: {health?.llmModel ?? health?.llmProvider ?? "—"}</span>
    <span>{copy.lastScan}: {pulse?.observedAt ? new Date(pulse.observedAt).toLocaleTimeString() : copy.noScan}</span>
    <span className="status-spacer" />
    <span><ShieldCheck size={11} />{copy.localFirst}</span>
  </footer>;
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
    { to: "/inbox", label: copy.inbox, group: copy.reviews },
    { to: "/repositories", label: copy.repositories, group: copy.workspace },
    { to: "/runs", label: copy.runs, group: copy.reviews },
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

  return <div className="command-palette-backdrop" onPointerDown={event => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="command-palette" role="dialog" aria-modal="true" aria-labelledby={`${scope}-title`} onKeyDown={handleDialogKey}>
      <header><div><Search aria-hidden="true" size={16} /><strong id={`${scope}-title`}>{copy.commandPalette}</strong></div><button type="button" aria-label={copy.closeNavigation} onClick={onClose}><X aria-hidden="true" size={15} /></button></header>
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
        {filtered.length === 0 ? <p role="status">{copy.noCommands}</p> : filtered.map((command, index) => <button
          id={`${scope}-command-${index}`}
          key={command.to}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={index === activeIndex ? "active" : ""}
          onPointerMove={() => setActiveIndex(index)}
          onClick={() => activate(index)}
        ><span><strong>{command.label}</strong><small>{command.group}</small></span><code>{command.to}</code></button>)}
      </div>
    </section>
  </div>;
}

export function AppShell({ children, path, routeHref, meta, locale, setLocale, themePreference, themeLabel, cycleTheme, jobs, repositories = [], pulse, health, healthUnavailable, inspectorContext, demoMode, notices, refreshing, canSeedDemo, seedingDemo, onRefresh, onSeedDemo }: {
  children: ReactNode;
  path: string;
  routeHref: string;
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
  demoMode: boolean;
  notices: DataNotice[];
  refreshing: boolean;
  canSeedDemo: boolean;
  seedingDemo: boolean;
  onRefresh: () => void;
  onSeedDemo: () => void;
}) {
  const copy = copyByLocale[locale];
  const navigate = useNavigate();
  const workbenchTabScope = useId();
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const commandButtonRef = useRef<HTMLButtonElement>(null);
  const [inspectorTab, setInspectorTab] = useState<"evidence" | "agent" | "decision">("evidence");
  const [compactExplorer, setCompactExplorer] = useState(false);
  const { layout, setExplorerCollapsed, setExplorerWidth, setInspectorOpen, setInspectorWidth, setLedgerOpen } = useWorkbenchLayout();
  const themeIcon = themePreference === "dark" ? <Moon size={15} /> : themePreference === "light" ? <Sun size={15} /> : <Monitor size={15} />;
  const inboxActive = path === "/" || path.startsWith("/inbox");
  const routeWorkbenchTab = inboxActive ? undefined : { label: meta.shortTitle, to: routeHref };
  const [lastWorkbenchTab, setLastWorkbenchTab] = useState(routeWorkbenchTab);
  const currentWorkbenchTab = routeWorkbenchTab ?? lastWorkbenchTab;
  const workbenchTabs = currentWorkbenchTab ? [
    { id: "inbox" as const, label: copy.inbox, to: "/inbox" },
    { id: "current" as const, label: currentWorkbenchTab.label, to: currentWorkbenchTab.to }
  ] : [{ id: "inbox" as const, label: copy.inbox, to: "/inbox" }];
  const activeWorkbenchTab: WorkbenchTabId = inboxActive ? "inbox" : "current";
  const workbenchPanelId = `${workbenchTabScope}-workbench-panel`;
  const selectedRepository = useMemo(() => {
    const match = path.match(/^\/repositories\/([^/]+)/);
    if (!match?.[1]) return undefined;
    try {
      const id = decodeURIComponent(match[1]);
      return repositories.find(repository => repository.id === id);
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

  useEffect(() => {
    if (inboxActive) return;
    setLastWorkbenchTab(current => current?.label === meta.shortTitle && current.to === routeHref
      ? current
      : { label: meta.shortTitle, to: routeHref });
  }, [inboxActive, meta.shortTitle, routeHref]);

  function handleWorkbenchTabKey(event: KeyboardEvent<HTMLAnchorElement>, current: WorkbenchTabId) {
    const next = nextWorkbenchTabId(workbenchTabs.map(tab => tab.id), current, event.key);
    if (!next) return;
    event.preventDefault();
    const target = workbenchTabs.find(tab => tab.id === next);
    if (!target) return;
    navigate(target.to);
    window.requestAnimationFrame(() => document.getElementById(`${workbenchTabScope}-workbench-tab-${next}`)?.focus());
  }

  function closeCommandPalette() {
    setCommandPaletteOpen(false);
    window.requestAnimationFrame(() => commandButtonRef.current?.focus());
  }

  return <div className={`audit-shell${layout.explorerCollapsed ? " explorer-collapsed" : ""}`} style={shellStyle}>
    <ActivityRail path={path} copy={copy} onNavigate={() => setExplorerOpen(false)} />
    <ContextExplorer open={explorerOpen} hidden={explorerHidden} explorerWidth={layout.explorerWidth} onResize={setExplorerWidth} jobs={jobs} repositories={repositories} pulse={pulse} copy={copy} onNavigate={() => setExplorerOpen(false)} onClose={() => setExplorerOpen(false)} />
    {compactExplorer && explorerOpen && <button type="button" className="explorer-backdrop" aria-label={copy.closeNavigation} onClick={() => setExplorerOpen(false)} />}
    <section className="audit-stage">
      <header className="workbench-header">
        <button className="workbench-menu" type="button" aria-label={explorerHidden ? copy.openNavigation : copy.closeNavigation} aria-expanded={!explorerHidden} onClick={() => compactExplorer ? setExplorerOpen(value => !value) : setExplorerCollapsed(!layout.explorerCollapsed)}><Menu size={18} /></button>
        <div className="workbench-heading"><span>{meta.section} / {meta.shortTitle}</span><h1>{meta.title}</h1><p>{meta.description}</p></div>
        <div className="workbench-actions">
          {demoMode && <span className="shell-demo"><FlaskConical size={13} />{copy.demoMode}</span>}
          {canSeedDemo && <button type="button" className="shell-seed" disabled={seedingDemo} onClick={onSeedDemo}><FlaskConical size={14} />{copy.loadDemo}</button>}
          <button ref={commandButtonRef} type="button" className="shell-command-button" aria-label={copy.commandPalette} aria-haspopup="dialog" aria-expanded={commandPaletteOpen} aria-keyshortcuts="Control+K Meta+K Control+P Meta+P" onClick={() => setCommandPaletteOpen(true)}><Search aria-hidden="true" size={14} /><span>{copy.commandPalette}</span><kbd>Ctrl K</kbd></button>
          <button type="button" className="shell-icon-button" aria-label={`${copy.theme}: ${themeLabel}`} title={`${copy.theme}: ${themeLabel}`} onClick={cycleTheme}>{themeIcon}</button>
          <label className="shell-language"><Globe2 size={13} /><span className="sr-only">{copy.language}</span><select aria-label={copy.language} value={locale} onChange={event => setLocale(event.target.value as Locale)}><option value="zh-CN">中文</option><option value="en-US">English</option></select></label>
          <button type="button" className="shell-icon-button" aria-label={copy.refresh} title={copy.refresh} onClick={onRefresh} disabled={refreshing}><RefreshCw className={refreshing ? "spinning" : ""} size={15} /></button>
          <button type="button" className={layout.inspectorOpen ? "shell-icon-button active" : "shell-icon-button"} aria-label={copy.inspector} aria-expanded={layout.inspectorOpen} onClick={() => setInspectorOpen(!layout.inspectorOpen)}><PanelRight size={16} /></button>
        </div>
      </header>
      <div className="workbench-tabs" role="tablist" aria-label={copy.workbenchTabs} aria-orientation="horizontal">
        {workbenchTabs.map(tab => {
          const selected = tab.id === activeWorkbenchTab;
          return <Link
            id={`${workbenchTabScope}-workbench-tab-${tab.id}`}
            key={tab.id}
            role="tab"
            aria-selected={selected}
            aria-controls={workbenchPanelId}
            tabIndex={selected ? 0 : -1}
            className={`${selected ? "active " : ""}${tab.id === "inbox" ? "pinned" : ""}`.trim()}
            to={tab.to}
            onKeyDown={event => handleWorkbenchTabKey(event, tab.id)}
          >{tab.id === "inbox" ? <Inbox size={13} /> : <span className="tab-state" />}{tab.label}</Link>;
        })}
      </div>
      <div className={`workbench-frame${layout.inspectorOpen ? " inspector-open" : ""}`}>
        <main className="audit-workbench">
          <div id={workbenchPanelId} className="audit-route-scroll" role="tabpanel" aria-labelledby={`${workbenchTabScope}-workbench-tab-${activeWorkbenchTab}`} tabIndex={0}>
            <div className="app-content audit-route-content">
              {notices.length > 0 && <div className="route-notice-stack">{notices.map(notice => <div className="route-query-notice" role="status" key={notice.id}><span><strong>{notice.label}</strong><small>{notice.message}</small></span><button type="button" onClick={onRefresh}>{copy.retry}</button></div>)}</div>}
              {children}
            </div>
          </div>
        </main>
        <InspectorDock open={layout.inspectorOpen} width={layout.inspectorWidth} onResize={setInspectorWidth} copy={copy} context={inspectorContext} activeTab={inspectorTab} onTab={setInspectorTab} onClose={() => setInspectorOpen(false)} />
      </div>
      <RunLedger open={layout.ledgerOpen} jobs={jobs} copy={copy} onToggle={() => setLedgerOpen(!layout.ledgerOpen)} />
    </section>
    <StatusBar health={health} healthUnavailable={healthUnavailable} pulse={pulse} selectedRepository={selectedRepository} copy={copy} />
    {commandPaletteOpen && <CommandPalette copy={copy} onClose={closeCommandPalette} onNavigate={to => { navigate(to); closeCommandPalette(); }} />}
  </div>;
}
