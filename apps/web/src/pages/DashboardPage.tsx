import type { HeartbeatPulse, ReviewJob, ReviewReport, StatsResponse } from "@consistency/schema";
import { Activity, AlertTriangle, ArrowRight, Github, Radio, ScanSearch, Timer } from "lucide-react";
import { useMemo, useState } from "react";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../i18n";

const ACTIVE_STATUSES = new Set<ReviewJob["status"]>(["queued", "running", "awaiting_publish", "publishing"]);
const DEGRADED_STATUSES = new Set<ReviewJob["status"]>(["failed", "publish_failed"]);
const DECISION_READY_STATUSES = new Set<ReviewJob["status"]>(["succeeded", "awaiting_publish", "publishing", "publish_failed"]);
const RISK_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 } as const;

type DashboardHeartbeat = { pulse: HeartbeatPulse | null; history: HeartbeatPulse[]; unavailable: boolean };

const COPY = {
  "en-US": {
    title: "Operations inbox",
    subtitle: "Audit operations",
    needsDecision: "Needs decision",
    activeRuns: "Active runs",
    degradedRuns: "Degraded runs",
    repositories: "Repositories",
    recorded: "recorded",
    reports: "reports",
    average: "average",
    analyzePublicPr: "Analyze public PR",
    publicPrUnavailable: "Public PR intake unavailable",
    patRead: "PAT read",
    anonymousRead: "Anonymous read",
    disabled: "Disabled",
    accessPending: "Access mode pending",
    monitor: "Repository monitor",
    monitorUnavailable: "Repository monitor unavailable",
    noHeartbeat: "No heartbeat recorded",
    dirtyFiles: "dirty files",
    pendingEvents: "pending events",
    pulses: "pulses recorded",
    decisionQueue: "Decision queue",
    decisionContext: "Completed analyses without a recorded human disposition",
    allRuns: "All runs",
    noDecisions: "No completed analyses are waiting for a recorded decision.",
    findings: "findings",
    runWatch: "Run watch",
    runWatchContext: "Active work and failures that need operator attention",
    noRunWatch: "No active or degraded runs are recorded.",
    repoFleet: "Repository fleet",
    repoFleetContext: "Latest review state per observed repository",
    reviews: "reviews",
    monitored: "live monitor",
    noFleet: "No repository has produced a review or heartbeat yet.",
    signalWatch: "Signal watch",
    signalWatchContext: "Only signals present in current API payloads",
    regression: "Regression signal",
    automationFailure: "Automation failures",
    riskWorsened: "Repository risk index worsened",
    noWorsening: "No worsening repository-risk trend in the latest window.",
    noRegressionSource: "Not recorded · repository health history is unavailable.",
    automationUnavailable: "Not connected · Inbox does not receive automation execution history.",
    securityDebt: "unsettled security items",
    recentRuns: "Recent reviews",
    recentRunsContext: "Newest recorded runs across the fleet",
    noRuns: "No review runs have been recorded.",
    repository: "Repository",
    state: "State",
    risk: "Risk",
    duration: "Duration",
    updated: "Updated",
    noReport: "not reported",
    runPending: "Analysis has not produced a report yet."
  },
  "zh-CN": {
    title: "运营收件箱",
    subtitle: "人工审查队列与实时 Harness 状态",
    needsDecision: "待决策",
    activeRuns: "活跃运行",
    degradedRuns: "异常运行",
    repositories: "仓库",
    recorded: "条记录",
    reports: "份报告",
    average: "平均",
    analyzePublicPr: "分析公开 PR",
    publicPrUnavailable: "公开 PR 接入不可用",
    patRead: "PAT 读取",
    anonymousRead: "匿名读取",
    disabled: "已禁用",
    accessPending: "访问模式待确认",
    monitor: "仓库监控",
    monitorUnavailable: "仓库监控不可用",
    noHeartbeat: "尚未记录心跳",
    dirtyFiles: "个脏文件",
    pendingEvents: "个待处理事件",
    pulses: "次心跳记录",
    decisionQueue: "决策队列",
    decisionContext: "分析已完成，但尚未记录人工处置",
    allRuns: "全部运行",
    noDecisions: "没有等待记录人工决策的已完成分析。",
    findings: "项发现",
    runWatch: "运行监视",
    runWatchContext: "需要操作者关注的活跃工作与失败",
    noRunWatch: "尚未记录活跃或异常运行。",
    repoFleet: "仓库舰队",
    repoFleetContext: "每个已观察仓库的最近审查状态",
    reviews: "次审查",
    monitored: "实时监控",
    noFleet: "尚无仓库产生审查或心跳。",
    signalWatch: "信号监视",
    signalWatchContext: "仅展示当前 API 载荷中真实存在的信号",
    regression: "回归信号",
    automationFailure: "自动化失败",
    riskWorsened: "仓库风险指数上升",
    noWorsening: "最近窗口内没有恶化的仓库风险趋势。",
    noRegressionSource: "未记录 · 仓库健康历史不可用。",
    automationUnavailable: "未接入 · 收件箱尚未获得自动化执行历史。",
    securityDebt: "项未结安全债务",
    recentRuns: "最近审查",
    recentRunsContext: "仓库舰队中最新记录的运行",
    noRuns: "尚未记录审查运行。",
    repository: "仓库",
    state: "状态",
    risk: "风险",
    duration: "耗时",
    updated: "更新时间",
    noReport: "未报告",
    runPending: "分析尚未生成报告。"
  }
} as const;

function epoch(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function duration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function jobDuration(job: ReviewJob): string {
  if (!job.startedAt || !job.finishedAt) return "—";
  return duration(Math.max(0, epoch(job.finishedAt) - epoch(job.startedAt)));
}

export function buildInboxModel(jobs: ReviewJob[], reports: ReviewReport[], heartbeat?: DashboardHeartbeat) {
  const reportByJob = new Map(reports.map(report => [report.jobId, report]));
  const sortedJobs = [...jobs].sort((left, right) => epoch(right.createdAt) - epoch(left.createdAt));
  const reportFor = (job: ReviewJob) => job.report?.jobId === job.id ? job.report : reportByJob.get(job.id);
  const decisions = sortedJobs.flatMap(job => {
    const report = reportFor(job);
    return report && DECISION_READY_STATUSES.has(job.status) ? [{ job, report }] : [];
  }).sort((left, right) =>
    RISK_WEIGHT[right.report.riskLevel] - RISK_WEIGHT[left.report.riskLevel]
      || epoch(right.report.createdAt) - epoch(left.report.createdAt)
  );
  const activeRuns = sortedJobs.filter(job => ACTIVE_STATUSES.has(job.status));
  const degradedRuns = sortedJobs.filter(job => DEGRADED_STATUSES.has(job.status));
  const fleetByName = new Map<string, { name: string; reviewCount: number; latestJob?: ReviewJob; monitored: boolean }>();

  for (const job of sortedJobs) {
    const current = fleetByName.get(job.repositoryFullName);
    if (current) current.reviewCount += 1;
    else fleetByName.set(job.repositoryFullName, { name: job.repositoryFullName, reviewCount: 1, latestJob: job, monitored: false });
  }
  const monitoredName = heartbeat?.pulse?.repository.root;
  if (monitoredName && monitoredName !== "unknown") {
    const current = fleetByName.get(monitoredName);
    if (current) current.monitored = true;
    else fleetByName.set(monitoredName, { name: monitoredName, reviewCount: 0, monitored: true });
  }

  return {
    decisions,
    activeRuns,
    degradedRuns,
    watchedRuns: [...degradedRuns, ...activeRuns],
    repositories: [...fleetByName.values()].sort((left, right) =>
      Number(right.monitored) - Number(left.monitored)
        || epoch(right.latestJob?.createdAt ?? "") - epoch(left.latestJob?.createdAt ?? "")
    ),
    recentJobs: sortedJobs.slice(0, 6),
    reportFor,
    riskTrend: heartbeat?.pulse?.metrics
  };
}

function PanelHeading({ title, context, action }: { title: string; context: string; action?: React.ReactNode }) {
  return <header className="ops-panel-heading"><div><h2>{title}</h2><p>{context}</p></div>{action}</header>;
}

export function DashboardPage({ stats, jobs, reports, onOpenJob, onOpenJobs, onAnalyzePublicPr, publicPrAnalyzing, publicPrError, publicPrAccessMode, heartbeat }: {
  stats: StatsResponse;
  jobs: ReviewJob[];
  reports: ReviewReport[];
  onOpenJob: (job: ReviewJob) => void;
  onOpenJobs: () => void;
  onAnalyzePublicPr?: (url: string) => Promise<void>;
  publicPrAnalyzing?: boolean;
  publicPrError?: string;
  publicPrAccessMode?: "anonymous" | "pat" | "disabled";
  heartbeat?: DashboardHeartbeat;
}) {
  const { locale, t } = useI18n();
  const copy = COPY[locale];
  const [publicPrUrl, setPublicPrUrl] = useState("");
  const model = useMemo(() => buildInboxModel(jobs, reports, heartbeat), [heartbeat, jobs, reports]);
  const publicPrEnabled = (publicPrAccessMode === "anonymous" || publicPrAccessMode === "pat") && Boolean(onAnalyzePublicPr);
  const accessLabel = publicPrAccessMode === "pat" ? copy.patRead : publicPrAccessMode === "anonymous" ? copy.anonymousRead : publicPrAccessMode === "disabled" ? copy.disabled : copy.accessPending;
  const monitorTone = heartbeat?.unavailable || heartbeat?.pulse?.state === "degraded" ? "degraded" : heartbeat?.pulse ? "connected" : "idle";
  const formatDate = (value: string) => new Date(value).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return <div className="page-stack dashboard-page operations-dashboard">
    <section className="ops-commandbar" aria-labelledby="operations-inbox-title">
      <div className="ops-command-summary">
        <div><span className="panel-kicker"><ScanSearch size={13} />{copy.subtitle}</span><h2 id="operations-inbox-title">{copy.title}</h2></div>
        <div className="ops-counters" role="list" aria-label={copy.subtitle}>
          <span role="listitem"><strong>{model.decisions.length}</strong>{copy.needsDecision}</span>
          <span role="listitem"><strong>{model.activeRuns.length}</strong>{copy.activeRuns}</span>
          <span className={model.degradedRuns.length ? "degraded" : ""} role="listitem"><strong>{model.degradedRuns.length}</strong>{copy.degradedRuns}</span>
          <span role="listitem"><strong>{model.repositories.length}</strong>{copy.repositories}</span>
        </div>
        <small>{stats.totalJobs} {copy.recorded} · {reports.length} {copy.reports} · {copy.average} {duration(stats.averageDuration)}</small>
      </div>
      <form className="ops-pr-tool" aria-label={copy.analyzePublicPr} onSubmit={event => {
        event.preventDefault();
        if (publicPrEnabled && publicPrUrl.trim() && onAnalyzePublicPr) void onAnalyzePublicPr(publicPrUrl.trim());
      }}>
        <div className="ops-pr-label"><Github size={15} /><span><strong>{publicPrEnabled ? copy.analyzePublicPr : copy.publicPrUnavailable}</strong><small>{accessLabel}</small></span></div>
        <label><span className="sr-only">{t("GitHub pull request URL")}</span><input aria-label={t("GitHub pull request URL")} value={publicPrUrl} onChange={event => setPublicPrUrl(event.target.value)} placeholder="github.com/owner/repo/pull/123" /></label>
        <button type="submit" aria-label={t("Analyze PR")} disabled={!publicPrEnabled || publicPrAnalyzing || !publicPrUrl.trim()}>{publicPrAnalyzing ? t("Resolving…") : <ArrowRight size={15} />}</button>
        {publicPrError ? <small className="ops-pr-error" role="alert">{publicPrError}</small> : null}
      </form>
    </section>

    <section className={`ops-runtime-strip ${monitorTone}`} aria-label={copy.monitor}>
      <span className="ops-runtime-state"><Radio size={13} /><strong>{copy.monitor}</strong><i aria-hidden="true" />{heartbeat?.unavailable ? copy.monitorUnavailable : heartbeat?.pulse?.state ?? copy.noHeartbeat}</span>
      {heartbeat?.pulse ? <><strong>{heartbeat.pulse.repository.root}</strong><code>{heartbeat.pulse.repository.branch ?? "detached"}</code><span>{heartbeat.pulse.dirtyFileCount} {copy.dirtyFiles} · {heartbeat.pulse.pendingEvents} {copy.pendingEvents}</span><time dateTime={heartbeat.pulse.observedAt}>{formatDate(heartbeat.pulse.observedAt)}</time></> : <span>{heartbeat?.history.length ?? 0} {copy.pulses}</span>}
    </section>

    <section className="ops-board">
      <section className="ops-panel ops-decisions">
        <PanelHeading title={copy.decisionQueue} context={copy.decisionContext} action={<button type="button" onClick={onOpenJobs}>{copy.allRuns}<ArrowRight size={13} /></button>} />
        <div className="ops-row-list">
          {model.decisions.length === 0 ? <div className="ops-empty"><ScanSearch size={16} /><span>{copy.noDecisions}</span></div> : model.decisions.slice(0, 4).map(({ job, report }) => <button className="ops-decision-row" type="button" key={job.id} onClick={() => onOpenJob(job)}>
            <i className={`ops-risk-mark risk-${report.riskLevel}`} aria-hidden="true" />
            <span><strong>{job.repositoryFullName}{job.pullRequestNumber ? ` · #${job.pullRequestNumber}` : ""}</strong><small>{report.summary}</small></span>
            <span className="ops-row-signals"><StatusBadge value={report.riskLevel} /><b>{report.findings.length} {copy.findings}</b></span>
          </button>)}
        </div>
      </section>

      <section className="ops-panel ops-run-watch">
        <PanelHeading title={copy.runWatch} context={copy.runWatchContext} />
        <div className="ops-row-list">
          {model.watchedRuns.length === 0 ? <div className="ops-empty"><Activity size={16} /><span>{copy.noRunWatch}</span></div> : model.watchedRuns.slice(0, 4).map(job => <button className="ops-run-row" type="button" key={job.id} onClick={() => onOpenJob(job)}>
            <StatusBadge value={job.status} /><span><strong>{job.repositoryFullName}</strong><small>{job.error ?? `${job.headSha.slice(0, 10)} · ${job.report?.summary ?? copy.runPending}`}</small></span><time dateTime={job.createdAt}>{formatDate(job.createdAt)}</time>
          </button>)}
        </div>
      </section>

      <section className="ops-panel ops-fleet">
        <PanelHeading title={copy.repoFleet} context={copy.repoFleetContext} />
        <div className="ops-row-list">
          {model.repositories.length === 0 ? <div className="ops-empty"><Radio size={16} /><span>{copy.noFleet}</span></div> : model.repositories.slice(0, 4).map(repository => {
            const content = <><span className={repository.monitored ? "ops-repo-mark monitored" : "ops-repo-mark"}><i aria-hidden="true" /></span><span><strong>{repository.name}</strong><small>{repository.reviewCount} {copy.reviews}{repository.monitored ? ` · ${copy.monitored}` : ""}</small></span>{repository.latestJob ? <StatusBadge value={repository.latestJob.status} /> : <code>{heartbeat?.pulse?.state ?? "idle"}</code>}</>;
            return repository.latestJob ? <button className="ops-fleet-row" type="button" key={repository.name} onClick={() => onOpenJob(repository.latestJob!)}>{content}</button> : <div className="ops-fleet-row" key={repository.name}>{content}</div>;
          })}
        </div>
      </section>

      <section className="ops-panel ops-signals">
        <PanelHeading title={copy.signalWatch} context={copy.signalWatchContext} />
        <div className="ops-signal-list">
          <article className={model.riskTrend && model.riskTrend.riskIndexTrend > 0 ? "warning" : model.riskTrend ? "clear" : "missing"}>
            <span><AlertTriangle size={15} /><strong>{copy.regression}</strong></span>
            {model.riskTrend ? model.riskTrend.riskIndexTrend > 0
              ? <p>{copy.riskWorsened} +{Math.round(model.riskTrend.riskIndexTrend * 100)}% · {model.riskTrend.unsettledSecurityDebt} {copy.securityDebt}</p>
              : <p>{copy.noWorsening}</p>
              : <p>{copy.noRegressionSource}</p>}
          </article>
          <article className="missing"><span><Timer size={15} /><strong>{copy.automationFailure}</strong></span><p>{copy.automationUnavailable}</p></article>
        </div>
      </section>
    </section>

    <section className="ops-recent">
      <PanelHeading title={copy.recentRuns} context={copy.recentRunsContext} action={<button type="button" onClick={onOpenJobs}>{copy.allRuns}<ArrowRight size={13} /></button>} />
      {model.recentJobs.length === 0 ? <div className="ops-empty"><Activity size={16} /><span>{copy.noRuns}</span></div> : <div className="ops-table-wrap"><table>
        <caption className="sr-only">{copy.recentRuns}</caption>
        <thead><tr><th scope="col">{copy.repository}</th><th scope="col">{copy.state}</th><th scope="col">{copy.risk}</th><th scope="col">{copy.duration}</th><th scope="col">{copy.updated}</th></tr></thead>
        <tbody>{model.recentJobs.map(job => {
          const report = model.reportFor(job);
          return <tr key={job.id}><td><button type="button" onClick={() => onOpenJob(job)}><strong>{job.repositoryFullName}</strong><small>{job.pullRequestNumber ? `PR #${job.pullRequestNumber}` : t("Local repository")}</small></button></td><td><StatusBadge value={job.status} /></td><td>{report ? <StatusBadge value={report.riskLevel} /> : <span className="ops-muted">{copy.noReport}</span>}</td><td>{jobDuration(job)}</td><td><time dateTime={job.createdAt}>{formatDate(job.createdAt)}</time></td></tr>;
        })}</tbody>
      </table></div>}
    </section>
  </div>;
}
