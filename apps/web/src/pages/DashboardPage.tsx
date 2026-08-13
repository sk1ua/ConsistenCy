import type { ReviewJob, ReviewReport, StatsResponse } from "@consistency/schema";
import { Activity, ArrowRight, CheckCircle2, FileText, Github, GitPullRequest, Radar, Timer } from "lucide-react";
import { useState } from "react";
import { EvidencePanel } from "../components/EvidencePanel";
import { HeartbeatWidget } from "../components/HeartbeatWidget";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../i18n";
import type { HeartbeatPulse } from "@consistency/schema";

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
  heartbeat?: { pulse: HeartbeatPulse | null; history: HeartbeatPulse[]; unavailable: boolean };
}) {
  const { locale, t } = useI18n();
  const [publicPrUrl, setPublicPrUrl] = useState("");
  const severityWeight = { critical: 4, high: 3, medium: 2, low: 1, info: 0 } as const;
  const successRate = stats.totalJobs ? Math.round(stats.succeededJobs / stats.totalJobs * 1000) / 10 : 0;
  const queuedJobs = jobs.filter(job => job.status === "queued").length;
  const metrics = [
    { label: t("Total reviews"), value: stats.totalJobs, note: t("{count} reports available", { count: reports.length }), icon: GitPullRequest, tone: "green" },
    { label: t("Succeeded"), value: stats.succeededJobs, note: t("{rate}% success rate", { rate: successRate }), icon: CheckCircle2, tone: "success" },
    { label: t("Running"), value: stats.runningJobs, note: t("{count} queued", { count: queuedJobs }), icon: Activity, tone: "blue" },
    { label: t("Avg duration"), value: duration(stats.averageDuration), note: t("Across completed jobs"), icon: Timer, tone: "amber" }
  ] as const;
  const riskLevels = ["low", "medium", "high", "critical"] as const;
  const totalRisk = Math.max(1, riskLevels.reduce((sum, level) => sum + (stats.riskDistribution[level] ?? 0), 0));
  const recentFindings = reports.flatMap(report => report.findings.map(finding => ({ finding, report })))
    .sort((left, right) => severityWeight[right.finding.severity] - severityWeight[left.finding.severity])
    .slice(0, 5);
  const retrievalReport = reports.find(report => report.retrieval?.packs.length);
  const elevatedReviews = (stats.riskDistribution.high ?? 0) + (stats.riskDistribution.critical ?? 0);

  return <div className="page-stack dashboard-page">
    <section className="dashboard-intro">
      <div className="intro-copy"><span className="eyebrow"><Radar size={15} />{t("Review pulse")}</span><h2>{t("Focus attention where the evidence is strongest.")}</h2><p>{t("One view for review progress, risk concentration, and the context behind every finding.")}</p></div>
      <div className="attention-signal"><span>{t("Needs attention")}</span><strong>{elevatedReviews}</strong><small>{t(elevatedReviews === 1 ? "elevated review" : "elevated reviews")}</small></div>
      <div className="review-track" aria-label={t("Review workflow")}><span className="done">{t("Intake")}</span><span className="done">{t("Analysis")}</span><span className="active">{t("Evidence")}</span><span>{t("Decision")}</span></div>
    </section>
    <section className="public-pr-intake">
      <div className="public-pr-copy"><span className="panel-kicker">{t("Public PR analysis")} · {publicPrAccessMode === "pat" ? t("PAT read") : publicPrAccessMode === "disabled" ? t("disabled") : t("anonymous read")}</span><h2>{t("Bring a public pull request into the evidence workspace.")}</h2><p>{t("No GitHub App installation is required. The URL flow reads public code, creates an analysis-only job and never posts a comment.")}</p></div>
      <form onSubmit={event => { event.preventDefault(); if (publicPrUrl.trim() && onAnalyzePublicPr) void onAnalyzePublicPr(publicPrUrl.trim()); }}><label><span className="command-prompt" aria-hidden="true">&gt;</span><Github size={15} /><span className="sr-only">{t("GitHub pull request URL")}</span><input aria-label={t("GitHub pull request URL")} value={publicPrUrl} onChange={event => setPublicPrUrl(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" /></label><button type="submit" disabled={!onAnalyzePublicPr || publicPrAnalyzing || !publicPrUrl.trim()}>{publicPrAnalyzing ? t("Resolving…") : t("Analyze PR")}<ArrowRight size={14} /></button></form>
      {publicPrError && <small className="public-pr-error">{publicPrError}</small>}
    </section>
    <section className="metric-grid" aria-label={t("Review statistics")}>
      {metrics.map(({ label, value, note, icon: Icon, tone }) => <article className="metric-card" key={label}>
        <div className={`metric-icon metric-icon-${tone}`}><Icon aria-hidden="true" size={19} /></div>
        <div className="metric-copy"><span>{label}</span><strong>{value}</strong></div>
        <small>{note}</small>
      </article>)}
    </section>
    {heartbeat && <HeartbeatWidget pulse={heartbeat.pulse} history={heartbeat.history} unavailable={heartbeat.unavailable} />}

    <section className="dashboard-split">
      <article className="section-block risk-panel">
        <div className="panel-title"><div><span className="panel-kicker">{t("Decision signal")}</span><h2>{t("Risk distribution")} <span>{t("Completed reviews")}</span></h2></div><button className="link-button" type="button" onClick={onOpenJobs}>{t("Open queue")} <ArrowRight size={14} /></button></div>
        <div className="risk-bar" aria-label={t("Risk distribution")}>
          {riskLevels.map(level => {
            const count = stats.riskDistribution[level] ?? 0;
            const percent = count / totalRisk * 100;
            return <span className={`risk-segment risk-${level}`} key={level} style={{ width: `${percent}%` }}>{percent >= 12 ? `${Math.round(percent)}%` : ""}</span>;
          })}
        </div>
        <div className="risk-list">
          {riskLevels.map(level => <div key={level}><span><i className={`risk-dot risk-${level}`} />{t(level)}</span><strong>{stats.riskDistribution[level]}</strong></div>)}
          <div className="risk-total"><span>{t("Total")}</span><strong>{Object.values(stats.riskDistribution).reduce((sum, count) => sum + count, 0)}</strong></div>
        </div>
      </article>

      <article className="section-block findings-panel">
        <div className="panel-title"><div><span className="panel-kicker">{t("Highest priority")}</span><h2>{t("Recent findings")}</h2></div><button className="link-button" type="button" onClick={onOpenJobs}>{t("View all")} <ArrowRight size={14} /></button></div>
        <div className="priority-table">
          {recentFindings.length === 0 ? <div className="empty-inline">{t("No findings reported")}</div> : recentFindings.map(({ finding, report }) => <div className="priority-row" key={finding.id}>
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
      <div className="panel-title"><div><span className="panel-kicker">{t("Review trail")}</span><h2>{t("Recent PR review jobs")}</h2></div><button className="link-button" type="button" onClick={onOpenJobs}>{t("View all jobs")} <ArrowRight size={14} /></button></div>
      <div className="data-table dashboard-table">
        <div className="table-row table-head"><span>{t("Repository")}</span><span>{t("Pull request")}</span><span>{t("Status")}</span><span>{t("Risk")}</span><span>{t("Score")}</span><span>{t("Duration")}</span><span>{t("Created")}</span><span /></div>
        {jobs.slice(0, 8).map(job => <button className="table-row" key={job.id} type="button" onClick={() => onOpenJob(job)}>
          <span className="repository-cell"><Github size={17} /><strong>{job.repositoryFullName}</strong></span>
          <span className="pr-cell"><b>#{job.pullRequestNumber}</b><small>{job.report?.summary ?? t("Pull request review in progress")}</small></span>
          <span><StatusBadge value={job.status} /></span>
          <span className="risk-cell">{job.report ? <><i className={`risk-dot risk-${job.report.riskLevel}`} />{t(job.report.riskLevel)}</> : "-"}</span>
          <span className="score-cell">{job.report?.score ?? "-"}</span>
          <span>{jobDuration(job)}</span>
          <span>{new Date(job.createdAt).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          <span className="row-action"><FileText size={16} /></span>
        </button>)}
      </div>
    </section>
  </div>;
}
