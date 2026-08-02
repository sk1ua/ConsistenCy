import type { JobStatus, ReviewJob, Severity } from "@consistency/schema";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../i18n";

export function JobsPage({ jobs, onOpenJob }: { jobs: ReviewJob[]; onOpenJob: (job: ReviewJob) => void }) {
  const { locale, t } = useI18n();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<JobStatus | "">("");
  const [severity, setSeverity] = useState<Severity | "">("");
  const filtered = useMemo(() => jobs.filter(job => {
    if (search && !`${job.repositoryFullName} ${job.pullRequestNumber}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (status && job.status !== status) return false;
    if (severity && !job.report?.findings.some(finding => finding.severity === severity)) return false;
    return true;
  }), [jobs, search, status, severity]);

  return <section className="section-block jobs-page">
    <div className="filter-bar">
      <label className="search-field"><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={t("Search repository or PR")} /></label>
      <select value={status} onChange={event => setStatus(event.target.value as JobStatus | "")} aria-label={t("Filter by status")}>
        <option value="">{t("All statuses")}</option><option value="queued">{t("Queued")}</option><option value="running">{t("Running option")}</option><option value="awaiting_publish">{t("awaiting publish")}</option><option value="publishing">{t("publishing")}</option><option value="succeeded">{t("Succeeded option")}</option><option value="failed">{t("Failed")}</option><option value="publish_failed">{t("publish failed")}</option>
      </select>
      <select value={severity} onChange={event => setSeverity(event.target.value as Severity | "")} aria-label={t("Filter by severity")}>
        <option value="">{t("All severities")}</option><option value="critical">{t("Critical")}</option><option value="high">{t("High")}</option><option value="medium">{t("Medium")}</option><option value="low">{t("Low")}</option><option value="info">{t("Info")}</option>
      </select>
      <span className="result-count">{t("{count} jobs", { count: filtered.length })}</span>
    </div>
    <div className="data-table jobs-table">
      <div className="table-row table-head"><span>{t("Repository / PR")}</span><span>{t("Status")}</span><span>{t("Risk")}</span><span>{t("Findings")}</span><span>{t("Commit range")}</span><span>{t("Created")}</span></div>
      {filtered.map(job => <button className="table-row" key={job.id} type="button" onClick={() => onOpenJob(job)}>
        <span><strong>{job.repositoryFullName}</strong><small>PR #{job.pullRequestNumber}</small></span>
        <span><StatusBadge value={job.status} /></span>
        <span>{job.report ? <StatusBadge value={job.report.riskLevel} /> : "-"}</span>
        <span>{job.report?.findings.length ?? "-"}</span>
        <span className="commit-range">{job.baseSha.slice(0, 7)}..{job.headSha.slice(0, 7)}</span>
        <span>{new Date(job.createdAt).toLocaleDateString(locale)}</span>
      </button>)}
      {filtered.length === 0 && <div className="empty-state">{t("No review jobs match these filters.")}</div>}
    </div>
  </section>;
}
