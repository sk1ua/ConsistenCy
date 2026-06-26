import type { JobStatus, ReviewJob, Severity } from "@consistency/schema";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { StatusBadge } from "../components/StatusBadge";

export function JobsPage({ jobs, onOpenJob }: { jobs: ReviewJob[]; onOpenJob: (job: ReviewJob) => void }) {
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
      <label className="search-field"><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search repository or PR" /></label>
      <select value={status} onChange={event => setStatus(event.target.value as JobStatus | "")} aria-label="Filter by status">
        <option value="">All statuses</option><option value="queued">Queued</option><option value="running">Running</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option>
      </select>
      <select value={severity} onChange={event => setSeverity(event.target.value as Severity | "")} aria-label="Filter by severity">
        <option value="">All severities</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="info">Info</option>
      </select>
      <span className="result-count">{filtered.length} jobs</span>
    </div>
    <div className="data-table jobs-table">
      <div className="table-row table-head"><span>Repository / PR</span><span>Status</span><span>Risk</span><span>Findings</span><span>Commit range</span><span>Created</span></div>
      {filtered.map(job => <button className="table-row" key={job.id} type="button" onClick={() => onOpenJob(job)}>
        <span><strong>{job.repositoryFullName}</strong><small>PR #{job.pullRequestNumber}</small></span>
        <span><StatusBadge value={job.status} /></span>
        <span>{job.report ? <StatusBadge value={job.report.riskLevel} /> : "-"}</span>
        <span>{job.report?.findings.length ?? "-"}</span>
        <span className="commit-range">{job.baseSha.slice(0, 7)}..{job.headSha.slice(0, 7)}</span>
        <span>{new Date(job.createdAt).toLocaleDateString()}</span>
      </button>)}
      {filtered.length === 0 && <div className="empty-state">No review jobs match these filters.</div>}
    </div>
  </section>;
}
