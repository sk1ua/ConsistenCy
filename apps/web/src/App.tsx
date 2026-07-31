import { useEffect, useMemo, useState } from "react";
import type { ReviewJob, ReviewReport, StatsResponse } from "@consistency/schema";
import { Activity, BarChart3, BriefcaseBusiness, ChartNoAxesCombined, ChevronDown, Clock3, FlaskConical, Globe2, Menu, RefreshCw, Settings, X } from "lucide-react";
import { api, type HealthResponse, type RealDataSnapshot } from "./api/client";
import { mockJobs, mockReports, mockStats } from "./demo/mockReports";
import { DashboardPage } from "./pages/DashboardPage";
import { JobsPage } from "./pages/JobsPage";
import { ReportPage } from "./pages/ReportPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useI18n } from "./i18n";
import { RealDataPage } from "./pages/RealDataPage";

type View = "dashboard" | "jobs" | "report" | "real-data" | "settings";

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: BarChart3 },
  { id: "jobs", label: "Jobs", icon: BriefcaseBusiness },
  { id: "report", label: "Reports", icon: Activity },
  { id: "real-data", label: "Real data", icon: ChartNoAxesCombined },
  { id: "settings", label: "Settings", icon: Settings }
] as const satisfies ReadonlyArray<{ id: View; label: string; icon: typeof BarChart3 }>;

const pageMeta: Record<View, { title: string; description: string }> = {
  dashboard: { title: "Review overview", description: "Evidence-backed signals across active pull requests" },
  jobs: { title: "Review queue", description: "Track every review from intake to decision" },
  report: { title: "Review report", description: "Inspect findings, evidence and agent decisions" },
  "real-data": { title: "Verified data", description: "Observed GitHub facts separated from model-derived analysis" },
  settings: { title: "System status", description: "Runtime readiness without exposing secret values" }
};

function initialView(): View {
  if (typeof window === "undefined") return "dashboard";
  const value = new URLSearchParams(window.location.search).get("view");
  return value === "jobs" || value === "report" || value === "real-data" || value === "settings" ? value : "dashboard";
}

export function App() {
  const { locale, setLocale, t } = useI18n();
  const [view, setView] = useState<View>(initialView);
  const [jobs, setJobs] = useState<ReviewJob[]>([]);
  const [reports, setReports] = useState<ReviewReport[]>([]);
  const [stats, setStats] = useState<StatsResponse>(mockStats);
  const [health, setHealth] = useState<HealthResponse>();
  const [realData, setRealData] = useState<RealDataSnapshot>();
  const [selectedJobId, setSelectedJobId] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("job") ?? "");
  const [loading, setLoading] = useState(true);
  const [demoMode, setDemoMode] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => new Date());
  const [sidebarOpen, setSidebarOpen] = useState(false);

  async function loadData() {
    setLoading(true);
    setError(undefined);
    try {
      const [loadedJobs, loadedReports, loadedStats, loadedHealth, loadedRealData] = await Promise.all([
        api.jobs(), api.recentReports(20), api.stats(), api.health(), api.realData().catch(() => undefined)
      ]);
      setJobs(loadedJobs);
      setReports(loadedReports);
      setStats(loadedStats);
      setHealth(loadedHealth);
      setRealData(loadedRealData);
      setDemoMode(loadedHealth.configuration.demoMode);
    } catch (caught) {
      setJobs(mockJobs);
      setReports(mockReports);
      setStats(mockStats);
      setDemoMode(true);
      setError(caught instanceof Error ? caught.message : "API unavailable");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadData(); }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams();
    if (view !== "dashboard") params.set("view", view);
    if (selectedJobId && view === "report") params.set("job", selectedJobId);
    window.history.replaceState(null, "", params.size ? `?${params}` : window.location.pathname);
  }, [view, selectedJobId]);

  const selectedJob = useMemo(() => jobs.find(job => job.id === selectedJobId), [jobs, selectedJobId]);
  const selectedReport = useMemo(() => selectedJob?.report ?? reports.find(report => report.jobId === selectedJobId), [reports, selectedJob, selectedJobId]);

  async function openJob(job: ReviewJob) {
    setSelectedJobId(job.id);
    setView("report");
    if (job.status === "succeeded" && !job.report && !reports.some(report => report.jobId === job.id)) {
      try {
        const report = await api.report(job.id);
        setReports(current => [report, ...current.filter(item => item.jobId !== report.jobId)]);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not load report");
      }
    }
  }

  async function seedDemo() {
    try {
      await api.seedDemo();
      await loadData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not seed demo data");
    }
  }

  const page = pageMeta[view];

  function navigate(nextView: View) {
    setView(nextView);
    setSidebarOpen(false);
  }

  return <div className="app-shell">
    <aside className={`app-sidebar${sidebarOpen ? " open" : ""}`}>
      <div className="brand"><img src="/consistency-logo.png" alt="" /><span><strong>Consisten<span>Cy</span></strong><small>{t("Review intelligence")}</small></span></div>
      <nav aria-label={t("Primary navigation")}>{navItems.map(({ id, label, icon: Icon }) => <button aria-current={view === id ? "page" : undefined} className={view === id ? "active" : ""} key={id} type="button" onClick={() => navigate(id)} title={t(label)}><Icon aria-hidden="true" size={18} /><span>{t(label)}</span></button>)}</nav>
      <div className="sidebar-signal"><span>{t("Workspace signal")}</span><strong><i /> {t("Operational")}</strong><small>{t("{count} reviews observed", { count: jobs.length })}</small></div>
      <div className="sidebar-profile"><span className="profile-avatar">DE</span><span><strong>Demo Engineer</strong><small>demo@consistency.ai</small></span><ChevronDown size={15} /></div>
    </aside>
    {sidebarOpen && <button className="sidebar-backdrop" type="button" aria-label={t("Close navigation")} onClick={() => setSidebarOpen(false)} />}
    <main className="app-main">
      <header className="app-header">
        <div className="header-title">
          <button className="menu-button" type="button" aria-label={t(sidebarOpen ? "Close navigation" : "Open navigation")} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}>{sidebarOpen ? <X size={20} /> : <Menu size={20} />}</button>
          <div><h1>{t(page.title)}</h1><p>{t(page.description)}</p></div>
        </div>
        <div className="header-actions">
          <label className="language-select"><Globe2 size={15} /><span className="sr-only">{t("Language")}</span><select aria-label={t("Language")} value={locale} onChange={event => setLocale(event.target.value as "en-US" | "zh-CN")}><option value="zh-CN">中文</option><option value="en-US">English</option></select></label>
          {demoMode && <span className="demo-indicator"><FlaskConical size={15} />{t("Demo Mode")}</span>}
          <span className="api-status"><i className={health?.database.ok ? "online" : "offline"} /> {t(health?.database.ok ? "API connected" : "Demo data")}</span>
          <span className="header-time"><Clock3 size={16} />{now.toLocaleString(locale, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</span>
          {jobs.length === 0 && !loading && <button className="secondary-button" onClick={() => void seedDemo()}>{t("Load demo data")}</button>}
          <button className="icon-button" type="button" onClick={() => void loadData()} aria-label={t("Refresh data")} disabled={loading}><RefreshCw className={loading ? "spinning" : ""} size={18} /></button>
        </div>
      </header>
      <div className="app-content">
        {error && <div className="notice" role="status"><span className="notice-mark">!</span><span><strong>{t("Showing a local review snapshot")}</strong><small>{t("The API is unavailable. Live data will return after the next successful refresh.")}</small></span></div>}
        {loading ? <div className="loading-state"><RefreshCw size={22} /><span>{t("Loading review workspace")}</span></div> :
          view === "dashboard" ? <DashboardPage stats={stats} jobs={jobs} reports={reports} onOpenJob={job => void openJob(job)} onOpenJobs={() => setView("jobs")} /> :
          view === "jobs" ? <JobsPage jobs={jobs} onOpenJob={job => void openJob(job)} /> :
          view === "real-data" ? <RealDataPage data={realData} /> :
          view === "settings" ? <SettingsPage health={health} /> :
          <ReportPage job={selectedJob ?? jobs.find(job => job.status === "succeeded")} report={selectedReport ?? reports[0]} onBack={() => setView("jobs")} />}
      </div>
    </main>
  </div>;
}
