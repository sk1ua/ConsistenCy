import type { ReviewJob, ReviewReport } from "@consistency/schema";
import { ArrowLeft, BookOpenText, FileSearch2, GitBranch, LoaderCircle, ShieldCheck, Sparkles } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AgentRuns } from "../components/AgentRuns";
import { DiffViewer } from "../components/DiffViewer";
import { EvidencePanel } from "../components/EvidencePanel";
import { FindingItem } from "../components/FindingItem";
import { StatusBadge } from "../components/StatusBadge";
import { useJobDiff } from "../hooks/useJobDiff";
import { useI18n } from "../i18n";
import { nextTabId } from "../utils/tabNavigation";
import { bindReportToJob } from "./reportIntegrity";

const NotebookPanel = lazy(() => import("../components/NotebookPanel").then(module => ({ default: module.NotebookPanel })));

type WorkspaceView = "notebook" | "report" | "diff";
type DetailView = "evidence" | "decision" | "agents";

const DETAIL_TABS: readonly DetailView[] = ["evidence", "decision", "agents"];

function focusTab(id: string): void {
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => document.getElementById(id)?.focus());
}

function DecisionPanel({ report }: { report: ReviewReport }) {
  const { t } = useI18n();
  return <div className="decision-panel">
    <div className="decision-brief">
      <span>{t("Decision")}</span>
      <div><StatusBadge value={report.riskLevel} /><strong>{report.score}</strong><small>{t("quality score")}</small></div>
      <p>{report.summary}</p>
    </div>
    <div className="decision-findings">
      <h3>{t("Recommendation")} <span>{report.findings.length}</span></h3>
      {report.findings.length === 0 ? <div className="empty-inline">{t("No findings were reported.")}</div> : report.findings.map(finding => <article key={finding.id}>
        <StatusBadge value={finding.severity} />
        <div><strong>{finding.title}</strong><p>{finding.recommendation}</p></div>
      </article>)}
    </div>
  </div>;
}

export function ReportPage({ job, report, notebookId, llmProvider, llmModel, onBack }: {
  job?: ReviewJob;
  report?: ReviewReport;
  notebookId?: string;
  llmProvider?: string;
  llmModel?: string;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [groupBy, setGroupBy] = useState<"severity" | "agent">("severity");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(notebookId ? "notebook" : "report");
  const [detailView, setDetailView] = useState<DetailView>("evidence");
  const [diffFocus, setDiffFocus] = useState<{ file: string; line?: number }>();
  const previousSourceRef = useRef({ jobId: job?.id, notebookId });
  const tabScope = useId();
  const diffState = useJobDiff(job?.id);

  useEffect(() => {
    const previous = previousSourceRef.current;
    previousSourceRef.current = { jobId: job?.id, notebookId };
    if (previous.jobId !== job?.id) {
      setWorkspaceView("report");
      setDiffFocus(undefined);
      return;
    }
    if (notebookId && notebookId !== previous.notebookId) setWorkspaceView("notebook");
  }, [job?.id, notebookId]);

  const binding = useMemo(() => job ? bindReportToJob(job, report) : { status: "missing" as const }, [job, report]);
  const boundReport = binding.status === "bound" ? binding.report : undefined;
  const diffAvailable = Boolean(job && diffState.status === "available" && diffState.jobId === job.id);
  const diffFiles = diffState.status === "available" && diffState.jobId === job?.id ? diffState.files : [];
  const activeWorkspaceView: WorkspaceView = workspaceView === "diff" && !diffAvailable
    ? "report"
    : workspaceView === "notebook" && !notebookId ? "report" : workspaceView;
  const workspaceTabs = useMemo<WorkspaceView[]>(() => {
    const tabs: WorkspaceView[] = [];
    if (notebookId) tabs.push("notebook");
    if (diffAvailable) tabs.push("diff");
    tabs.push("report");
    return tabs;
  }, [diffAvailable, notebookId]);
  const groups = useMemo(() => {
    if (!boundReport) return [];
    const map = new Map<string, typeof boundReport.findings>();
    for (const finding of boundReport.findings) {
      const key = groupBy === "severity" ? finding.severity : finding.agent;
      const current = map.get(key);
      if (current) current.push(finding);
      else map.set(key, [finding]);
    }
    return [...map.entries()];
  }, [boundReport, groupBy]);

  function handleWorkspaceKey(event: KeyboardEvent<HTMLButtonElement>, current: WorkspaceView): void {
    const next = nextTabId(workspaceTabs, current, event.key);
    if (!next) return;
    event.preventDefault();
    setWorkspaceView(next);
    focusTab(`${tabScope}-workspace-tab-${next}`);
  }

  function handleDetailKey(event: KeyboardEvent<HTMLButtonElement>, current: DetailView): void {
    const next = nextTabId(DETAIL_TABS, current, event.key);
    if (!next) return;
    event.preventDefault();
    setDetailView(next);
    focusTab(`${tabScope}-detail-tab-${next}`);
  }

  if (!job) return <div className="empty-state">{t("Select a review job to inspect its report.")}</div>;

  const workspacePanelId = `${tabScope}-workspace-panel-${activeWorkspaceView}`;
  return <div className="page-stack report-page report-workspace">
    <button className="text-button report-back" type="button" onClick={onBack}><ArrowLeft size={17} />{t("Back to jobs")}</button>
    {binding.status === "mismatch" ? <div className="report-integrity-alert" role="alert">
      <ShieldCheck size={18} /><span><strong>Report integrity check failed.</strong> The report does not belong to the selected job and has been withheld.</span>
    </div> : null}
    {diffState.status === "error" && diffState.jobId === job.id ? <div className="report-integrity-alert" role="alert">
      <FileSearch2 size={18} /><span><strong>{t("Diff")}</strong> {diffState.message}</span>
    </div> : null}
    {diffState.status === "loading" && diffState.jobId === job.id ? <div className="report-live-status" role="status" aria-live="polite">
      <LoaderCircle className="spinning" size={15} />{t("Diff")} · {t("Loading review workspace")}
    </div> : null}
    <section className="report-header">
      <div><span className="report-repo">{job.repositoryFullName}</span><h2>{job.pullRequestNumber === undefined ? t("Local repository review") : t("Pull request #{number}", { number: job.pullRequestNumber })}</h2><p aria-live="polite">{boundReport?.summary ?? job.error ?? t("Review is still in progress.")}</p></div>
      <div className="report-score"><strong>{boundReport?.score ?? "-"}</strong><span>{t("quality score")}</span>{boundReport ? <StatusBadge value={boundReport.riskLevel} /> : null}</div>
    </section>
    <section className="report-meta">
      <div><GitBranch size={17} /><span>{t("Base")}</span><code>{job.baseSha.slice(0, 12)}</code></div>
      <div><GitBranch size={17} /><span>{t("Head")}</span><code>{job.headSha.slice(0, 12)}</code></div>
      <div><ShieldCheck size={17} /><span>{t("Status")}</span><StatusBadge value={job.status} /></div>
      <div><span>{t("Findings")}</span><strong>{boundReport?.findings.length ?? 0}</strong></div>
      <div><Sparkles size={17} /><span>{t("LLM")}</span><code>{llmProvider ?? t("unavailable")}{llmModel ? ` / ${llmModel}` : ""}</code></div>
      <div><span>{t("Source")}</span><span className={`badge ${job.accessMode === "public_read" ? "badge-public-read" : "badge-queued"}`}>{job.accessMode === "public_read" ? t("PUBLIC READ-ONLY") : job.accessMode === "local_git" ? t("Local repository review") : t("GitHub App")}</span></div>
      <div><span>{t("Publication")}</span><span className="badge badge-queued">{job.publicationPolicy === "disabled" ? t("analysis only") : t("GitHub comment")}</span></div>
    </section>
    {workspaceTabs.length > 1 ? <div className="workspace-mode-bar">
      <div className="workspace-mode-tabs" role="tablist" aria-label={t("Review workspace view")}>
        {workspaceTabs.map(tab => {
          const selected = activeWorkspaceView === tab;
          const label = tab === "notebook" ? t("Notebook workspace") : tab === "diff" ? t("Diff") : t("Review report");
          const Icon = tab === "notebook" ? BookOpenText : FileSearch2;
          return <button
            id={`${tabScope}-workspace-tab-${tab}`}
            key={tab}
            type="button"
            role="tab"
            className={selected ? "active" : ""}
            aria-selected={selected}
            aria-controls={`${tabScope}-workspace-panel-${tab}`}
            tabIndex={selected ? 0 : -1}
            onKeyDown={event => handleWorkspaceKey(event, tab)}
            onClick={() => setWorkspaceView(tab)}
          ><Icon size={16} />{label}</button>;
        })}
      </div>
      <span className="workspace-mode-note"><Sparkles size={14} />{t("LLM dialogue, deterministic evidence")}</span>
    </div> : null}
    <section
      id={workspacePanelId}
      role={workspaceTabs.length > 1 ? "tabpanel" : "region"}
      aria-labelledby={workspaceTabs.length > 1 ? `${tabScope}-workspace-tab-${activeWorkspaceView}` : undefined}
      aria-label={workspaceTabs.length === 1 ? t("Review report") : undefined}
      tabIndex={0}
      className="report-workspace-panel"
    >
      {activeWorkspaceView === "diff"
        ? <DiffViewer files={diffFiles} findings={boundReport?.findings ?? []} focus={diffFocus} />
        : activeWorkspaceView === "notebook" && notebookId
          ? <Suspense fallback={<div className="loading-state" role="status" aria-live="polite"><LoaderCircle className="spinning" size={22} /><span>{t("Loading review workspace")}</span></div>}><NotebookPanel notebookId={notebookId} /></Suspense>
          : <div className="report-ide">
            <aside className="report-findings-pane" aria-label={t("Findings")}>
              <div className="pane-heading">
                <div className="section-heading"><div><h2>{t("Findings")}</h2><p>{t("Evidence, reasoning and concrete remediation")}</p></div></div>
                <div className="segmented" role="group" aria-label={t("Findings")}>
                  <button type="button" aria-pressed={groupBy === "severity"} className={groupBy === "severity" ? "active" : ""} onClick={() => setGroupBy("severity")}>{t("Severity")}</button>
                  <button type="button" aria-pressed={groupBy === "agent"} className={groupBy === "agent" ? "active" : ""} onClick={() => setGroupBy("agent")}>{t("Agent")}</button>
                </div>
              </div>
              <div className="pane-scroll report-findings-tree">
                {!boundReport ? <div className="empty-state">{t("The report will appear when the review worker finishes.")}</div>
                  : groups.length === 0 ? <div className="empty-inline">{t("No findings were reported.")}</div>
                    : groups.map(([group, findings]) => <section className="finding-group" key={group}>
                      <h3>{t(group)}<span>{findings.length}</span></h3>{findings.map(finding => <FindingItem
                        finding={finding}
                        key={finding.id}
                        onLocate={diffAvailable ? (file, line) => { setDiffFocus({ file, line }); setWorkspaceView("diff"); } : undefined}
                      />)}
                    </section>)}
              </div>
            </aside>
            <section className="report-center report-inspector" aria-label={t("Review report")}>
              <div className="report-detail-tabs" role="tablist" aria-label={t("Review report")}>
                {DETAIL_TABS.map(tab => {
                  const selected = detailView === tab;
                  const label = tab === "evidence" ? t("Evidence") : tab === "decision" ? t("Decision") : t("Agent runs");
                  return <button
                    id={`${tabScope}-detail-tab-${tab}`}
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`${tabScope}-detail-panel-${tab}`}
                    tabIndex={selected ? 0 : -1}
                    className={selected ? "active" : ""}
                    onKeyDown={event => handleDetailKey(event, tab)}
                    onClick={() => setDetailView(tab)}
                  >{label}</button>;
                })}
              </div>
              <div
                id={`${tabScope}-detail-panel-${detailView}`}
                role="tabpanel"
                aria-labelledby={`${tabScope}-detail-tab-${detailView}`}
                tabIndex={0}
                className="report-detail-panel"
              >
                {!boundReport ? <div className="empty-state" role="status" aria-live="polite">{t("The report will appear when the review worker finishes.")}</div>
                  : detailView === "evidence" ? <EvidencePanel retrieval={boundReport.retrieval} />
                    : detailView === "decision" ? <DecisionPanel report={boundReport} />
                      : <AgentRuns runs={boundReport.agentRuns} />}
              </div>
            </section>
          </div>}
    </section>
  </div>;
}
