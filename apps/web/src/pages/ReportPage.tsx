import type { ReviewJob, ReviewReport } from "@consistency/schema";
import { ArrowLeft, GitBranch, ShieldCheck, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentRuns } from "../components/AgentRuns";
import { EvidencePanel } from "../components/EvidencePanel";
import { FindingItem } from "../components/FindingItem";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../i18n";
import { NotebookPanel } from "../components/NotebookPanel";

export function ReportPage({ job, report, notebookId, llmProvider, llmModel, onBack }: { job?: ReviewJob; report?: ReviewReport; notebookId?: string; llmProvider?: string; llmModel?: string; onBack: () => void }) {
  const { t } = useI18n();
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

  if (!job) return <div className="empty-state">{t("Select a review job to inspect its report.")}</div>;
  return <div className="report-workspace"><div className="page-stack report-page">
    <button className="text-button" type="button" onClick={onBack}><ArrowLeft size={17} />{t("Back to jobs")}</button>
    <section className="report-header">
      <div><span className="report-repo">{job.repositoryFullName}</span><h2>{t("Pull request #{number}", { number: job.pullRequestNumber })}</h2><p>{report?.summary ?? job.error ?? t("Review is still in progress.")}</p></div>
      <div className="report-score"><strong>{report?.score ?? "-"}</strong><span>{t("quality score")}</span>{report && <StatusBadge value={report.riskLevel} />}</div>
    </section>
    <section className="report-meta">
      <div><GitBranch size={17} /><span>{t("Base")}</span><code>{job.baseSha.slice(0, 12)}</code></div>
      <div><GitBranch size={17} /><span>{t("Head")}</span><code>{job.headSha.slice(0, 12)}</code></div>
      <div><ShieldCheck size={17} /><span>{t("Status")}</span><StatusBadge value={job.status} /></div>
      <div><span>{t("Findings")}</span><strong>{report?.findings.length ?? 0}</strong></div>
      <div><Sparkles size={17} /><span>{t("LLM")}</span><code>{llmProvider ?? t("unavailable")}{llmModel ? ` / ${llmModel}` : ""}</code></div>
      <div><span>{t("Source")}</span><span className={`badge ${job.accessMode === "public_read" ? "badge-public-read" : "badge-queued"}`}>{job.accessMode === "public_read" ? t("PUBLIC READ-ONLY") : t("GitHub App")}</span></div>
      <div><span>{t("Publication")}</span><span className="badge badge-queued">{job.publicationPolicy === "disabled" ? t("analysis only") : t("GitHub comment")}</span></div>
    </section>
    {!report ? <div className="empty-state">{t("The report will appear when the review worker finishes.")}</div> : <>
      <section className="section-block">
        <div className="section-heading"><div><h2>{t("Findings")}</h2><p>{t("Evidence, reasoning and concrete remediation")}</p></div>
          <div className="segmented"><button className={groupBy === "severity" ? "active" : ""} onClick={() => setGroupBy("severity")}>{t("Severity")}</button><button className={groupBy === "agent" ? "active" : ""} onClick={() => setGroupBy("agent")}>{t("Agent")}</button></div>
        </div>
        {groups.length === 0 ? <div className="empty-inline">{t("No findings were reported.")}</div> : groups.map(([group, findings]) => <div className="finding-group" key={group}>
          <h3>{t(group)}<span>{findings.length}</span></h3>{findings.map(finding => <FindingItem finding={finding} key={finding.id} />)}
        </div>)}
      </section>
      <EvidencePanel retrieval={report.retrieval} />
      <section className="section-block"><div className="section-heading"><div><h2>{t("Agent runs")}</h2><p>{t("Execution timeline and per-agent output")}</p></div></div><AgentRuns runs={report.agentRuns} /></section>
    </>}
  </div><NotebookPanel notebookId={notebookId} /></div>;
}
