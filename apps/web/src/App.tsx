import { useEffect, useMemo, useState } from "react";
import {
  demoReviewReport,
  parseReviewReport,
  type ReviewAgentName,
  type ReviewFinding,
  type ReviewReport
} from "@consistency/schema";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";

type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

type ReviewJob = {
  id: string;
  kind: "pull_request" | "push";
  status: JobStatus;
  repository: string;
  pullRequestNumber?: number;
  createdAt: string;
  updatedAt: string;
};

const agentColors: Record<ReviewAgentName, string> = {
  Planner: "#2f78ba",
  Security: "#cf4a3a",
  Correctness: "#16878a",
  Test: "#1f9d73",
  Maintainability: "#c98719",
  Style: "#7154a6",
  Synthesizer: "#4d665d",
  PythonCompatibilityAdapter: "#69766f"
};

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function titleCase(value: string) {
  return value.replaceAll("_", " ");
}

function countByStatus(jobs: ReviewJob[]): Record<JobStatus, number> {
  return {
    queued: jobs.filter(job => job.status === "queued").length,
    running: jobs.filter(job => job.status === "running").length,
    succeeded: jobs.filter(job => job.status === "succeeded").length,
    failed: jobs.filter(job => job.status === "failed").length,
    cancelled: jobs.filter(job => job.status === "cancelled").length
  };
}

function RiskGauge({ score }: { score: number }) {
  const risk = (100 - score) / 100;
  const degrees = Math.round(risk * 270);
  return (
    <div
      className="risk-gauge"
      style={{
        background: `conic-gradient(from 225deg, #cf4a3a 0deg, #cf4a3a ${degrees}deg, #e5ebe7 ${degrees}deg, #e5ebe7 270deg, transparent 270deg)`
      }}
      aria-label={`Risk ${pct(risk)}`}
    >
      <span>{score}</span>
      <small>score</small>
    </div>
  );
}

function JobStatusPanel({
  jobs,
  activeJob,
  source
}: {
  jobs: ReviewJob[];
  activeJob?: ReviewJob;
  source: string;
}) {
  const counts = countByStatus(jobs);
  return (
    <section className="job-panel panel" aria-label="Job orchestration status">
      <div className="panel-heading">
        <span className="label">Job Orchestration</span>
        <span className="muted">{source}</span>
      </div>
      <div className="job-grid">
        {Object.entries(counts).map(([status, count]) => (
          <div className="job-stat" key={status}>
            <span>{status}</span>
            <strong>{count}</strong>
          </div>
        ))}
      </div>
      <div className="latest-job">
        <strong>{activeJob?.repository ?? "Demo fixture"}</strong>
        <span>
          {activeJob?.pullRequestNumber ? `PR #${activeJob.pullRequestNumber}` : activeJob?.kind ?? "canonical report"} -{" "}
          {activeJob?.status ?? "succeeded"}
        </span>
      </div>
    </section>
  );
}

function AgentBars({ report }: { report: ReviewReport }) {
  const counts = new Map<ReviewAgentName, number>();
  for (const finding of report.findings) {
    counts.set(finding.agent, (counts.get(finding.agent) ?? 0) + 1);
  }
  const denominator = Math.max(1, report.findings.length);
  const entries = counts.size > 0
    ? [...counts.entries()]
    : report.agentRuns.map(run => [run.agentName, 0] as const);

  return (
    <div className="signal-bars" aria-label="Findings by agent">
      {entries.map(([agent, count]) => (
        <div className="signal-row" key={agent}>
          <span>{agent}</span>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ width: pct(count / denominator), background: agentColors[agent] }}
            />
          </div>
          <strong>{count}</strong>
        </div>
      ))}
    </div>
  );
}

function lineLabel(finding: ReviewFinding) {
  if (finding.startLine === undefined || finding.endLine === undefined) {
    return "file-level";
  }
  return finding.startLine === finding.endLine
    ? `L${finding.startLine}`
    : `L${finding.startLine}-L${finding.endLine}`;
}

function FindingsList({ findings }: { findings: ReviewFinding[] }) {
  return (
    <div className="file-list">
      {findings.slice(0, 8).map(finding => (
        <article className="file-row" key={finding.id}>
          <div>
            <strong>{finding.file}</strong>
            <span>{finding.title}</span>
          </div>
          <div className="file-metrics">
            <span>{finding.severity}</span>
            <span>{finding.confidence}</span>
            <span>{lineLabel(finding)}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function EvidenceChain({ report }: { report: ReviewReport }) {
  return (
    <div className="stack-list">
      {report.findings.slice(0, 8).map(finding => (
        <article className="stack-item" key={finding.id}>
          <strong>{finding.agent}: {finding.title}</strong>
          <p>{finding.evidence}</p>
        </article>
      ))}
    </div>
  );
}

function Handoff({ report }: { report: ReviewReport }) {
  return (
    <div className="handoff-grid">
      {report.agentRuns.map(run => (
        <article className="handoff-card" key={run.id}>
          <strong>{run.agentName}</strong>
          <span>{run.status} - {run.findings.length} finding(s)</span>
          <span>{run.error ?? run.inputSummary}</span>
        </article>
      ))}
    </div>
  );
}

export function App() {
  const [report, setReport] = useState<ReviewReport>(demoReviewReport);
  const [jobs, setJobs] = useState<ReviewJob[]>([]);
  const [activeJob, setActiveJob] = useState<ReviewJob | undefined>();
  const [source, setSource] = useState("Demo fixture fallback");
  const topFinding = report.findings[0];

  useEffect(() => {
    const controller = new AbortController();

    async function loadJobs() {
      try {
        const jobsResponse = await fetch(`${apiBaseUrl}/jobs`, { signal: controller.signal });
        if (!jobsResponse.ok) throw new Error(`jobs ${jobsResponse.status}`);
        const jobsPayload = (await jobsResponse.json()) as { jobs?: ReviewJob[] };
        const loadedJobs = Array.isArray(jobsPayload.jobs) ? jobsPayload.jobs : [];
        setJobs(loadedJobs);

        const latestSucceeded = [...loadedJobs].reverse().find(job => job.status === "succeeded");
        setActiveJob(latestSucceeded ?? loadedJobs[loadedJobs.length - 1]);
        if (!latestSucceeded) {
          setSource(loadedJobs.length > 0 ? "API jobs loaded; no completed report yet" : "Demo fixture fallback");
          return;
        }

        const reportResponse = await fetch(`${apiBaseUrl}/jobs/${encodeURIComponent(latestSucceeded.id)}/report`, {
          signal: controller.signal
        });
        if (!reportResponse.ok) throw new Error(`report ${reportResponse.status}`);
        setReport(parseReviewReport(await reportResponse.json()));
        setSource("Live API report");
      } catch {
        if (!controller.signal.aborted) setSource("Demo fixture fallback");
      }
    }

    void loadJobs();
    return () => controller.abort();
  }, []);

  const activeReportJob = useMemo(() => activeJob, [activeJob]);

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Product navigation">
        <div className="brand">
          <span className="brand-mark">C</span>
          <div><strong>ConsistenCy</strong><span>Agent Review Board</span></div>
        </div>
        <nav className="nav-list">
          <a className="active" href="#overview">Overview</a>
          <a href="#files">Findings</a>
          <a href="#evidence">Evidence</a>
          <a href="#handoff">Agent Runs</a>
        </nav>
        <div className="sidebar-note">
          <span className="label">Contract</span>
          <code>{"Python analysis -> Legacy adapter -> ReviewReport"}</code>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><p className="label">Typed Report UI</p><h1>Multi-agent PR coordination</h1></div>
          <div className="topbar-meta">
            <span>{report.baseSha.slice(0, 8)}..{report.headSha.slice(0, 8)}</span>
            <strong>PR #{report.pullRequestNumber}</strong>
          </div>
        </header>

        <JobStatusPanel jobs={jobs} activeJob={activeReportJob} source={source} />

        <section id="overview" className="hero-grid" aria-label="Consensus overview">
          <div className="panel decision-panel">
            <div className="panel-heading">
              <span className="label">Review Decision</span>
              <span className="status-pill">{titleCase(report.riskLevel)} risk</span>
            </div>
            <div className="decision-row">
              <div><strong>{report.repositoryFullName}</strong><span>{report.summary}</span></div>
              <RiskGauge score={report.score} />
            </div>
            <div className="metric-strip">
              <div><span>Score</span><strong>{report.score}</strong></div>
              <div><span>Agents</span><strong>{report.agentRuns.length}</strong></div>
              <div><span>Findings</span><strong>{report.findings.length}</strong></div>
            </div>
          </div>

          <div className="panel chart-panel">
            <div className="panel-heading"><span className="label">Findings By Agent</span><span className="muted">canonical schema</span></div>
            <AgentBars report={report} />
          </div>
        </section>

        <section id="files" className="content-grid">
          <div className="panel wide-panel">
            <div className="panel-heading"><span className="label">Highest-Risk Findings</span><span className="muted">severity / confidence / location</span></div>
            <FindingsList findings={report.findings} />
          </div>
          <div className="panel">
            <div className="panel-heading"><span className="label">Review Flow</span><span className="muted">phase 2 contract</span></div>
            <div className="flow">
              <div>Python analysis</div><span /><div>Legacy validation</div><span /><div>Canonical adapter</div><span /><div>ReviewReport</div>
            </div>
          </div>
        </section>

        <section id="evidence" className="content-grid">
          <div className="panel">
            <div className="panel-heading"><span className="label">Evidence Chain</span><span className="muted">evidence-bound</span></div>
            <EvidenceChain report={report} />
          </div>
          <div className="panel">
            <div className="panel-heading"><span className="label">Deep Dive</span><span className="muted">{topFinding ? lineLabel(topFinding) : "--"}</span></div>
            <article className="deep-dive">
              <strong>{topFinding?.file ?? "No finding"}</strong>
              <p>{topFinding?.recommendation ?? "No review recommendation available."}</p>
              <code>{topFinding?.confidence ?? "n/a"}</code>
            </article>
          </div>
        </section>

        <section id="handoff" className="panel">
          <div className="panel-heading"><span className="label">Agent Runs</span><span className="muted">{report.agentRuns.length} recorded</span></div>
          <Handoff report={report} />
        </section>
      </main>
    </div>
  );
}

