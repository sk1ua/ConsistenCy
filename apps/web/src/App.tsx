import { useEffect, useMemo, useState } from "react";
import type { ReviewJob, ReviewReport, StatsResponse } from "@consistency/schema";
import { Activity, BarChart3, BriefcaseBusiness, ChevronDown, Clock3, FlaskConical, Menu, RefreshCw, Settings } from "lucide-react";
import { api, type HealthResponse } from "./api/client";
import { mockJobs, mockReports, mockStats } from "./demo/mockReports";
import { DashboardPage } from "./pages/DashboardPage";
import { JobsPage } from "./pages/JobsPage";
import { ReportPage } from "./pages/ReportPage";
import { SettingsPage } from "./pages/SettingsPage";

type View = "dashboard" | "jobs" | "report" | "settings";

const navItems = [
  ["dashboard", "Dashboard", BarChart3],
  ["jobs", "Jobs", BriefcaseBusiness],
  ["report", "Reports", Activity],
  ["settings", "Settings", Settings]
] as const;

function initialView(): View {
  if (typeof window === "undefined") return "dashboard";
  const value = new URLSearchParams(window.location.search).get("view");
  return value === "jobs" || value === "report" || value === "settings" ? value : "dashboard";
}

export function App() {
  const [view, setView] = useState<View>(initialView);
  const [jobs, setJobs] = useState<ReviewJob[]>([]);
  const [reports, setReports] = useState<ReviewReport[]>([]);
  const [stats, setStats] = useState<StatsResponse>(mockStats);
  const [health, setHealth] = useState<HealthResponse>();
  const [selectedJobId, setSelectedJobId] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("job") ?? "");
  const [loading, setLoading] = useState(true);
  const [demoMode, setDemoMode] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => new Date());

  async function loadData() {
    setLoading(true);
    setError(undefined);
    try {
      const [loadedJobs, loadedReports, loadedStats, loadedHealth] = await Promise.all([
        api.jobs(), api.recentReports(20), api.stats(), api.health()
      ]);
      setJobs(loadedJobs);
      setReports(loadedReports);
      setStats(loadedStats);
      setHealth(loadedHealth);
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

  const pageTitle = view === "dashboard" ? "Dashboard" : view === "jobs" ? "Review jobs" : view === "settings" ? "Settings" : "Review report";

  return <div className="app-shell">
    <aside className="app-sidebar">
      <div className="brand"><img src="/consistency-logo.png" alt="" /><strong>Consisten<span>Cy</span></strong></div>
      <nav>{navItems.map(([id, label, Icon]) => <button className={view === id ? "active" : ""} key={id} type="button" onClick={() => setView(id)} title={label}><Icon size={18} /><span>{label}</span></button>)}</nav>
      <div className="sidebar-profile"><span className="profile-avatar">DE</span><span><strong>Demo Engineer</strong><small>demo@consistency.ai</small></span><ChevronDown size={15} /></div>
    </aside>
    <main className="app-main">
      <header className="app-header">
        <div className="header-title"><Menu size={21} /><h1>{pageTitle}</h1></div>
        <div className="header-actions">
          {demoMode && <span className="demo-indicator"><FlaskConical size={15} />Demo Mode</span>}
          <span className="api-status">API <i className={health?.database.ok ? "online" : "offline"} /> {health?.database.ok ? "Connected" : "Demo data"}</span>
          <span className="header-time"><Clock3 size={16} />{now.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</span>
          {jobs.length === 0 && !loading && <button className="secondary-button" onClick={() => void seedDemo()}>Load demo data</button>}
          <button className="icon-button" type="button" onClick={() => void loadData()} title="Refresh data"><RefreshCw size={18} /></button>
        </div>
      </header>
      <div className="app-content">
        {error && <div className="notice"><strong>Using local demo data.</strong><span>{error}</span></div>}
        {loading ? <div className="loading-state"><RefreshCw size={22} /><span>Loading review workspace</span></div> :
          view === "dashboard" ? <DashboardPage stats={stats} jobs={jobs} reports={reports} onOpenJob={job => void openJob(job)} onOpenJobs={() => setView("jobs")} /> :
          view === "jobs" ? <JobsPage jobs={jobs} onOpenJob={job => void openJob(job)} /> :
          view === "settings" ? <SettingsPage health={health} /> :
          <ReportPage job={selectedJob ?? jobs.find(job => job.status === "succeeded")} report={selectedReport ?? reports[0]} onBack={() => setView("jobs")} />}
      </div>
    </main>
  </div>;
}
