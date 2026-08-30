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

  return <div className="ds-page pw-page">
    <section className="ds-hero">
      <div className="pw-hero-tools">
        <label className="pw-search"><Search size={15} className="ds-input-prefix" /><span className="sr-only">{t("Search repository or PR")}</span><input className="ds-input ds-input--has-prefix" value={search} onChange={event => setSearch(event.target.value)} placeholder={t("Search repository or PR")} /></label>
        <select className="ds-select pw-select" value={status} onChange={event => setStatus(event.target.value as JobStatus | "")} aria-label={t("Filter by status")}>
          <option value="">{t("All statuses")}</option><option value="queued">{t("Queued")}</option><option value="running">{t("Running option")}</option><option value="awaiting_publish">{t("awaiting publish")}</option><option value="publishing">{t("publishing")}</option><option value="succeeded">{t("Succeeded option")}</option><option value="failed">{t("Failed")}</option><option value="publish_failed">{t("publish failed")}</option>
        </select>
        <select className="ds-select pw-select" value={severity} onChange={event => setSeverity(event.target.value as Severity | "")} aria-label={t("Filter by severity")}>
          <option value="">{t("All severities")}</option><option value="critical">{t("Critical")}</option><option value="high">{t("High")}</option><option value="medium">{t("Medium")}</option><option value="low">{t("Low")}</option><option value="info">{t("Info")}</option>
        </select>
        <span className="ds-chip ds-chip--muted pw-result-chip">{t("{count} jobs", { count: filtered.length })}</span>
      </div>
    </section>
    <section className="ds-section">
      <div className="ds-table-wrap">
        <table className="ds-table pw-runs-table">
          <caption className="sr-only">{t("Review queue")}</caption>
          <thead><tr><th scope="col">{t("Repository / PR")}</th><th scope="col">{t("Status")}</th><th scope="col">{t("Risk")}</th><th scope="col">{t("Findings")}</th><th scope="col">{t("Commit range")}</th><th scope="col">{t("Created")}</th></tr></thead>
          <tbody>{filtered.map(job => {
            const baseDisplay = job.baseSha.slice(0, 7);
            const headDisplay = job.headSha.slice(0, 7);
            return <tr key={job.id}>
              <td>
                <button className="semantic-row-open" type="button" onClick={() => onOpenJob(job)}>
                  <strong>{job.repositoryFullName}</strong>
                  <small>{job.pullRequestNumber === undefined ? t("Local repository") : `PR #${job.pullRequestNumber}`}</small>
                </button>
              </td>
              <td><StatusBadge value={job.status} /></td>
              <td>{job.report ? <StatusBadge value={job.report.riskLevel} /> : "-"}</td>
              <td>{job.report?.findings.length ?? "-"}</td>
              <td className="commit-range"><code>{baseDisplay} → {headDisplay}</code></td>
              <td>{new Date(job.createdAt).toLocaleDateString(locale)}</td>
            </tr>;
          })}</tbody>
        </table>
        {filtered.length === 0 && <div className="ds-empty ds-empty--slim" role="status"><p className="ds-empty-text">{t("No review jobs match these filters.")}</p></div>}
      </div>
    </section>
  </div>;
}
