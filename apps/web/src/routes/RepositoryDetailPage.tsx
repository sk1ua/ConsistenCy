import { useQuery } from "@tanstack/react-query";
import type { Automation, HeartbeatPulse, Repository, ReviewJob } from "@consistency/schema";
import { Activity, ArrowLeft, CalendarClock, FileSearch2, FolderGit2, GitBranch, History, Radio, ShieldCheck, TrendingUp } from "lucide-react";
import { Link, NavLink, useLocation, useParams } from "react-router-dom";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { workspaceQueryKeys } from "../query/client";
import { safeRequestError } from "../query/safeRequestError";

function localRepositoryName(pulse: HeartbeatPulse): string {
  if (pulse.repository.root === "unknown") return "Local repository";
  return pulse.repository.root.split(/[\\/]/).filter(Boolean).at(-1) ?? "Local repository";
}

type RepositoryView = "overview" | "evolution" | "findings" | "automations" | "audit-log";

export function RepositoryDetailPage({ jobs, repositories = [], automations = [], pulse }: { jobs: ReviewJob[]; repositories?: Repository[]; automations?: Automation[]; pulse: HeartbeatPulse | null }) {
  const { repositoryId = "" } = useParams();
  const location = useLocation();
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const localId = pulse ? `local:${localRepositoryName(pulse)}` : "";
  const isLocalMonitor = Boolean(pulse && repositoryId === localId);
  const registered = repositories.find(repository => repository.id === repositoryId);
  const sourceJobs = jobs.filter(job => job.repositoryFullName === (registered?.remoteFullName ?? repositoryId));
  const verifiedHistorySource = sourceJobs.length > 0;
  const title = registered?.displayName ?? (isLocalMonitor ? localRepositoryName(pulse!) : repositoryId);
  const tail = location.pathname.split("/").filter(Boolean).at(-1);
  const view: RepositoryView = tail === "evolution" || tail === "findings" || tail === "automations" || tail === "audit-log" ? tail : "overview";
  const timelineQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryTimeline(repositoryId),
    queryFn: ({ signal }) => api.repositoryTimeline(repositoryId, signal),
    enabled: Boolean(registered)
  });
  const metricsQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryMetrics(repositoryId),
    queryFn: ({ signal }) => api.repositoryMetrics(repositoryId, signal),
    enabled: Boolean(registered) && view === "evolution"
  });
  const issuesQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryIssues(repositoryId),
    queryFn: ({ signal }) => api.repositoryIssues(repositoryId, signal),
    enabled: Boolean(registered) && view === "findings"
  });
  const repositoryAutomations = automations.filter(automation => automation.repositoryId === repositoryId);
  const tabs: Array<{ id: RepositoryView; label: string }> = [
    { id: "overview", label: zh ? "概览" : "Overview" },
    { id: "evolution", label: zh ? "演变" : "Evolution" },
    { id: "findings", label: zh ? "发现" : "Findings" },
    { id: "automations", label: zh ? "自动化" : "Automations" },
    { id: "audit-log", label: zh ? "审计日志" : "Audit log" }
  ];
  const queryError = timelineQuery.error ?? metricsQuery.error ?? issuesQuery.error;
  const latestRegisteredPulse = timelineQuery.data?.repositoryPulses[0];
  const snapshots = metricsQuery.data ?? [];
  const latestSnapshot = snapshots[0];
  const issues = issuesQuery.data ?? [];
  const auditEntries = [
    ...(timelineQuery.data?.repositoryEvents.map(event => ({ id: `event:${event.id}`, at: event.occurredAt, kind: event.type, detail: `${event.source} · ${event.headRevision?.slice(0, 10) ?? (zh ? "未记录 revision" : "revision not recorded")}` })) ?? []),
    ...(timelineQuery.data?.repositoryPulses.map(repositoryPulse => ({ id: `pulse:${repositoryPulse.pulseId}`, at: repositoryPulse.observedAt, kind: "pulse", detail: `${repositoryPulse.state} · ${repositoryPulse.dirtyFileCount} ${zh ? "个脏文件" : "dirty files"}` })) ?? []),
    ...(timelineQuery.data?.auditRuns.map(run => ({ id: `run:${run.id}`, at: run.createdAt, kind: "audit run", detail: `${run.status} · ${run.executionProfile}` })) ?? [])
  ].sort((left, right) => right.at.localeCompare(left.at));

  return <div className="repository-detail-route page-stack">
    <Link className="repository-detail-back" to="/repositories"><ArrowLeft size={14} />{zh ? "全部仓库来源" : "All repository sources"}</Link>
    <section className="repository-detail-intro section-block">
      <div className="repository-detail-icon"><FolderGit2 size={24} /></div>
      <div><span className="panel-kicker">{registered ? `${registered.source} · ${registered.monitoringEnabled ? (zh ? "监控中" : "monitored") : (zh ? "已暂停" : "paused")}` : isLocalMonitor ? (zh ? "实时本地监控" : "Live local monitor") : verifiedHistorySource ? (zh ? "审查历史来源" : "Review-history source") : (zh ? "请求的仓库深链 · 未核实" : "Requested repository deep link · unverified")}</span><h2>{title || (zh ? "未知仓库" : "Unknown repository")}</h2><p>{registered ? (zh ? "这里只显示服务端注册表中的安全元数据；本地绝对路径不会发送到渲染器。" : "Only renderer-safe registry metadata is shown here; local absolute paths are never sent to the renderer.") : (zh ? "此深链只展示当前运行时可核实的信息，不生成占位数据。" : "This deep link only shows information verifiable by the current runtime and creates no placeholders.")}</p></div>
    </section>
    {registered && <nav className="repository-workspace-nav" aria-label={zh ? "仓库工作区" : "Repository workspace"}>{tabs.map(tab => <NavLink key={tab.id} aria-current={view === tab.id ? "page" : undefined} className={view === tab.id ? "active" : ""} to={`/repositories/${encodeURIComponent(repositoryId)}/${tab.id}`}>{tab.label}</NavLink>)}</nav>}
    {queryError && <div className="route-query-notice" role="alert"><strong>{zh ? "部分仓库数据暂不可用" : "Some repository data is unavailable"}</strong><span>{safeRequestError(queryError)}</span></div>}
    {view === "overview" && (isLocalMonitor && pulse || latestRegisteredPulse) ? <section className="section-block repository-detail-monitor"><div className="panel-title"><div><span className="panel-kicker"><Radio size={14} />Heartbeat</span><h2>{zh ? "已验证的当前状态" : "Verified current state"}</h2></div></div><div className="repository-monitor-metrics"><span><GitBranch size={14} />{latestRegisteredPulse?.branch ?? pulse?.repository.branch ?? "detached"}</span><span>{latestRegisteredPulse?.dirtyFileCount ?? pulse?.dirtyFileCount ?? 0} {zh ? "个脏文件" : "dirty files"}</span><span><code>{latestRegisteredPulse?.headRevision?.slice(0, 10) ?? pulse?.repository.headSha?.slice(0, 10) ?? "working tree"}</code></span><span>{new Date(latestRegisteredPulse?.observedAt ?? pulse?.observedAt ?? Date.now()).toLocaleString(locale)}</span></div></section> : null}
    {view === "overview" && <section className="section-block repository-detail-runs">
      <div className="panel-title"><div><span className="panel-kicker"><History size={14} />{zh ? "运行记录" : "Run history"}</span><h2>{zh ? "关联审查" : "Related review runs"}</h2></div></div>
      {sourceJobs.length === 0 && (timelineQuery.data?.auditRuns.length ?? 0) === 0 ? <div className="repository-honest-empty"><History size={20} /><div><strong>{zh ? "没有可核实的关联运行" : "No verifiable related runs"}</strong><p>{zh ? "此深链不会生成占位运行。" : "This deep link does not create placeholder runs."}</p></div></div> : <div className="repository-detail-run-list">
        {timelineQuery.data?.auditRuns.map(run => <div className="repository-audit-run" key={run.id}><span className={`ledger-state ${run.status}`} /><strong>{run.id}</strong><small>{new Date(run.createdAt).toLocaleString(locale)}</small><code>{run.status}</code></div>)}
        {sourceJobs.map(job => <Link key={job.id} to={`/runs/${encodeURIComponent(job.id)}/overview`}><span className={`ledger-state ${job.status}`} /><strong>{job.pullRequestNumber ? `PR #${job.pullRequestNumber}` : job.id}</strong><small>{new Date(job.createdAt).toLocaleString(locale)}</small><code>{job.status}</code></Link>)}
      </div>}
    </section>}

    {view === "evolution" && <section className="section-block repository-evolution">
      <div className="panel-title"><div><span className="panel-kicker"><TrendingUp size={14} />{zh ? "提交级事实" : "Commit-level facts"}</span><h2>{zh ? "代码演变" : "Code evolution"}</h2></div><strong>{snapshots.length}</strong></div>
      {metricsQuery.isPending ? <div className="loading-state">{zh ? "正在加载演变快照" : "Loading evolution snapshots"}</div> : !latestSnapshot ? <div className="repository-honest-empty"><TrendingUp size={20} /><div><strong>{zh ? "尚未记录演变快照" : "No evolution snapshots recorded"}</strong><p>{zh ? "不会用估算趋势填充此视图。" : "This view is never filled with estimated trends."}</p></div></div> : <>
        <div className="evolution-metric-grid"><span><small>{zh ? "当前风险" : "Current risk"}</small><strong>{latestSnapshot.riskScore}</strong></span><span><small>{zh ? "风险变化" : "Risk delta"}</small><strong>{latestSnapshot.riskDelta ?? (zh ? "未记录" : "not recorded")}</strong></span><span><small>{zh ? "热点" : "Hotspots"}</small><strong>{latestSnapshot.metrics.hotspotCount}</strong></span><span><small>{zh ? "所有权风险" : "Ownership risk"}</small><strong>{Math.round(latestSnapshot.metrics.ownershipRisk * 100)}%</strong></span></div>
        <div className="evolution-snapshot-list">{snapshots.map(snapshot => <article key={snapshot.id}><ShieldCheck size={15} /><span><strong>{snapshot.headRevision.slice(0, 12)}</strong><small>{new Date(snapshot.capturedAt).toLocaleString(locale)} · {snapshot.metrics.filesTracked} {zh ? "个文件" : "files"}</small></span><code>{zh ? "风险" : "risk"} {snapshot.riskScore}</code></article>)}</div>
      </>}
    </section>}

    {view === "findings" && <section className="section-block repository-issues">
      <div className="panel-title"><div><span className="panel-kicker"><FileSearch2 size={14} />{zh ? "跨提交生命周期" : "Cross-commit lifecycle"}</span><h2>{zh ? "审计问题" : "Audit issues"}</h2></div><strong>{issues.length}</strong></div>
      {issuesQuery.isPending ? <div className="loading-state">{zh ? "正在加载问题" : "Loading issues"}</div> : issues.length === 0 ? <div className="repository-honest-empty"><FileSearch2 size={20} /><div><strong>{zh ? "尚未记录审计问题" : "No audit issues recorded"}</strong><p>{zh ? "旧版报告发现不会被冒充为跨提交 Issue。" : "Legacy report findings are not presented as cross-commit issues."}</p></div></div> : <div className="repository-issue-list">{issues.map(issue => <article key={issue.id}><span className={`badge severity-${issue.severity}`}>{issue.severity}</span><div><strong>{issue.title}</strong><small>{issue.ruleId} · {issue.location ? `${issue.location.file}${issue.location.startLine ? `:${issue.location.startLine}` : ""}` : (zh ? "无定位" : "no location")}</small></div><code>{issue.state}</code></article>)}</div>}
    </section>}

    {view === "automations" && <section className="section-block repository-automation-summary">
      <div className="panel-title"><div><span className="panel-kicker"><CalendarClock size={14} />{zh ? "绑定" : "Bindings"}</span><h2>{zh ? "仓库自动化" : "Repository automations"}</h2></div><Link to="/automations">{zh ? "打开控制面" : "Open control plane"}</Link></div>
      {repositoryAutomations.length === 0 ? <div className="repository-honest-empty"><CalendarClock size={20} /><div><strong>{zh ? "没有绑定自动化" : "No automations are bound"}</strong><p>{zh ? "此处不创建示例计划。" : "No sample schedules are created here."}</p></div></div> : <div className="repository-automation-list">{repositoryAutomations.map(automation => <article key={automation.id}><span className={automation.enabled ? "automation-state enabled" : "automation-state"}><i />{automation.enabled ? (zh ? "启用" : "enabled") : (zh ? "暂停" : "paused")}</span><div><strong>{automation.name}</strong><small>{automation.trigger.type} · {automation.executionProfile}</small></div><code>{automation.workflowRevisionId.slice(0, 12)}</code></article>)}</div>}
    </section>}

    {view === "audit-log" && <section className="section-block repository-audit-log">
      <div className="panel-title"><div><span className="panel-kicker"><Activity size={14} />{zh ? "不可变轨迹" : "Recorded trail"}</span><h2>{zh ? "审计日志" : "Audit log"}</h2></div><strong>{auditEntries.length}</strong></div>
      {timelineQuery.isPending ? <div className="loading-state">{zh ? "正在加载审计轨迹" : "Loading audit trail"}</div> : auditEntries.length === 0 ? <div className="repository-honest-empty"><Activity size={20} /><div><strong>{zh ? "尚未记录事件" : "No events recorded"}</strong><p>{zh ? "缺失的步骤保持未记录。" : "Missing stages remain explicitly unrecorded."}</p></div></div> : <ol className="repository-audit-entries">{auditEntries.map(entry => <li key={entry.id}><i aria-hidden="true" /><span><strong>{entry.kind}</strong><small>{entry.detail}</small></span><time dateTime={entry.at}>{new Date(entry.at).toLocaleString(locale)}</time></li>)}</ol>}
    </section>}
  </div>;
}
