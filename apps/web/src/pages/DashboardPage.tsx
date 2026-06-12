import type { ReviewJob, ReviewReport, StatsResponse } from "@consistency/schema";
import { Activity, CheckCircle2, Clock3, GitPullRequest, Timer } from "lucide-react";
import { StatusBadge } from "../components/StatusBadge";

function duration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

export function DashboardPage({ stats, jobs, reports, onOpenJob }: {
  stats: StatsResponse;
  jobs: ReviewJob[];
  reports: ReviewReport[];
  onOpenJob: (job: ReviewJob) => void;
}) {
  const metrics = [
    ["Total reviews", stats.totalJobs, GitPullRequest],
    ["Succeeded", stats.succeededJobs, CheckCircle2],
    ["Running", stats.runningJobs, Activity],
    ["Average duration", duration(stats.averageDuration), Timer]
  ] as const;
  const totalRisk = Math.max(1, Object.values(stats.riskDistribution).reduce((sum, value) => sum + value, 0));
  const highRisk = reports.flatMap(report => report.findings.map(finding => ({ finding, report })))
    .filter(item => item.finding.severity === "critical" || item.finding.severity === "high")
    .slice(0, 5);

  return <div className="page-stack">
    <section className="metric-strip" aria-label="Review statistics">
      {metrics.map(([label, value, Icon]) => <div className="metric" key={label}>
        <Icon size={18} /><span>{label}</span><strong>{value}</strong>
      </div>)}
    </section>

    <section className="dashboard-split">
      <div className="section-block">
        <div className="section-heading"><div><h2>Risk distribution</h2><p>Completed reviews by final risk level</p></div></div>
        <div className="risk-bar" aria-label="Risk distribution">
          {(["critical", "high", "medium", "low"] as const).map(level => {
            const count = stats.riskDistribution[level] ?? 0;
            return <span className={`risk-segment risk-${level}`} key={level} style={{ width: `${count / totalRisk * 100}%` }} />;
          })}
        </div>
        <div className="risk-legend">
          {(["critical", "high", "medium", "low"] as const).map(level => <div key={level}>
            <i className={`risk-dot risk-${level}`} /><span>{level}</span><strong>{stats.riskDistribution[level]}</strong>
          </div>)}
        </div>
      </div>
      <div className="section-block">
        <div className="section-heading"><div><h2>Priority findings</h2><p>High-impact items requiring attention</p></div></div>
        <div className="priority-list">
          {highRisk.length === 0 ? <div className="empty-inline">No high-risk findings</div> : highRisk.map(({ finding, report }) => <div key={finding.id}>
            <StatusBadge value={finding.severity} />
            <span><strong>{finding.title}</strong><small>{report.repositoryFullName} · {finding.file}</small></span>
          </div>)}
        </div>
      </div>
    </section>

    <section className="section-block table-section">
      <div className="section-heading"><div><h2>Recent review jobs</h2><p>Latest GitHub pull request analysis activity</p></div><Clock3 size={18} /></div>
      <div className="data-table">
        <div className="table-row table-head"><span>Repository / PR</span><span>Status</span><span>Risk</span><span>Score</span><span>Created</span></div>
        {jobs.slice(0, 8).map(job => <button className="table-row" key={job.id} type="button" onClick={() => onOpenJob(job)}>
          <span><strong>{job.repositoryFullName}</strong><small>PR #{job.pullRequestNumber}</small></span>
          <span><StatusBadge value={job.status} /></span>
          <span>{job.report ? <StatusBadge value={job.report.riskLevel} /> : "-"}</span>
          <span className="score-cell">{job.report?.score ?? "-"}</span>
          <span>{new Date(job.createdAt).toLocaleString()}</span>
        </button>)}
      </div>
    </section>
  </div>;
}
