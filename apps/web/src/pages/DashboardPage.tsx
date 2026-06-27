import type { ReviewJob, ReviewReport, StatsResponse } from "@consistency/schema";
import { Activity, ArrowRight, CheckCircle2, Clock3, FileText, Github, GitPullRequest, Timer } from "lucide-react";
import { EvidencePanel } from "../components/EvidencePanel";
import { StatusBadge } from "../components/StatusBadge";

function duration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function jobDuration(job: ReviewJob): string {
  if (!job.startedAt || !job.finishedAt) return "-";
  return duration(new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime());
}

export function DashboardPage({ stats, jobs, reports, onOpenJob, onOpenJobs }: {
  stats: StatsResponse;
  jobs: ReviewJob[];
  reports: ReviewReport[];
  onOpenJob: (job: ReviewJob) => void;
  onOpenJobs: () => void;
}) {
  const severityWeight = { critical: 4, high: 3, medium: 2, low: 1, info: 0 } as const;
  const successRate = stats.totalJobs ? Math.round(stats.succeededJobs / stats.totalJobs * 1000) / 10 : 0;
  const queuedJobs = jobs.filter(job => job.status === "queued").length;
  const metrics = [
    { label: "Total reviews", value: stats.totalJobs, note: `${reports.length} reports available`, icon: GitPullRequest, tone: "green" },
    { label: "Succeeded", value: stats.succeededJobs, note: `${successRate}% success rate`, icon: CheckCircle2, tone: "success" },
    { label: "Running", value: stats.runningJobs, note: `${queuedJobs} queued`, icon: Activity, tone: "blue" },
    { label: "Avg duration", value: duration(stats.averageDuration), note: "Across completed jobs", icon: Timer, tone: "amber" }
  ] as const;
  const riskLevels = ["low", "medium", "high", "critical"] as const;
  const totalRisk = Math.max(1, riskLevels.reduce((sum, level) => sum + (stats.riskDistribution[level] ?? 0), 0));
  const recentFindings = reports.flatMap(report => report.findings.map(finding => ({ finding, report })))
    .sort((left, right) => severityWeight[right.finding.severity] - severityWeight[left.finding.severity])
    .slice(0, 5);
  const retrievalReport = reports.find(report => report.retrieval?.packs.length);

  return <div className="page-stack dashboard-page">
    <section className="metric-grid" aria-label="Review statistics">
      {metrics.map(({ label, value, note, icon: Icon, tone }) => <article className="metric-card" key={label}>
        <div className={`metric-icon metric-icon-${tone}`}><Icon size={20} /></div>
        <div className="metric-copy"><span>{label}</span><strong>{value}</strong></div>
        <small>{note}</small>
      </article>)}
    </section>

    <section className="dashboard-split">
      <article className="section-block risk-panel">
        <div className="panel-title"><h2>Risk distribution <span>(completed)</span></h2><button className="link-button" type="button" onClick={onOpenJobs}>View report <ArrowRight size={14} /></button></div>
        <div className="risk-bar" aria-label="Risk distribution">
          {riskLevels.map(level => {
            const count = stats.riskDistribution[level] ?? 0;
            const percent = count / totalRisk * 100;
            return <span className={`risk-segment risk-${level}`} key={level} style={{ width: `${percent}%` }}>{percent >= 12 ? `${Math.round(percent)}%` : ""}</span>;
          })}
        </div>
        <div className="risk-list">
          {riskLevels.map(level => <div key={level}><span><i className={`risk-dot risk-${level}`} />{level}</span><strong>{stats.riskDistribution[level]}</strong></div>)}
          <div className="risk-total"><span>Total</span><strong>{Object.values(stats.riskDistribution).reduce((sum, count) => sum + count, 0)}</strong></div>
        </div>
      </article>

      <article className="section-block findings-panel">
        <div className="panel-title"><h2>Recent findings</h2><button className="link-button" type="button" onClick={onOpenJobs}>View all <ArrowRight size={14} /></button></div>
        <div className="priority-table">
          {recentFindings.length === 0 ? <div className="empty-inline">No findings reported</div> : recentFindings.map(({ finding, report }) => <div className="priority-row" key={finding.id}>
            <StatusBadge value={finding.severity} />
            <strong>{finding.title}</strong>
            <span>{report.repositoryFullName}</span>
            <code>{finding.file}{finding.startLine ? `:${finding.startLine}` : ""}</code>
          </div>)}
        </div>
      </article>
    </section>

    <EvidencePanel retrieval={retrievalReport?.retrieval} />

    <section className="section-block table-section">
      <div className="panel-title"><h2>Recent PR review jobs</h2><button className="link-button" type="button" onClick={onOpenJobs}>View all jobs <ArrowRight size={14} /></button></div>
      <div className="data-table dashboard-table">
        <div className="table-row table-head"><span>Repository</span><span>Pull request</span><span>Status</span><span>Risk</span><span>Score</span><span>Duration</span><span>Created</span><span /></div>
        {jobs.slice(0, 8).map(job => <button className="table-row" key={job.id} type="button" onClick={() => onOpenJob(job)}>
          <span className="repository-cell"><Github size={17} /><strong>{job.repositoryFullName}</strong></span>
          <span className="pr-cell"><b>#{job.pullRequestNumber}</b><small>{job.report?.summary ?? "Pull request review in progress"}</small></span>
          <span><StatusBadge value={job.status} /></span>
          <span className="risk-cell">{job.report ? <><i className={`risk-dot risk-${job.report.riskLevel}`} />{job.report.riskLevel}</> : "-"}</span>
          <span className="score-cell">{job.report?.score ?? "-"}</span>
          <span>{jobDuration(job)}</span>
          <span>{new Date(job.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          <span className="row-action"><FileText size={16} /></span>
        </button>)}
      </div>
    </section>
  </div>;
}
