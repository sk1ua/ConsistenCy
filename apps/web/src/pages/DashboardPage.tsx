import { riskBandForFindings, type HeartbeatPulse, type ReviewJob, type ReviewReport, type StatsResponse } from "@consistency/schema";
import { Activity, AlertTriangle, ArrowRight, CheckCircle2, Clock3, FolderGit2, History, Inbox, Layers, Play, ShieldAlert, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "../design-system/Button";
import { useI18n } from "../i18n";
import { Link } from "react-router-dom";

const ACTIVE_STATUSES = new Set<ReviewJob["status"]>(["queued", "running", "awaiting_publish", "publishing"]);
const DEGRADED_STATUSES = new Set<ReviewJob["status"]>(["failed", "publish_failed"]);
const DECISION_READY_STATUSES = new Set<ReviewJob["status"]>(["succeeded", "awaiting_publish", "publishing", "publish_failed"]);
const RISK_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 } as const;

type DashboardHeartbeat = { pulse: HeartbeatPulse | null; history: HeartbeatPulse[]; unavailable: boolean };

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

export function buildInboxModel(jobs: ReviewJob[], reports: ReviewReport[]) {
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
  const repositories = [...new Set(sortedJobs.map(job => job.repositoryFullName))];

  return {
    decisions,
    activeRuns,
    degradedRuns,
    repositories,
    attentionItems: [...degradedRuns.map(job => ({ kind: "failed" as const, job, report: reportFor(job) })), ...decisions.map(({ job, report }) => ({ kind: "decision" as const, job, report }))],
    recentJobs: sortedJobs.slice(0, 6),
    reportFor
  };
}

export function DashboardPage({
  jobs,
  reports,
  onOpenJob,
  onOpenJobs,
}: {
  stats?: StatsResponse;
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
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const model = useMemo(() => buildInboxModel(jobs, reports), [jobs, reports]);
  const formatDate = (value: string) => new Date(value).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="ds-page pw-page page-stack">
      {/* 1. Concise Header */}
      <section className="ds-hero">
        <div className="ds-hero-icon"><Inbox size={18} /></div>
        <div className="ds-hero-body">
          <h2 className="ds-hero-title">{zh ? "收件箱" : "Inbox"}</h2>
          <p className="ds-hero-description">{zh ? "聚焦当前需要关注的审查任务、活跃执行与最新结论。" : "Items requiring operator attention, active reviews, and recent conclusions."}</p>
        </div>

        {/* Compact summary metric line */}
        <div className="ds-chip-row">
          <span className="ds-chip ds-chip--muted"><strong>{model.decisions.length}</strong> {zh ? "项待决策" : "needs decision"}</span>
          <span className={model.degradedRuns.length > 0 ? "ds-chip ds-chip--danger" : "ds-chip ds-chip--muted"}><strong>{model.degradedRuns.length}</strong> {zh ? "项异常" : "degraded"}</span>
          <span className="ds-chip ds-chip--muted"><strong>{model.activeRuns.length}</strong> {zh ? "项活跃运行" : "active"}</span>
        </div>
      </section>

      {/* 2. Needs Attention (Decisions + Failed Runs) */}
      <section className="ds-section">
        <div className="ds-section-header">
          <div className="ds-section-heading">
            <span className="ds-section-kicker">{zh ? "待处理事项" : "Action Required"}</span>
            <h2 className="ds-section-title">{zh ? "需要关注的审查" : "Needs Attention"}</h2>
          </div>
          <strong className="ds-chip ds-chip--muted">{model.attentionItems.length}</strong>
        </div>

        {model.attentionItems.length === 0 ? (
          <div className="ds-empty ds-empty--slim">
            <CheckCircle2 size={18} className="ds-empty-icon ds-empty-icon--ok" />
            <span className="ds-empty-text">{zh ? "暂无需要人工处置或处理异常的审查任务。" : "No reviews requiring attention or disposition."}</span>
          </div>
        ) : (
          <div className="inbox-item-list" role="list">
            {model.attentionItems.slice(0, 5).map(({ kind, job, report }) => (
              <div key={job.id} className="inbox-item-row" role="listitem" onClick={() => onOpenJob(job)}>
                <div className="inbox-row-main">
                  <div className="inbox-row-title">
                    <StatusBadge value={job.status} />
                    <strong>{job.repositoryFullName}{job.pullRequestNumber ? ` · PR #${job.pullRequestNumber}` : ""}</strong>
                    {report && (
                      <span className="score-mini-pill">
                        <strong>{report.score}</strong>
                        <StatusBadge value={report.riskLevel} />
                        <span className={`risk-band risk-band-${report.riskBand ?? riskBandForFindings(report.findings)}`} aria-label={zh ? "发现风险" : "Finding risk"}>{report.riskBand ?? riskBandForFindings(report.findings)}</span>
                      </span>
                    )}
                  </div>
                  <p className="inbox-row-desc">
                    {kind === "failed" ? (job.error ?? (zh ? "审查执行失败" : "Execution failed")) : (report?.summary ?? (zh ? "分析已完成，等待人工处置" : "Completed, awaiting review"))}
                  </p>
                </div>

                <div className="inbox-row-actions">
                  <time dateTime={job.createdAt}>{formatDate(job.createdAt)}</time>
                  <button type="button" className="primary-button btn-small" onClick={(e) => { e.stopPropagation(); onOpenJob(job); }}>
                    {kind === "failed" ? (zh ? "查看详情" : "Details") : (zh ? "查看报告" : "Open")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 3. Active Running Reviews */}
      {model.activeRuns.length > 0 && (
        <section className="ds-section">
          <div className="ds-section-header">
            <div className="ds-section-heading">
              <span className="ds-section-kicker">{zh ? "实时执行" : "Live Execution"}</span>
              <h2 className="ds-section-title">{zh ? "当前运行中的审查" : "Active Reviews"}</h2>
            </div>
            <span className="ds-chip ds-chip--ok">{model.activeRuns.length} {zh ? "运行中" : "running"}</span>
          </div>

          <div className="inbox-item-list" role="list">
            {model.activeRuns.map(job => (
              <div key={job.id} className="inbox-item-row" role="listitem" onClick={() => onOpenJob(job)}>
                <div className="inbox-row-main">
                  <div className="inbox-row-title">
                    <StatusBadge value={job.status} />
                    <strong>{job.repositoryFullName}{job.pullRequestNumber ? ` · PR #${job.pullRequestNumber}` : ""}</strong>
                  </div>
                  <p className="inbox-row-desc">{job.headSha.slice(0, 10)} · {zh ? "智能体正在执行审查..." : "Agents reviewing code..."}</p>
                </div>

                <div className="inbox-row-actions">
                  <time dateTime={job.createdAt}>{formatDate(job.createdAt)}</time>
                  <button type="button" className="primary-button btn-small" onClick={(e) => { e.stopPropagation(); onOpenJob(job); }}>
                    {zh ? "查看运行" : "Runtime"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 4. Recent Reviews List */}
      <section className="ds-section">
        <div className="ds-section-header">
          <div className="ds-section-heading">
            <span className="ds-section-kicker">{zh ? "审查历史" : "Review History"}</span>
            <h2 className="ds-section-title">{zh ? "最近完成的审查" : "Recent Reviews"}</h2>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onOpenJobs}>
            {zh ? "查看全部运行" : "All Runs"} →
          </Button>
        </div>

        {model.recentJobs.length === 0 ? (
          <div className="ds-empty ds-empty--slim"><p className="ds-empty-text">{zh ? "尚未记录任何审查运行。" : "No review runs recorded."}</p></div>
        ) : (
          <div className="inbox-recent-table" role="table">
            <div className="table-header-row" role="row">
              <span role="columnheader">{zh ? "代码仓库 / PR" : "Repository / PR"}</span>
              <span role="columnheader">{zh ? "状态" : "State"}</span>
              <span role="columnheader">{zh ? "质量分 / 风险" : "Score / Risk"}</span>
              <span role="columnheader">{zh ? "耗时" : "Duration"}</span>
              <span role="columnheader">{zh ? "完成时间" : "Time"}</span>
            </div>
            {model.recentJobs.map(job => {
              const report = model.reportFor(job);
              return (
                <div key={job.id} className="table-data-row" role="row" onClick={() => onOpenJob(job)}>
                  <div className="col-repo" role="cell">
                    <strong>{job.repositoryFullName}</strong>
                    <small>{job.pullRequestNumber ? `PR #${job.pullRequestNumber}` : job.id.slice(0, 8)}</small>
                  </div>
                  <div role="cell"><StatusBadge value={job.status} /></div>
                  <div role="cell">
                    {report ? (
                      <span className="score-mini-pill">
                        <strong>{report.score}</strong>
                        <StatusBadge value={report.riskLevel} />
                        <span className={`risk-band risk-band-${report.riskBand ?? riskBandForFindings(report.findings)}`} aria-label={zh ? "发现风险" : "Finding risk"}>{report.riskBand ?? riskBandForFindings(report.findings)}</span>
                      </span>
                    ) : <span className="muted-text">—</span>}
                  </div>
                  <div role="cell"><code>{jobDuration(job)}</code></div>
                  <div role="cell"><time dateTime={job.createdAt}>{formatDate(job.createdAt)}</time></div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
