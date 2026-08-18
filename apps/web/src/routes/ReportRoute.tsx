import { lazy, Suspense, useId, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, NavLink, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { ReviewJob, ReviewReport } from "@consistency/schema";
import { DiffViewer } from "../components/DiffViewer";
import { EvidencePanel } from "../components/EvidencePanel";
import { FindingItem } from "../components/FindingItem";
import { useJobDiff } from "../hooks/useJobDiff";
import { api, type HealthResponse } from "../api/client";
import { ReportPage } from "../pages/ReportPage";
import { workspaceQueryKeys } from "../query/client";
import { safeRequestError } from "../query/safeRequestError";
import { useI18n } from "../i18n";
import { nextTabId } from "../utils/tabNavigation";

const REPORT_STATUSES = new Set<ReviewJob["status"]>(["awaiting_publish", "publishing", "succeeded", "publish_failed"]);
const NotebookPanel = lazy(() => import("../components/NotebookPanel").then(module => ({ default: module.NotebookPanel })));
const RuntimePanel = lazy(() => import("../components/runtime/RuntimePanel").then(module => ({ default: module.RuntimePanel })));
type RunMode = "overview" | "diff" | "evidence" | "notebook" | "runtime";

export function runModeFromPath(pathname: string): RunMode {
  const segment = pathname.split("/").filter(Boolean).at(-1);
  return segment === "diff" || segment === "evidence" || segment === "notebook" || segment === "runtime" ? segment : "overview";
}

function RunModeTabs({ runId, mode, notebookId, zh, scope }: { runId: string; mode: RunMode; notebookId?: string; zh: boolean; scope: string }) {
  const navigate = useNavigate();
  const suffix = notebookId ? `?notebook=${encodeURIComponent(notebookId)}` : "";
  const tabs: Array<{ id: RunMode; label: string }> = [
    { id: "overview", label: zh ? "概览" : "Overview" },
    { id: "diff", label: zh ? "差异" : "Diff" },
    { id: "evidence", label: zh ? "证据" : "Evidence" },
    { id: "notebook", label: zh ? "笔记本" : "Notebook" },
    { id: "runtime", label: zh ? "运行" : "Runtime" }
  ];
  function destination(id: RunMode): string {
    return `/runs/${encodeURIComponent(runId)}/${id}${id === "notebook" ? suffix : ""}`;
  }

  function handleKey(event: KeyboardEvent<HTMLAnchorElement>, current: RunMode) {
    const next = nextTabId(tabs.map(tab => tab.id), current, event.key);
    if (!next) return;
    event.preventDefault();
    navigate(destination(next));
    window.requestAnimationFrame(() => document.getElementById(`${scope}-run-tab-${next}`)?.focus());
  }

  return <nav className="run-mode-tabs" role="tablist" aria-label={zh ? "运行视图" : "Run views"} aria-orientation="horizontal">{tabs.map(tab => <NavLink
    id={`${scope}-run-tab-${tab.id}`}
    key={tab.id}
    role="tab"
    aria-selected={mode === tab.id}
    aria-controls={`${scope}-run-panel`}
    tabIndex={mode === tab.id ? 0 : -1}
    className={mode === tab.id ? "active" : ""}
    to={destination(tab.id)}
    onKeyDown={event => handleKey(event, tab.id)}
  >{tab.label}</NavLink>)}</nav>;
}

function DiffMode({ job, report, zh }: { job?: ReviewJob; report?: ReviewReport; zh: boolean }) {
  const state = useJobDiff(job?.id);
  if (!job) return <div className="empty-state">{zh ? "请选择一个审计运行。" : "Select an audit run."}</div>;
  if (state.status === "idle" || state.status === "loading") return <div className="loading-state">{zh ? "正在加载差异" : "Loading diff"}</div>;
  if (state.status === "error") return <div className="route-query-notice" role="status"><strong>{zh ? "无法加载差异" : "Could not load diff"}</strong><span>{safeRequestError(new Error(state.message))}</span></div>;
  if (state.status === "unavailable") return <div className="empty-state">{zh ? "此运行没有可用差异。" : "No diff is available for this run."}</div>;
  return <DiffViewer files={state.files} findings={report?.findings ?? []} />;
}

function EvidenceMode({ report, zh }: { report?: ReviewReport; zh: boolean }) {
  if (!report) return <div className="empty-state">{zh ? "此运行尚无可验证报告证据。" : "No verifiable report evidence is available for this run yet."}</div>;
  return <div className="run-evidence-mode page-stack"><EvidencePanel retrieval={report.retrieval} /><section className="section-block run-evidence-findings"><div className="panel-title"><div><span className="panel-kicker">{zh ? "已记录的报告输出" : "Recorded report output"}</span><h2>{zh ? "报告发现" : "Report findings"}</h2></div><strong>{report.findings.length}</strong></div>{report.findings.length === 0 ? <div className="empty-inline">{zh ? "报告没有发现。" : "No findings were reported."}</div> : report.findings.map(finding => <FindingItem key={finding.id} finding={finding} />)}</section></div>;
}

export function ReportRoute({ jobs, reports, health, jobsUnavailable, reportsUnavailable, onSelectAgent, selectedAgentId }: {
  jobs: ReviewJob[];
  reports: ReviewReport[];
  health?: HealthResponse;
  jobsUnavailable: boolean;
  reportsUnavailable: boolean;
  onSelectAgent?: (agent: import("@consistency/schema").AgentRuntimeSnapshot) => void;
  selectedAgentId?: string;
}) {
  const { jobId = "", runId = "" } = useParams();
  const selectedRunId = runId || jobId;
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { locale } = useI18n();
  const tabScope = useId();
  const zh = locale === "zh-CN";
  const mode = runModeFromPath(location.pathname);
  const listJob = jobs.find(job => job.id === selectedRunId);
  const jobQuery = useQuery({
    queryKey: workspaceQueryKeys.job(selectedRunId),
    queryFn: ({ signal }) => api.job(selectedRunId, signal),
    enabled: Boolean(selectedRunId) && listJob === undefined
  });
  const job = listJob ?? jobQuery.data;
  const listReport = job?.report ?? reports.find(report => report.jobId === selectedRunId);
  const reportQuery = useQuery({
    queryKey: workspaceQueryKeys.report(selectedRunId),
    queryFn: ({ signal }) => api.report(selectedRunId, signal),
    enabled: Boolean(mode !== "notebook" && selectedRunId && job && REPORT_STATUSES.has(job.status) && !listReport)
  });
  const notebookQuery = useQuery({
    queryKey: workspaceQueryKeys.notebook(selectedRunId),
    queryFn: ({ signal }) => api.jobNotebook(selectedRunId, signal),
    enabled: Boolean(selectedRunId) && mode === "notebook"
  });

  if (!selectedRunId) {
    const firstReport = reports.find(report => jobs.some(jobItem => jobItem.id === report.jobId));
    const matchingJob = firstReport ? jobs.find(jobItem => jobItem.id === firstReport.jobId) : jobs.find(jobItem => jobItem.report);
    if (matchingJob) return <Navigate replace to={`/runs/${encodeURIComponent(matchingJob.id)}/overview`} />;
  }

  const errors = [
    jobsUnavailable ? (zh ? "审查队列不可用" : "Review queue unavailable") : undefined,
    reportsUnavailable ? (zh ? "最近报告不可用" : "Recent reports unavailable") : undefined,
    jobQuery.error ? safeRequestError(jobQuery.error) : undefined,
    reportQuery.error ? safeRequestError(reportQuery.error) : undefined,
    notebookQuery.error ? safeRequestError(notebookQuery.error) : undefined
  ].filter((value): value is string => Boolean(value));
  const notebookId = mode === "notebook" ? searchParams.get("notebook") ?? notebookQuery.data ?? undefined : undefined;
  const verifiedReport = (listReport ?? reportQuery.data)?.jobId === job?.id ? (listReport ?? reportQuery.data) : undefined;

  return <>
    {errors.length > 0 && <div className="route-query-notice" role="status"><strong>{zh ? "部分审查数据暂不可用" : "Some review data is unavailable"}</strong><span>{[...new Set(errors)].join(" · ")}</span></div>}
    {selectedRunId && <RunModeTabs runId={selectedRunId} mode={mode} notebookId={notebookId} zh={zh} scope={tabScope} />}
    <div id={`${tabScope}-run-panel`} role="tabpanel" aria-labelledby={`${tabScope}-run-tab-${mode}`} tabIndex={0}>
      {mode === "overview" ? <ReportPage
        job={job}
        report={verifiedReport}
        notebookId={notebookId}
        llmProvider={health?.llmProvider}
        llmModel={health?.llmModel}
        onBack={() => navigate(job?.repositoryFullName ? `/repositories/${encodeURIComponent(job.repositoryFullName)}` : "/runs")}
      /> : <div className="run-mode-route">
        {mode === "diff" ? <DiffMode job={job} report={verifiedReport} zh={zh} />
          : mode === "evidence" ? <EvidenceMode report={verifiedReport} zh={zh} />
            : mode === "runtime" ? <Suspense fallback={<div className="loading-state">{zh ? "正在加载运行架构" : "Loading runtime"}</div>}><RuntimePanel runId={selectedRunId} job={job} report={verifiedReport} onSelectAgent={onSelectAgent} selectedAgentId={selectedAgentId} /></Suspense>
              : notebookQuery.isFetching && !notebookId ? <div className="loading-state">{zh ? "正在加载笔记本" : "Loading notebook"}</div>
                : <Suspense fallback={<div className="loading-state">{zh ? "正在加载笔记本" : "Loading notebook"}</div>}><NotebookPanel notebookId={notebookId} /></Suspense>}
      </div>}
    </div>
  </>;
}
