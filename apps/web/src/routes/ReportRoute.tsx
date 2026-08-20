import React, { lazy, Suspense, useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { ReviewJob, ReviewReport, AgentRuntimeSnapshot, ReviewFinding } from "@consistency/schema";
import {
  FileCode2,
  FileSearch2,
  PlayCircle,
  ShieldAlert,
  Cpu,
  Layers,
  Sparkles,
  GitBranch,
  GitCommit,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileDiff
} from "lucide-react";
import { DiffViewer } from "../components/DiffViewer";
import { EvidencePanel } from "../components/EvidencePanel";
import { FindingItem } from "../components/FindingItem";
import { useJobDiff } from "../hooks/useJobDiff";
import { api, type HealthResponse } from "../api/client";
import { ReportPage } from "../pages/ReportPage";
import { workspaceQueryKeys } from "../query/client";
import { safeRequestError } from "../query/safeRequestError";
import { useI18n } from "../i18n";
import { Tabs, type TabItem } from "../design-system/Tabs";
import { Badge } from "../design-system/Badge";
import { Button } from "../design-system/Button";
import { EmptyState } from "../design-system/EmptyState";
import { AppLink } from "../design-system/Link";

const REPORT_STATUSES = new Set<ReviewJob["status"]>(["awaiting_publish", "publishing", "succeeded", "publish_failed"]);
const NotebookPanel = lazy(() => import("../components/NotebookPanel").then(module => ({ default: module.NotebookPanel })));
const RuntimePanel = lazy(() => import("../components/runtime/RuntimePanel").then(module => ({ default: module.RuntimePanel })));

type RunMode = "overview" | "diff" | "evidence" | "notebook" | "runtime";

export function runModeFromPath(pathname: string): RunMode {
  const segment = pathname.split("/").filter(Boolean).at(-1);
  return segment === "diff" || segment === "evidence" || segment === "notebook" || segment === "runtime" ? segment : "overview";
}

function DiffMode({ job, report, zh, onSelectFinding }: { job?: ReviewJob; report?: ReviewReport; zh: boolean; onSelectFinding?: (f: ReviewFinding) => void }) {
  const state = useJobDiff(job?.id);
  if (!job) return <EmptyState title={zh ? "请选择一个审查运行。" : "Select an audit run."} />;
  if (state.status === "idle" || state.status === "loading") {
    return (
      <div style={{ padding: "48px", textAlign: "center", color: "var(--muted)" }}>
        <Loader2 size={24} className="ds-spin" style={{ margin: "0 auto 8px" }} />
        <div>{zh ? "正在加载代码变更差异..." : "Loading diff..."}</div>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div style={{ padding: "16px", background: "var(--danger-soft)", color: "var(--danger-strong)", borderRadius: "var(--ds-radius-md)" }}>
        <strong>{zh ? "无法加载差异: " : "Could not load diff: "}</strong>
        <span>{safeRequestError(new Error(state.message))}</span>
      </div>
    );
  }
  if (state.status === "unavailable") {
    return <EmptyState title={zh ? "此运行没有可用差异。" : "No diff is available for this run."} />;
  }
  return <DiffViewer files={state.files} findings={report?.findings ?? []} />;
}

function EvidenceMode({ report, zh, onSelectFinding }: { report?: ReviewReport; zh: boolean; onSelectFinding?: (f: ReviewFinding) => void }) {
  if (!report) {
    return <EmptyState title={zh ? "此运行尚无可验证报告证据。" : "No verifiable report evidence is available for this run yet."} />;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <EvidencePanel retrieval={report.retrieval} />
      <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--ds-radius-md)", padding: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>{zh ? "审查报告发现 (Report Findings)" : "Report findings"}</h3>
            <span style={{ fontSize: "12px", color: "var(--muted)" }}>已记录并关联证据的事实发现</span>
          </div>
          <Badge variant="primary" size="sm">
            {report.findings.length} 项
          </Badge>
        </div>
        {report.findings.length === 0 ? (
          <div style={{ padding: "16px", textAlign: "center", color: "var(--muted)", fontSize: "13px" }}>
            {zh ? "未发现代码问题。" : "No findings were reported."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {report.findings.map(finding => (
              <div key={finding.id} onClick={() => onSelectFinding?.(finding)} style={{ cursor: "pointer" }}>
                <FindingItem finding={finding} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function ReportRoute({
  jobs,
  reports,
  health,
  jobsUnavailable,
  reportsUnavailable,
  onSelectAgent,
  selectedAgentId
}: {
  jobs: ReviewJob[];
  reports: ReviewReport[];
  health?: HealthResponse;
  jobsUnavailable: boolean;
  reportsUnavailable: boolean;
  onSelectAgent?: (agent: AgentRuntimeSnapshot) => void;
  selectedAgentId?: string;
}) {
  const { jobId = "", runId = "" } = useParams();
  const selectedRunId = runId || jobId;
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { locale } = useI18n();
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

  const notebookId = mode === "notebook" ? searchParams.get("notebook") ?? notebookQuery.data ?? undefined : undefined;
  const verifiedReport = (listReport ?? reportQuery.data)?.jobId === job?.id ? (listReport ?? reportQuery.data) : undefined;

  const suffix = notebookId ? `?notebook=${encodeURIComponent(notebookId)}` : "";
  const navTabs: TabItem[] = [
    { id: "overview", label: "概览 (Overview)", icon: <Layers size={14} /> },
    { id: "diff", label: "差异 (Diff)", icon: <FileDiff size={14} /> },
    { id: "evidence", label: "证据 (Evidence)", count: verifiedReport?.findings.length, icon: <FileSearch2 size={14} /> },
    { id: "notebook", label: "记录本 (Notebook)", icon: <Sparkles size={14} /> },
    { id: "runtime", label: "运行时 (Runtime)", icon: <Cpu size={14} /> }
  ];

  const handleTabChange = (tabId: string) => {
    navigate(`/runs/${encodeURIComponent(selectedRunId)}/${tabId}${tabId === "notebook" ? suffix : ""}`);
  };

  return (
    <div style={{ padding: "20px 28px", maxWidth: "1280px", margin: "0 auto" }}>
      {/* Run Top Tabs Navigation */}
      <div style={{ marginBottom: "20px" }}>
        <Tabs tabs={navTabs} activeId={mode} onChange={handleTabChange} />
      </div>

      {/* Mode View Content */}
      <div>
        {mode === "overview" ? (
          <ReportPage
            job={job}
            report={verifiedReport}
            notebookId={notebookId}
            llmProvider={health?.llmProvider}
            llmModel={health?.llmModel}
            onBack={() => navigate(job?.repositoryFullName ? `/repositories/${encodeURIComponent(job.repositoryFullName)}` : "/runs")}
          />
        ) : mode === "diff" ? (
          <DiffMode job={job} report={verifiedReport} zh={zh} />
        ) : mode === "evidence" ? (
          <EvidenceMode report={verifiedReport} zh={zh} />
        ) : mode === "runtime" ? (
          <Suspense fallback={<div style={{ padding: "48px", textAlign: "center", color: "var(--muted)" }}><Loader2 size={24} className="ds-spin" style={{ margin: "0 auto 8px" }} /><div>正在加载运行架构...</div></div>}>
            <RuntimePanel
              runId={selectedRunId}
              job={job}
              report={verifiedReport}
              onSelectAgent={onSelectAgent}
              selectedAgentId={selectedAgentId}
            />
          </Suspense>
        ) : (
          <Suspense fallback={<div style={{ padding: "48px", textAlign: "center", color: "var(--muted)" }}><Loader2 size={24} className="ds-spin" style={{ margin: "0 auto 8px" }} /><div>正在加载记录本...</div></div>}>
            <NotebookPanel notebookId={notebookId} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
