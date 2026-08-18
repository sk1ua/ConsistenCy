import { lazy, Suspense, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentRuntimeSnapshot, ReviewJob, StatsResponse } from "@consistency/schema";
import { RefreshCw } from "lucide-react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "./api/client";
import { desktopBridge } from "./desktop";
import { useHeartbeat } from "./hooks/useHeartbeat";
import { useI18n } from "./i18n";
import { workspaceQueryKeys } from "./query/client";
import { safeRequestError } from "./query/safeRequestError";
import { useWorkspaceQueries } from "./query/useWorkspaceQueries";
import { routeMeta } from "./routes/meta";
import { AppShell, type DataNotice } from "./shell/AppShell";
import { useTheme } from "./theme";

const DashboardPage = lazy(() => import("./pages/DashboardPage").then(module => ({ default: module.DashboardPage })));
const JobsPage = lazy(() => import("./pages/JobsPage").then(module => ({ default: module.JobsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then(module => ({ default: module.SettingsPage })));
const WorkflowPage = lazy(() => import("./pages/WorkflowPage").then(module => ({ default: module.WorkflowPage })));
const RepositoriesPage = lazy(() => import("./routes/RepositoriesPage").then(module => ({ default: module.RepositoriesPage })));
const AutomationsPage = lazy(() => import("./routes/AutomationsPage").then(module => ({ default: module.AutomationsPage })));
const ReportRoute = lazy(() => import("./routes/ReportRoute").then(module => ({ default: module.ReportRoute })));
const FindingsPage = lazy(() => import("./routes/FindingsPage").then(module => ({ default: module.FindingsPage })));
const RepositoryDetailPage = lazy(() => import("./routes/RepositoryDetailPage").then(module => ({ default: module.RepositoryDetailPage })));

const EMPTY_STATS: StatsResponse = {
  totalJobs: 0,
  runningJobs: 0,
  succeededJobs: 0,
  failedJobs: 0,
  averageDuration: 0,
  riskDistribution: { low: 0, medium: 0, high: 0, critical: 0 },
  topRepositories: []
};

function RouteLoading({ label }: { label: string }) {
  return <div className="loading-state"><RefreshCw className="spinning" size={20} /><span>{label}</span></div>;
}

function RunIndexRedirect() {
  const { runId = "" } = useParams();
  const { search } = useLocation();
  return <Navigate replace to={`/runs/${encodeURIComponent(runId)}/overview${search}`} />;
}

function LegacyReportRedirect() {
  const { jobId = "" } = useParams();
  const { search } = useLocation();
  const mode = new URLSearchParams(search).has("notebook") ? "notebook" : "overview";
  return <Navigate replace to={`/runs/${encodeURIComponent(jobId)}/${mode}${search}`} />;
}

export function App() {
  const { locale, setLocale, t } = useI18n();
  const { preference, cycle: cycleTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queries = useWorkspaceQueries();
  const { pulse: heartbeatPulse, history: heartbeatHistory, unavailable: heartbeatUnavailable } = useHeartbeat();

  const jobs = queries.jobs.data ?? [];
  const reports = queries.reports.data ?? [];
  const stats = queries.stats.data ?? EMPTY_STATS;
  const health = queries.health.data;
  const repositories = queries.repositories.data ?? [];
  const automations = queries.automations.data ?? [];
  const meta = routeMeta(location.pathname, locale);
  const zh = locale === "zh-CN";
  const themeLabel = t(preference === "dark" ? "Dark" : preference === "light" ? "Light" : "System");
  const [selectedAgent, setSelectedAgent] = useState<AgentRuntimeSnapshot | undefined>();

  const inspectorContext = useMemo(() => {
    const match = location.pathname.match(/^\/runs\/([^/]+)/);
    if (match?.[1]) {
      let runId: string;
      try { runId = decodeURIComponent(match[1]); } catch { return undefined; }
      const job = jobs.find(candidate => candidate.id === runId);
      const embedded = job && job.report?.jobId === job.id ? job.report : undefined;
      const report = embedded ?? reports.find(candidate => candidate.jobId === job?.id);
      return { runId, ...(job ? { job } : {}), ...(report ? { report } : {}), ...(selectedAgent ? { agent: selectedAgent } : {}) };
    }
    return selectedAgent ? { agent: selectedAgent } : undefined;
  }, [jobs, location.pathname, reports, selectedAgent]);

  const analyzePublicPr = useMutation({
    mutationFn: (url: string) => api.analyzePublicPr(url),
    onSuccess: result => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
      navigate(`/runs/${encodeURIComponent(result.jobId)}/notebook?notebook=${encodeURIComponent(result.notebookId)}`);
    }
  });
  const selectRepository = useMutation({
    mutationFn: async () => {
      const bridge = desktopBridge();
      if (!bridge) throw new Error(zh ? "目录选择器仅在 Electron 桌面应用中可用" : "The folder picker is available only in the Electron desktop app");
      const result = await bridge.selectRepository();
      if (result.canceled) return null;
      if ("error" in result) throw new Error(result.error);
      return result.repository;
    },
    onSuccess: async repository => {
      if (!repository) return;
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.repositories });
    }
  });
  const setRepositoryMonitoring = useMutation({
    mutationFn: ({ repositoryId, enabled }: { repositoryId: string; enabled: boolean }) => api.setRepositoryMonitoring(repositoryId, enabled),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.repositories });
    }
  });
  const setAutomationEnabled = useMutation({
    mutationFn: ({ automationId, enabled }: { automationId: string; enabled: boolean }) => api.setAutomationEnabled(automationId, enabled),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.automations });
    }
  });

  async function submitPublicPr(url: string): Promise<void> {
    try {
      await analyzePublicPr.mutateAsync(url);
    } catch {
      // The mutation owns the route-local error state shown by DashboardPage.
    }
  }

  function openJob(job: ReviewJob) {
    navigate(`/runs/${encodeURIComponent(job.id)}/overview`);
  }

  const notices = useMemo<DataNotice[]>(() => {
    const visible: DataNotice[] = [];
    const add = (id: string, label: string, error: unknown) => visible.push({ id, label, message: safeRequestError(error) });
    const isOverview = location.pathname === "/" || location.pathname.startsWith("/inbox");
    const isRepositories = location.pathname.startsWith("/repositories");
    const isJobs = location.pathname === "/runs" || location.pathname.startsWith("/jobs");
    const isReports = /^\/(?:runs\/[^/]+|reports)/.test(location.pathname);
    const isSettings = location.pathname.startsWith("/settings");

    if ((isOverview || isRepositories || isJobs) && queries.jobs.error) {
      add("jobs", zh ? "审查队列暂不可用" : "Review queue unavailable", queries.jobs.error);
    }
    if (isOverview && queries.reports.error) {
      add("reports", zh ? "最近报告暂不可用" : "Recent reports unavailable", queries.reports.error);
    }
    if (isOverview && queries.stats.error) {
      add("stats", zh ? "统计数据暂不可用" : "Review statistics unavailable", queries.stats.error);
    }
    if ((isOverview || isRepositories || isReports || isSettings) && queries.health.error) {
      add("health", zh ? "运行状态暂不可用" : "Runtime status unavailable", queries.health.error);
    }
    return visible;
  }, [location.pathname, queries.health.error, queries.jobs.error, queries.reports.error, queries.stats.error, zh]);

  const firstLoad = queries.jobs.isPending || queries.reports.isPending || queries.stats.isPending;

  return <AppShell
    path={location.pathname}
    routeHref={`${location.pathname}${location.search}`}
    meta={meta}
    locale={locale}
    setLocale={setLocale}
    themePreference={preference}
    themeLabel={themeLabel}
    cycleTheme={cycleTheme}
    jobs={jobs}
    repositories={repositories}
    pulse={heartbeatPulse}
    health={health}
    healthUnavailable={queries.health.isError}
    inspectorContext={inspectorContext}
    notices={notices}
    refreshing={queries.isFetching}
    onRefresh={() => void queries.refresh()}
  >
    <Suspense fallback={<RouteLoading label={zh ? "正在加载工作台" : "Loading workspace"} />}>
      <Routes>
        <Route path="/" element={<Navigate replace to="/inbox" />} />
        <Route path="/inbox" element={firstLoad ? <RouteLoading label={zh ? "正在加载审查工作区" : "Loading review workspace"} /> : <DashboardPage
          stats={stats}
          jobs={jobs}
          reports={reports}
          onOpenJob={openJob}
          onOpenJobs={() => navigate("/runs")}
          onAnalyzePublicPr={submitPublicPr}
          publicPrAnalyzing={analyzePublicPr.isPending}
          publicPrError={analyzePublicPr.error ? safeRequestError(analyzePublicPr.error, zh ? "无法分析公开 PR" : "Could not analyze public PR") : undefined}
          publicPrAccessMode={health?.publicPrAccessMode}
          heartbeat={{ pulse: heartbeatPulse, history: heartbeatHistory, unavailable: heartbeatUnavailable }}
        />} />
        <Route path="/repositories" element={queries.jobs.isPending && queries.repositories.isPending ? <RouteLoading label={zh ? "正在加载仓库来源" : "Loading repository sources"} /> : <RepositoriesPage
          jobs={jobs}
          pulse={heartbeatPulse}
          heartbeatUnavailable={heartbeatUnavailable}
          jobsUnavailable={queries.jobs.isError}
          repositories={repositories}
          registryUnavailable={queries.repositories.isError}
          canSelectRepository={Boolean(desktopBridge())}
          addingRepository={selectRepository.isPending}
          addRepositoryError={selectRepository.error ? safeRequestError(selectRepository.error) : undefined}
          monitoringError={setRepositoryMonitoring.error ? safeRequestError(setRepositoryMonitoring.error) : undefined}
          onAddRepository={() => selectRepository.mutate()}
          monitoringRepositoryId={setRepositoryMonitoring.variables?.repositoryId}
          onSetMonitoring={(repository, enabled) => setRepositoryMonitoring.mutate({ repositoryId: repository.id, enabled })}
        />} />
        <Route path="/repositories/:repositoryId/*" element={queries.jobs.isPending && queries.repositories.isPending ? <RouteLoading label={zh ? "正在加载仓库来源" : "Loading repository source"} /> : <RepositoryDetailPage jobs={jobs} repositories={repositories} automations={automations} pulse={heartbeatPulse} />} />
        <Route path="/runs" element={queries.jobs.isPending ? <RouteLoading label={zh ? "正在加载审查队列" : "Loading review queue"} /> : <JobsPage jobs={jobs} onOpenJob={openJob} />} />
        <Route path="/runs/:runId" element={<RunIndexRedirect />} />
        <Route path="/runs/:runId/overview" element={<ReportRoute jobs={jobs} reports={reports} health={health} jobsUnavailable={queries.jobs.isError} reportsUnavailable={queries.reports.isError} onSelectAgent={setSelectedAgent} selectedAgentId={selectedAgent?.agentId} />} />
        <Route path="/runs/:runId/diff" element={<ReportRoute jobs={jobs} reports={reports} health={health} jobsUnavailable={queries.jobs.isError} reportsUnavailable={queries.reports.isError} onSelectAgent={setSelectedAgent} selectedAgentId={selectedAgent?.agentId} />} />
        <Route path="/runs/:runId/evidence" element={<ReportRoute jobs={jobs} reports={reports} health={health} jobsUnavailable={queries.jobs.isError} reportsUnavailable={queries.reports.isError} onSelectAgent={setSelectedAgent} selectedAgentId={selectedAgent?.agentId} />} />
        <Route path="/runs/:runId/notebook" element={<ReportRoute jobs={jobs} reports={reports} health={health} jobsUnavailable={queries.jobs.isError} reportsUnavailable={queries.reports.isError} onSelectAgent={setSelectedAgent} selectedAgentId={selectedAgent?.agentId} />} />
        <Route path="/runs/:runId/runtime" element={<ReportRoute jobs={jobs} reports={reports} health={health} jobsUnavailable={queries.jobs.isError} reportsUnavailable={queries.reports.isError} onSelectAgent={setSelectedAgent} selectedAgentId={selectedAgent?.agentId} />} />
        <Route path="/runs/:runId/*" element={<RunIndexRedirect />} />
        <Route path="/findings" element={queries.reports.isPending ? <RouteLoading label={zh ? "正在加载发现" : "Loading findings"} /> : <FindingsPage reports={reports} reportsUnavailable={queries.reports.isError} />} />
        <Route path="/jobs" element={<Navigate replace to="/runs" />} />
        <Route path="/reports" element={queries.jobs.isPending || queries.reports.isPending ? <RouteLoading label={zh ? "正在加载审查报告" : "Loading review reports"} /> : <ReportRoute jobs={jobs} reports={reports} health={health} jobsUnavailable={queries.jobs.isError} reportsUnavailable={queries.reports.isError} />} />
        <Route path="/reports/:jobId" element={<LegacyReportRedirect />} />
        <Route path="/automations" element={<AutomationsPage
          automations={automations}
          repositories={repositories}
          capabilities={queries.auditCapabilities.data}
          unavailable={queries.automations.isError || queries.auditCapabilities.isError}
          actionError={setAutomationEnabled.error ? safeRequestError(setAutomationEnabled.error) : undefined}
          changingAutomationId={setAutomationEnabled.variables?.automationId}
          onSetEnabled={(automation, enabled) => setAutomationEnabled.mutate({ automationId: automation.id, enabled })}
        />} />
        <Route path="/workflows" element={<WorkflowPage />} />
        <Route path="/settings" element={<SettingsPage health={health} />} />
        <Route path="*" element={<Navigate replace to="/inbox" />} />
      </Routes>
    </Suspense>
  </AppShell>;
}
