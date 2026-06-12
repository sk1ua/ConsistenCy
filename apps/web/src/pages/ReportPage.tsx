import type { ReviewJob, ReviewReport } from "@consistency/schema";
import { ArrowLeft, GitBranch, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentRuns } from "../components/AgentRuns";
import { FindingItem } from "../components/FindingItem";
import { StatusBadge } from "../components/StatusBadge";

export function ReportPage({ job, report, onBack }: { job?: ReviewJob; report?: ReviewReport; onBack: () => void }) {
  const [groupBy, setGroupBy] = useState<"severity" | "agent">("severity");
  const groups = useMemo(() => {
    if (!report) return [];
    const map = new Map<string, typeof report.findings>();
    for (const finding of report.findings) {
      const key = groupBy === "severity" ? finding.severity : finding.agent;
      map.set(key, [...(map.get(key) ?? []), finding]);
    }
    return [...map.entries()];
  }, [report, groupBy]);

  if (!job) return <div className="empty-state">Select a review job to inspect its report.</div>;
  return <div className="page-stack report-page">
    <button className="text-button" type="button" onClick={onBack}><ArrowLeft size={17} />Back to jobs</button>
    <section className="report-header">
      <div><span className="report-repo">{job.repositoryFullName}</span><h2>Pull request #{job.pullRequestNumber}</h2><p>{report?.summary ?? job.error ?? "Review is still in progress."}</p></div>
      <div className="report-score"><strong>{report?.score ?? "-"}</strong><span>quality score</span>{report && <StatusBadge value={report.riskLevel} />}</div>
    </section>
    <section className="report-meta">
      <div><GitBranch size={17} /><span>Base</span><code>{job.baseSha.slice(0, 12)}</code></div>
      <div><GitBranch size={17} /><span>Head</span><code>{job.headSha.slice(0, 12)}</code></div>
      <div><ShieldCheck size={17} /><span>Status</span><StatusBadge value={job.status} /></div>
      <div><span>Findings</span><strong>{report?.findings.length ?? 0}</strong></div>
    </section>
    {!report ? <div className="empty-state">The report will appear when the review worker finishes.</div> : <>
      <section className="section-block">
        <div className="section-heading"><div><h2>Findings</h2><p>Evidence, reasoning and concrete remediation</p></div>
          <div className="segmented"><button className={groupBy === "severity" ? "active" : ""} onClick={() => setGroupBy("severity")}>Severity</button><button className={groupBy === "agent" ? "active" : ""} onClick={() => setGroupBy("agent")}>Agent</button></div>
        </div>
        {groups.length === 0 ? <div className="empty-inline">No findings were reported.</div> : groups.map(([group, findings]) => <div className="finding-group" key={group}>
          <h3>{group}<span>{findings.length}</span></h3>{findings.map(finding => <FindingItem finding={finding} key={finding.id} />)}
        </div>)}
      </section>
      <section className="section-block"><div className="section-heading"><div><h2>Agent runs</h2><p>Execution timeline and per-agent output</p></div></div><AgentRuns runs={report.agentRuns} /></section>
    </>}
  </div>;
}
