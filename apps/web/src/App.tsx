import { parsePRReport, type PRReport } from "@consistency/schema";
import fixture from "../../../tests/fixtures/pr_report_minimal.json";

const report = parsePRReport(fixture);

type EvidenceItem = {
  signal_name: string;
  text: string;
};

type FileDeepDive = {
  file?: string;
  primary_risk_region?: string;
  estimated_review_effort?: string;
  semantic_signals?: string[];
  evidence_chain?: EvidenceItem[];
};

const signalColors: Record<string, string> = {
  style: "#2f78ba",
  structural: "#16878a",
  semantic: "#1f9d73",
  duplication: "#c98719",
  security: "#cf4a3a",
  evolution: "#7154a6"
};

function fmt(value: number | undefined, digits = 3) {
  return Number(value ?? 0).toFixed(digits);
}

function pct(value: number | undefined) {
  return `${Math.round(Number(value ?? 0) * 100)}%`;
}

function titleCase(value: string) {
  return value.replaceAll("_", " ");
}

function objectValue(input: unknown, key: string): unknown {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  return (input as Record<string, unknown>)[key];
}

function stringValue(input: unknown, key: string): string | undefined {
  const value = objectValue(input, key);
  return typeof value === "string" ? value : undefined;
}

function numberMap(input: unknown): Record<string, number> {
  if (!input || typeof input !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).filter((entry): entry is [string, number] => {
      return typeof entry[1] === "number";
    })
  );
}

function stringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  return input.filter((item): item is string => typeof item === "string");
}

function evidenceItems(input: unknown): EvidenceItem[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap(item => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    const signalName = record.signal_name;
    const text = record.text;
    if (typeof signalName !== "string" || typeof text !== "string") {
      return [];
    }

    return [{ signal_name: signalName, text }];
  });
}

function fileDeepDive(input: unknown): FileDeepDive | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  return {
    file: stringValue(input, "file"),
    primary_risk_region: stringValue(input, "primary_risk_region"),
    estimated_review_effort: stringValue(input, "estimated_review_effort"),
    semantic_signals: stringArray(objectValue(input, "semantic_signals")),
    evidence_chain: evidenceItems(objectValue(input, "evidence_chain"))
  };
}

function RiskGauge({ score }: { score: number }) {
  const degrees = Math.round(score * 270);
  return (
    <div
      className="risk-gauge"
      style={{
        background: `conic-gradient(from 225deg, #cf4a3a 0deg, #cf4a3a ${degrees}deg, #e5ebe7 ${degrees}deg, #e5ebe7 270deg, transparent 270deg)`
      }}
      aria-label={`Risk ${pct(score)}`}
    >
      <span>{pct(score)}</span>
      <small>risk</small>
    </div>
  );
}

function SignalBars({ report }: { report: PRReport }) {
  const entries = Object.entries(numberMap(objectValue(report.risk_composition, "contributions_pct")));
  return (
    <div className="signal-bars" aria-label="Signal contribution">
      {entries.map(([name, value]) => (
        <div className="signal-row" key={name}>
          <span>{name}</span>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{
                width: pct(Number(value)),
                background: signalColors[name] ?? "#16878a"
              }}
            />
          </div>
          <strong>{pct(Number(value))}</strong>
        </div>
      ))}
    </div>
  );
}

function TopFiles({ report }: { report: PRReport }) {
  return (
    <div className="file-list">
      {report.top_risky_files.map(file => (
        <article className="file-row" key={file.file}>
          <div>
            <strong>{file.file}</strong>
            <span>{file.dominant_signals.join(" + ") || "no dominant signal"}</span>
          </div>
          <div className="file-metrics">
            <span>{fmt(file.avg_risk)}</span>
            <span>{pct(file.confidence)}</span>
            <span>{file.churn_lines} lines</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function EvidenceChain({ report }: { report: PRReport }) {
  const deepDive = fileDeepDive(report.file_deep_dive[0]);
  const evidence = [
    ...report.evidence_summary.map(item => ({
      signal_name: item.type as string,
      text: item.text as string
    })),
    ...(deepDive?.evidence_chain ?? [])
  ].slice(0, 8);

  return (
    <div className="stack-list">
      {evidence.map((item, index) => (
        <article className="stack-item" key={`${item.signal_name}-${index}`}>
          <strong>{titleCase(item.signal_name)}</strong>
          <p>{item.text}</p>
        </article>
      ))}
    </div>
  );
}

function Handoff({ report }: { report: PRReport }) {
  const queue = report.agent_collaboration.review_queue ?? [];
  if (queue.length === 0) {
    return (
      <div className="handoff-grid">
        <article className="handoff-card">
          <strong>Schema reviewer</strong>
          <span>{report.top_risky_files[0]?.file ?? "No file queued"}</span>
          <span>Validate report contract and downstream TypeScript consumers.</span>
        </article>
      </div>
    );
  }

  return (
    <div className="handoff-grid">
      {queue.map((item, index) => (
        <article className="handoff-card" key={`${item.owner}-${index}`}>
          <strong>{String(item.owner ?? "Reviewer")}</strong>
          <span>{String(item.scope ?? "pull_request")}</span>
          <span>{String(item.focus ?? item.why ?? "Review typed report output.")}</span>
        </article>
      ))}
    </div>
  );
}

export function App() {
  const deepDive = fileDeepDive(report.file_deep_dive[0]);

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Product navigation">
        <div className="brand">
          <span className="brand-mark">C</span>
          <div>
            <strong>ConsistenCy</strong>
            <span>Agent Review Board</span>
          </div>
        </div>
        <nav className="nav-list">
          <a className="active" href="#overview">Overview</a>
          <a href="#files">Files</a>
          <a href="#evidence">Evidence</a>
          <a href="#handoff">Handoff</a>
        </nav>
        <div className="sidebar-note">
          <span className="label">Engine</span>
          <code>{"Python analysis -> JSON Schema -> TS product shell"}</code>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="label">Typed Report UI</p>
            <h1>Multi-agent PR coordination</h1>
          </div>
          <div className="topbar-meta">
            <span>{report.base_ref}..{report.head_ref}</span>
            <strong>{report.commit_count} commit</strong>
          </div>
        </header>

        <section id="overview" className="hero-grid" aria-label="Consensus overview">
          <div className="panel decision-panel">
            <div className="panel-heading">
              <span className="label">Board Decision</span>
              <span className="status-pill">Quorum {report.agent_collaboration.quorum}</span>
            </div>
            <div className="decision-row">
              <div>
                <strong>{titleCase(report.agent_collaboration.decision)}</strong>
                <span>{report.max_risk >= 0.6 ? "Significant Drift" : "Minor Drift"}</span>
              </div>
              <RiskGauge score={report.avg_risk} />
            </div>
            <div className="metric-strip">
              <div><span>Risk</span><strong>{fmt(report.avg_risk)}</strong></div>
              <div><span>Consensus</span><strong>{fmt(report.agent_collaboration.consensus_score)}</strong></div>
              <div><span>Confidence</span><strong>{fmt(report.agent_collaboration.confidence, 2)}</strong></div>
            </div>
          </div>

          <div className="panel chart-panel">
            <div className="panel-heading">
              <span className="label">Signal Contribution</span>
              <span className="muted">{String(objectValue(report.risk_composition, "percentile_basis") ?? "within_pr")}</span>
            </div>
            <SignalBars report={report} />
          </div>
        </section>

        <section id="files" className="content-grid">
          <div className="panel wide-panel">
            <div className="panel-heading">
              <span className="label">Highest-Risk Files</span>
              <span className="muted">avg risk / confidence / churn</span>
            </div>
            <TopFiles report={report} />
          </div>
          <div className="panel">
            <div className="panel-heading">
              <span className="label">Consensus Flow</span>
              <span className="muted">review routing</span>
            </div>
            <div className="flow">
              <div>Parallel agents</div>
              <span />
              <div>Evidence normalization</div>
              <span />
              <div>Weighted consensus</div>
              <span />
              <div>Reviewer handoff</div>
            </div>
          </div>
        </section>

        <section id="evidence" className="content-grid">
          <div className="panel">
            <div className="panel-heading">
              <span className="label">Evidence Chain</span>
              <span className="muted">contract-safe</span>
            </div>
            <EvidenceChain report={report} />
          </div>
          <div className="panel">
            <div className="panel-heading">
              <span className="label">Deep Dive</span>
              <span className="muted">{deepDive?.primary_risk_region ?? "--"}</span>
            </div>
            <article className="deep-dive">
              <strong>{deepDive?.file ?? "No deep dive"}</strong>
              <p>{deepDive?.semantic_signals?.[0] ?? "No semantic signals collected."}</p>
              <code>{deepDive?.estimated_review_effort ?? "n/a"}</code>
            </article>
          </div>
        </section>

        <section id="handoff" className="panel">
          <div className="panel-heading">
            <span className="label">Human Review Queue</span>
            <span className="muted">{report.top_risky_files[0]?.file ?? "--"}</span>
          </div>
          <Handoff report={report} />
        </section>
      </main>
    </div>
  );
}
