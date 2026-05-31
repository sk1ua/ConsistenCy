const colors = {
  style: "#2f78ba",
  structural: "#16878a",
  semantic: "#1f9d73",
  duplication: "#c98719",
  security: "#cf4a3a",
  risk: "#cf4a3a",
  ink: "#17201b",
  muted: "#627069",
  line: "#dbe2dd",
};

const fmt = (value, digits = 3) => Number(value || 0).toFixed(digits);
const pct = (value) => `${Math.round(Number(value || 0) * 100)}%`;
const titleCase = (value) => String(value || "").replaceAll("_", " ");
let currentPayload = null;
let resizeTimer = null;

async function fetchDemo() {
  const res = await fetch("/api/demo/collaboration");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function drawGauge(canvas, score) {
  const { ctx, width, height } = prepareCanvas(canvas, 180, 180);
  const center = width / 2;
  const radius = Math.min(width, height) * 0.38;
  const start = Math.PI * 0.75;
  const end = Math.PI * 2.25;
  const valueEnd = start + (end - start) * Math.max(0, Math.min(1, score));

  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 18;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#e5ebe7";
  ctx.beginPath();
  ctx.arc(center, center, radius, start, end);
  ctx.stroke();

  ctx.strokeStyle = score >= 0.6 ? colors.risk : score >= 0.35 ? colors.structural : colors.semantic;
  ctx.beginPath();
  ctx.arc(center, center, radius, start, valueEnd);
  ctx.stroke();

  ctx.fillStyle = colors.ink;
  ctx.font = "700 30px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(pct(score), center, center - 4);

  ctx.fillStyle = colors.muted;
  ctx.font = "600 12px Inter, sans-serif";
  ctx.fillText("risk", center, center + 24);
}

function drawSignalChart(canvas, signals) {
  const { ctx, width, height } = prepareCanvas(canvas, 520, 260);
  const entries = Object.entries(signals || {});
  const pad = { top: 20, right: 46, bottom: 42, left: 98 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const barGap = 12;
  const barHeight = Math.max(18, (chartHeight - barGap * (entries.length - 1)) / Math.max(entries.length, 1));

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const x = pad.left + chartWidth * (i / 4);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + chartHeight);
    ctx.stroke();
  }

  entries.forEach(([name, value], index) => {
    const y = pad.top + index * (barHeight + barGap);
    const fillWidth = chartWidth * Math.max(0, Math.min(1, Number(value)));
    ctx.fillStyle = "#eef3ef";
    ctx.fillRect(pad.left, y, chartWidth, barHeight);
    ctx.fillStyle = colors[name] || colors.structural;
    ctx.fillRect(pad.left, y, fillWidth, barHeight);

    ctx.fillStyle = colors.ink;
    ctx.font = "700 13px Inter, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(name, pad.left - 12, y + barHeight / 2);

    ctx.fillStyle = colors.muted;
    ctx.textAlign = "left";
    ctx.fillText(pct(value), pad.left + fillWidth + 8, y + barHeight / 2);
  });

  ctx.fillStyle = colors.muted;
  ctx.font = "600 11px Inter, sans-serif";
  ctx.textAlign = "center";
  [0, 0.25, 0.5, 0.75, 1].forEach((tick) => {
    const x = pad.left + chartWidth * tick;
    ctx.fillText(pct(tick), x, height - 16);
  });
}

function prepareCanvas(canvas, fallbackWidth, fallbackHeight) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || fallbackWidth));
  const height = Math.max(1, Math.round(rect.height || fallbackHeight));
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function renderVotes(votes) {
  const container = document.getElementById("agentVotes");
  container.innerHTML = votes.map((vote) => `
    <article class="agent-card">
      <span class="stance ${vote.stance}">${titleCase(vote.stance)}</span>
      <strong>${vote.agent_name}</strong>
      <div class="bar-track"><div class="bar-fill" style="width:${pct(vote.score)}; background:${colors[vote.signal_name] || colors.structural}"></div></div>
      <p>${vote.focus}</p>
      <p><strong>${fmt(vote.score)}</strong> score / <strong>${fmt(vote.confidence, 2)}</strong> confidence</p>
    </article>
  `).join("");
}

function renderList(id, rows, mapper) {
  const container = document.getElementById(id);
  container.innerHTML = rows.map(mapper).join("");
}

function render(payload) {
  currentPayload = payload;
  const board = payload.agent_collaboration || {};
  const risk = payload.risk || {};

  document.getElementById("decisionText").textContent = titleCase(board.decision || "unknown");
  document.getElementById("riskLevel").textContent = risk.level || "Unknown";
  document.getElementById("quorumBadge").textContent = `Quorum ${board.quorum || "--"}`;
  document.getElementById("riskScore").textContent = fmt(risk.score);
  document.getElementById("consensusScore").textContent = fmt(board.consensus_score);
  document.getElementById("confidenceScore").textContent = fmt(board.confidence, 2);
  document.getElementById("dominantSignals").textContent = (payload.dominant_signals || []).join(" + ") || "--";
  document.getElementById("scenarioSummary").textContent = payload.scenario?.changed_file || "--";

  drawGauge(document.getElementById("riskGauge"), risk.score || 0);
  drawSignalChart(document.getElementById("signalChart"), payload.signal_composition || payload.signals || {});
  renderVotes(payload.votes || []);

  renderList("findingsList", payload.top_findings || [], (finding) => `
    <article class="stack-item">
      <strong>${finding.agent_name} / ${finding.severity}</strong>
      <p>${(finding.evidence || []).slice(0, 2).join("; ")}</p>
    </article>
  `);

  renderList("evidenceList", payload.evidence_chain || [], (item) => `
    <article class="stack-item">
      <strong>${item.signal_name}</strong>
      <p>${item.text}</p>
    </article>
  `);

  renderList("handoffList", payload.review_queue || [], (item) => `
    <article class="handoff-card">
      <strong>${item.owner}</strong>
      <span>${item.scope}</span>
      <span>${item.focus}</span>
    </article>
  `);
}

async function load() {
  const button = document.getElementById("refreshBtn");
  button.disabled = true;
  try {
    render(await fetchDemo());
  } finally {
    button.disabled = false;
  }
}

document.getElementById("refreshBtn").addEventListener("click", load);
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentPayload) render(currentPayload);
  }, 120);
});
load();
