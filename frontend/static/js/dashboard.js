/* ===================================================
   ConsistenCy Dashboard  ·  dashboard.js
   Uses Plotly.js (loaded from CDN in index.html)
   =================================================== */
"use strict";

const PLOTLY_LAYOUT_BASE = {
  paper_bgcolor: "transparent",
  plot_bgcolor:  "transparent",
  font: { family: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
          color: "#e2e8f0", size: 11 },
  margin: { t: 10, r: 10, b: 40, l: 50 },
  grid: { rows: 1, columns: 1 },
  xaxis: { gridcolor: "#2a2d3e", linecolor: "#2a2d3e", zerolinecolor: "#2a2d3e" },
  yaxis: { gridcolor: "#2a2d3e", linecolor: "#2a2d3e", zerolinecolor: "#2a2d3e" },
};
const PLOTLY_CONFIG = { responsive: true, displayModeBar: false };

const COLOUR_MAP = {
  GREEN:  "#4ade80",
  YELLOW: "#fbbf24",
  ORANGE: "#f97316",
  RED:    "#f87171",
};

// ------------------------------------------------------------------ //
// DOM refs
// ------------------------------------------------------------------ //
const repoInput  = document.getElementById("repoInput");
const analyzeBtn = document.getElementById("analyzeBtn");
const overlay    = document.getElementById("overlay");
const riskBanner = document.getElementById("riskBanner");
const riskLabel  = document.getElementById("riskLabel");
const riskScore  = document.getElementById("riskScore");
const riskMeta   = document.getElementById("riskMeta");
const evidenceList = document.getElementById("evidenceList");

// ------------------------------------------------------------------ //
// Main entry
// ------------------------------------------------------------------ //
analyzeBtn.addEventListener("click", runAnalysis);
repoInput.addEventListener("keydown", e => { if (e.key === "Enter") runAnalysis(); });

async function runAnalysis() {
  const repoPath = repoInput.value.trim();
  if (!repoPath) { showToast("Please enter a repo path."); return; }

  setLoading(true);

  try {
    // Fire all API calls in parallel
    const [analyzeRes, historyRes, filesRes, authorsRes, hotspotsRes] = await Promise.all([
      apiFetch("/api/analyze",        "POST", { repo_path: repoPath }),
      apiFetch(`/api/repo/history?repo_path=${encodeURIComponent(repoPath)}`),
      apiFetch(`/api/repo/files?repo_path=${encodeURIComponent(repoPath)}`),
      apiFetch(`/api/repo/authors?repo_path=${encodeURIComponent(repoPath)}`),
      apiFetch(`/api/repo/hotspots?repo_path=${encodeURIComponent(repoPath)}`),
    ]);

    renderBanner(analyzeRes);
    renderTimeline(historyRes);
    renderRadar(analyzeRes);
    renderFiles(filesRes);
    renderAuthors(authorsRes);
    renderHotspots(hotspotsRes);
    renderEvidence(analyzeRes);

  } catch (err) {
    showToast("Analysis failed: " + err.message);
  } finally {
    setLoading(false);
  }
}

// ------------------------------------------------------------------ //
// API helper
// ------------------------------------------------------------------ //
async function apiFetch(url, method = "GET", body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ------------------------------------------------------------------ //
// Banner
// ------------------------------------------------------------------ //
function renderBanner(data) {
  const score  = data.final_risk_score ?? 0;
  const colour = riskColour(score);
  const level  = riskLevel(score);

  riskScore.textContent = score.toFixed(3);
  riskLabel.textContent = level;
  riskLabel.className   = "risk-label " + colour;
  riskMeta.textContent  =
    `Commit ${data.commit?.sha ?? "HEAD"} · `
    + `${data.files_analyzed ?? 0} file(s) analyzed`;

  riskBanner.classList.remove("hidden");
}

// ------------------------------------------------------------------ //
// Timeline
// ------------------------------------------------------------------ //
function renderTimeline(history) {
  if (!history?.length) return;

  const weeks = history.map(d => d.week);
  const scores = history.map(d => d.avg_risk);

  const trendTrace = {
    x: weeks, y: scores,
    type: "scatter", mode: "lines",
    name: "Trend",
    line: { color: "#6366f1", width: 2 },
    hovertemplate: "Week %{x}<br>Risk: %{y:.3f}<extra></extra>",
  };

  const realWeeks = history.filter(d => !d.is_estimated);
  const estimatedWeeks = history.filter(d => d.is_estimated);

  const realTrace = {
    x: realWeeks.map(d => d.week),
    y: realWeeks.map(d => d.avg_risk),
    type: "scatter",
    mode: "markers",
    name: "Real",
    marker: {
      size: 8,
      color: realWeeks.map(d => COLOUR_MAP[riskColour(d.avg_risk)]),
      line: { color: "#0f172a", width: 1 },
    },
    customdata: realWeeks.map(d => [d.commit_count, d.real_sample_count ?? 0]),
    hovertemplate:
      "Week %{x}<br>Risk: %{y:.3f}<br>Commits: %{customdata[0]}"
      + "<br>Real samples: %{customdata[1]}<extra></extra>",
  };

  const estimatedTrace = {
    x: estimatedWeeks.map(d => d.week),
    y: estimatedWeeks.map(d => d.avg_risk),
    type: "scatter",
    mode: "markers",
    name: "Estimated",
    marker: {
      size: 9,
      symbol: "circle-open",
      color: "#94a3b8",
      line: { color: "#94a3b8", width: 2 },
    },
    customdata: estimatedWeeks.map(d => [d.commit_count, d.real_sample_count ?? 0]),
    hovertemplate:
      "Week %{x}<br>Risk: %{y:.3f}<br>Commits: %{customdata[0]}"
      + "<br>Estimated only<extra></extra>",
  };

  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    legend: {
      orientation: "h",
      yanchor: "bottom",
      y: 1.03,
      xanchor: "right",
      x: 1,
    },
    yaxis: { ...PLOTLY_LAYOUT_BASE.yaxis, range: [0, 1] },
    shapes: [
      { type: "line", y0: 0.25, y1: 0.25, x0: 0, x1: 1, xref: "paper",
        line: { color: "#fbbf24", width: 1, dash: "dot" } },
      { type: "line", y0: 0.50, y1: 0.50, x0: 0, x1: 1, xref: "paper",
        line: { color: "#f97316", width: 1, dash: "dot" } },
      { type: "line", y0: 0.75, y1: 0.75, x0: 0, x1: 1, xref: "paper",
        line: { color: "#f87171", width: 1, dash: "dot" } },
    ],
  };

  Plotly.newPlot(
    "chartTimeline",
    [trendTrace, realTrace, estimatedTrace],
    layout,
    PLOTLY_CONFIG,
  );
}

// ------------------------------------------------------------------ //
// Radar
// ------------------------------------------------------------------ //
function renderRadar(data) {
  const bd = data.file_results
    ? aggregateBreakdown(data.file_results)
    : {};

  const dims = ["style", "structural", "semantic", "duplication", "evolution"];
  const vals = dims.map(k => bd[k] ?? data.evolution_score ?? 0);

  const trace = {
    type: "scatterpolar",
    r: [...vals, vals[0]],
    theta: [...dims.map(d => d.charAt(0).toUpperCase() + d.slice(1)), dims[0].charAt(0).toUpperCase() + dims[0].slice(1)],
    fill: "toself",
    fillcolor: "rgba(99,102,241,0.2)",
    line: { color: "#6366f1" },
    hovertemplate: "%{theta}: %{r:.3f}<extra></extra>",
  };

  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    polar: {
      radialaxis: { range: [0, 1], gridcolor: "#2a2d3e", linecolor: "#2a2d3e",
                    tickcolor: "#8892a4" },
      angularaxis: { gridcolor: "#2a2d3e", linecolor: "#2a2d3e" },
      bgcolor: "transparent",
    },
    margin: { t: 20, r: 30, b: 20, l: 30 },
  };

  Plotly.newPlot("chartRadar", [trace], layout, PLOTLY_CONFIG);
}

// ------------------------------------------------------------------ //
// Files bar chart
// ------------------------------------------------------------------ //
function renderFiles(files) {
  if (!files?.length) return;
  const top = files.slice(0, 20);
  const labels  = top.map(f => shortPath(f.file));
  const scores  = top.map(f => f.risk_score);
  const colours = scores.map(s => COLOUR_MAP[riskColour(s)]);

  const trace = {
    y: labels, x: scores,
    type: "bar", orientation: "h",
    marker: { color: colours },
    hovertemplate: "%{y}<br>Risk: %{x:.3f}<extra></extra>",
  };

  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, range: [0, 1] },
    yaxis: { ...PLOTLY_LAYOUT_BASE.yaxis, automargin: true },
    margin: { t: 10, r: 10, b: 40, l: 180 },
  };

  Plotly.newPlot("chartFiles", [trace], layout, PLOTLY_CONFIG);
}

// ------------------------------------------------------------------ //
// Authors
// ------------------------------------------------------------------ //
function renderAuthors(authors) {
  if (!authors?.length) return;
  const top = authors.slice(0, 10);
  const labels = top.map(a => a.author);
  const scores = top.map(a => Number.isFinite(a.avg_risk) ? a.avg_risk : (a.avg_risk_proxy ?? 0));
  const colours = scores.map(s => COLOUR_MAP[riskColour(s)]);

  const trace = {
    y: labels, x: scores,
    type: "bar", orientation: "h",
    marker: { color: colours },
    hovertemplate:
      "%{y}<br>Risk: %{x:.3f}<br>Proxy: %{customdata[1]:.3f}<br>Commits: %{customdata[0]}<br>Mode: %{customdata[2]}<extra></extra>",
    customdata: top.map(a => [a.commit_count, a.avg_risk_proxy ?? 0, a.analysis_mode ?? "proxy"]),
  };

  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, range: [0, 1] },
    yaxis: { ...PLOTLY_LAYOUT_BASE.yaxis, automargin: true },
    margin: { t: 10, r: 10, b: 40, l: 130 },
  };

  Plotly.newPlot("chartAuthors", [trace], layout, PLOTLY_CONFIG);
}

// ------------------------------------------------------------------ //
// Hotspot scatter
// ------------------------------------------------------------------ //
function renderHotspots(hotspots) {
  if (!hotspots?.length) return;

  const trace = {
    x: hotspots.map(h => h.churn),
    y: hotspots.map(h => h.cyclomatic_avg),
    text: hotspots.map(h => shortPath(h.file)),
    mode: "markers+text",
    type: "scatter",
    textposition: "top center",
    textfont: { size: 9, color: "#8892a4" },
    marker: {
      size: hotspots.map(h => Math.max(6, Math.min(h.loc / 20, 30))),
      color: hotspots.map(h => h.hotspot_score),
      colorscale: [[0,"#4ade80"],[0.5,"#fbbf24"],[1,"#f87171"]],
      showscale: true,
      colorbar: { title: "Hotspot", tickfont: { color: "#8892a4" }, len: 0.6 },
    },
    hovertemplate:
      "<b>%{text}</b><br>"
      + "Churn: %{x} lines<br>"
      + "Cyclomatic avg: %{y:.1f}<br>"
      + "LOC: %{customdata}<extra></extra>",
    customdata: hotspots.map(h => h.loc),
  };

  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, title: { text: "Code Churn (lines)", standoff: 8 } },
    yaxis: { ...PLOTLY_LAYOUT_BASE.yaxis, title: { text: "Cyclomatic Complexity (avg)" } },
  };

  Plotly.newPlot("chartHotspots", [trace], layout, PLOTLY_CONFIG);
}

// ------------------------------------------------------------------ //
// Evidence
// ------------------------------------------------------------------ //
function renderEvidence(data) {
  const items = [];

  // Top-level evidence from evolution
  (data.evolution_evidence || []).forEach(e => items.push({ text: e, cls: "" }));

  // Per-file evidence (top 5 riskiest)
  const fileEntries = Object.entries(data.file_results || {})
    .sort(([,a],[,b]) => b.risk_score - a.risk_score)
    .slice(0, 5);

  fileEntries.forEach(([file, res]) => {
    const colour = riskColour(res.risk_score);
    items.push({ text: `📄 ${file}  (risk=${res.risk_score.toFixed(3)})`, cls: colour });
    (res.evidence || []).slice(0, 3).forEach(e => items.push({ text: `   ${e}`, cls: colour }));
  });

  if (!items.length) {
    evidenceList.innerHTML = '<li class="placeholder">No evidence collected.</li>';
    return;
  }

  evidenceList.innerHTML = items.map(
    ({ text, cls }) => `<li class="${cls}">${escHtml(text)}</li>`
  ).join("");
}

// ------------------------------------------------------------------ //
// Utilities
// ------------------------------------------------------------------ //
function riskColour(score) {
  if (score >= 0.75) return "RED";
  if (score >= 0.50) return "ORANGE";
  if (score >= 0.25) return "YELLOW";
  return "GREEN";
}

function riskLevel(score) {
  if (score >= 0.75) return "High Risk";
  if (score >= 0.50) return "Significant Drift";
  if (score >= 0.25) return "Minor Drift";
  return "Consistent";
}

function shortPath(p) {
  const parts = p.split("/");
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : p;
}

function escHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function aggregateBreakdown(fileResults) {
  const keys = ["style","structural","semantic","duplication"];
  const sums = Object.fromEntries(keys.map(k => [k, 0]));
  let count = 0;
  Object.values(fileResults).forEach(res => {
    const bd = res.breakdown || {};
    keys.forEach(k => { sums[k] += bd[k] ?? 0; });
    count++;
  });
  if (!count) return sums;
  return Object.fromEntries(keys.map(k => [k, sums[k] / count]));
}

function setLoading(on) {
  overlay.classList.toggle("hidden", !on);
  analyzeBtn.disabled = on;
}

function showToast(msg, durationMs = 4000) {
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "alert");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}
