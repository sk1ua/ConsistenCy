import type { ReviewJob, ReviewReport } from "@consistency/schema";
import type { VcsChangedFile } from "@consistency/schema";
import { ArrowLeft, BookOpenText, FileSearch2, GitBranch, LoaderCircle, ShieldCheck, Sparkles } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { AgentRuns } from "../components/AgentRuns";
import { DiffViewer } from "../components/DiffViewer";
import { EvidencePanel } from "../components/EvidencePanel";
import { FindingItem } from "../components/FindingItem";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../i18n";

const NotebookPanel = lazy(() => import("../components/NotebookPanel").then(module => ({ default: module.NotebookPanel })));

export function ReportPage({ job, report, notebookId, llmProvider, llmModel, onBack }: { job?: ReviewJob; report?: ReviewReport; notebookId?: string; llmProvider?: string; llmModel?: string; onBack: () => void }) {
  const { t } = useI18n();
  const [groupBy, setGroupBy] = useState<"severity" | "agent">("severity");
  const [workspaceView, setWorkspaceView] = useState<"notebook" | "report" | "diff">(notebookId ? "notebook" : "report");
  const [diffFiles, setDiffFiles] = useState<VcsChangedFile[] | null | undefined>();
  const [diffFocus, setDiffFocus] = useState<{ file: string; line?: number }>();
  const hasNotebookRef = useRef(Boolean(notebookId));
  useEffect(() => {
    // notebookId 异步到达（从 Jobs 列表打开 job 时）自动切到 Notebook 视图
    if (notebookId && !hasNotebookRef.current) {
      hasNotebookRef.current = true;
      setWorkspaceView("notebook");
    }
  }, [notebookId]);
  useEffect(() => {
    let cancelled = false;
    setDiffFiles(undefined);
    setDiffFocus(undefined);
    if (!job) {
      setDiffFiles(null);
      return;
    }
    api.jobDiff(job.id)
      .then(response => { if (!cancelled) setDiffFiles(response.available ? response.files : null); })
      .catch(() => { if (!cancelled) setDiffFiles(null); });
    return () => { cancelled = true; };
  }, [job?.id]);
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
  const diffAvailable = diffFiles !== null;
  return <div className="page-stack report-page report-workspace">
    <button className="text-button report-back" type="button" onClick={onBack}><ArrowLeft size={17} />{t("Back to jobs")}</button>
    <section className="report-header">
      <div><span className="report-repo">{job.repositoryFullName}</span><h2>{job.pullRequestNumber === undefined ? t("Local repository review") : t("Pull request #{number}", { number: job.pullRequestNumber })}</h2><p>{report?.summary ?? job.error ?? t("Review is still in progress.")}</p></div>
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
    {(notebookId || diffAvailable) && <div className="workspace-mode-bar" aria-label={t("Review workspace view")}>
      <div className="workspace-mode-tabs">
        {notebookId && <button type="button" className={workspaceView === "notebook" ? "active" : ""} aria-pressed={workspaceView === "notebook"} onClick={() => setWorkspaceView("notebook")}><BookOpenText size={16} />{t("Notebook workspace")}</button>}
        {diffAvailable && <button type="button" className={workspaceView === "diff" ? "active" : ""} aria-pressed={workspaceView === "diff"} onClick={() => setWorkspaceView("diff")}><FileSearch2 size={16} />{t("Diff")}</button>}
        <button type="button" className={workspaceView === "report" ? "active" : ""} aria-pressed={workspaceView === "report"} onClick={() => setWorkspaceView("report")}><FileSearch2 size={16} />{t("Review report")}</button>
      </div>
      <span className="workspace-mode-note"><Sparkles size={14} />{t("LLM dialogue, deterministic evidence")}</span>
    </div>}
    {workspaceView === "diff"
      ? <DiffViewer files={diffFiles ?? []} findings={report?.findings ?? []} focus={diffFocus} />
      : workspaceView === "notebook" && notebookId
      ? <Suspense fallback={<div className="loading-state"><LoaderCircle className="spinning" size={22} /><span>{t("Loading review workspace")}</span></div>}><NotebookPanel notebookId={notebookId} /></Suspense>
      : <div className="report-ide">
        <aside className="report-findings-pane" aria-label={t("Findings")}>
          <div className="pane-heading">
            <div className="section-heading"><div><h2>{t("Findings")}</h2><p>{t("Evidence, reasoning and concrete remediation")}</p></div></div>
            <div className="segmented"><button className={groupBy === "severity" ? "active" : ""} onClick={() => setGroupBy("severity")}>{t("Severity")}</button><button className={groupBy === "agent" ? "active" : ""} onClick={() => setGroupBy("agent")}>{t("Agent")}</button></div>
          </div>
          <div className="pane-scroll">
            {!report ? <div className="empty-state">{t("The report will appear when the review worker finishes.")}</div>
              : groups.length === 0 ? <div className="empty-inline">{t("No findings were reported.")}</div>
              : groups.map(([group, findings]) => <div className="finding-group" key={group}>
                <h3>{t(group)}<span>{findings.length}</span></h3>{findings.map(finding => <FindingItem finding={finding} key={finding.id} onLocate={(file, line) => { setDiffFocus({ file, line }); setWorkspaceView("diff"); }} />)}
              </div>)}
          </div>
        </aside>
        <div className="report-center">
          {!report ? <div className="empty-state">{t("The report will appear when the review worker finishes.")}</div> : <EvidencePanel retrieval={report.retrieval} />}
        </div>
        <aside className="report-detail-pane" aria-label={t("Agent runs")}>
          <div className="pane-heading">
            <div className="section-heading"><div><h2>{t("Agent runs")}</h2><p>{t("Execution timeline and per-agent output")}</p></div></div>
          </div>
          <div className="pane-scroll">{report && <AgentRuns runs={report.agentRuns} />}</div>
        </aside>
      </div>}
  </div>;
}
