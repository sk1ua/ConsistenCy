/**
 * Chart Renderer
 * Plotly.js chart configurations
 */

const PLOTLY_LAYOUT_BASE = {
  paper_bgcolor: 'transparent',
  plot_bgcolor: 'transparent',
  font: { 
    family: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    color: '#e2e8f0', 
    size: 11 
  },
  margin: { t: 10, r: 10, b: 40, l: 50 },
  grid: { rows: 1, columns: 1 },
  xaxis: { 
    gridcolor: '#2a2d3e', 
    linecolor: '#2a2d3e', 
    zerolinecolor: '#2a2d3e' 
  },
  yaxis: { 
    gridcolor: '#2a2d3e', 
    linecolor: '#2a2d3e', 
    zerolinecolor: '#2a2d3e' 
  },
};

const PLOTLY_CONFIG = { 
  responsive: true, 
  displayModeBar: false,
  displaylogo: false,
};

const RISK_COLORS = {
  green: '#4ade80',
  yellow: '#fbbf24',
  orange: '#f97316',
  red: '#f87171',
};

function getRiskColor(score) {
  if (score >= 0.75) return 'red';
  if (score >= 0.50) return 'orange';
  if (score >= 0.25) return 'yellow';
  return 'green';
}

export class ChartRenderer {
  renderTimeline(containerId, history) {
    if (!history?.length) return;

    const container = document.getElementById(containerId);
    if (!container) return;

    const weeks = history.map(d => d.week);
    const scores = history.map(d => d.avg_risk);

    const traces = [
      {
        x: weeks,
        y: scores,
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Risk Trend',
        line: { color: '#6366f1', width: 2, shape: 'spline' },
        marker: { 
          size: 8,
          color: scores.map(s => RISK_COLORS[getRiskColor(s)]),
          line: { color: '#0f172a', width: 1 },
        },
        hovertemplate: 'Week %{x}<br>Risk: %{y:.3f}<extra></extra>',
      },
    ];

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      yaxis: { ...PLOTLY_LAYOUT_BASE.yaxis, range: [0, 1] },
      shapes: [
        { type: 'line', y0: 0.25, y1: 0.25, x0: 0, x1: 1, xref: 'paper',
          line: { color: RISK_COLORS.yellow, width: 1, dash: 'dot' } },
        { type: 'line', y0: 0.50, y1: 0.50, x0: 0, x1: 1, xref: 'paper',
          line: { color: RISK_COLORS.orange, width: 1, dash: 'dot' } },
        { type: 'line', y0: 0.75, y1: 0.75, x0: 0, x1: 1, xref: 'paper',
          line: { color: RISK_COLORS.red, width: 1, dash: 'dot' } },
      ],
      hovermode: 'x unified',
    };

    Plotly.newPlot(containerId, traces, layout, PLOTLY_CONFIG);
  }

  renderRadar(containerId, data) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const fileResults = data?.file_results || {};
    const keys = ['style', 'structural', 'semantic', 'duplication'];
    
    // Aggregate breakdown
    const sums = Object.fromEntries(keys.map(k => [k, 0]));
    let count = 0;
    
    Object.values(fileResults).forEach(res => {
      const bd = res.breakdown || {};
      keys.forEach(k => { sums[k] += bd[k] ?? 0; });
      count++;
    });

    const values = keys.map(k => count ? sums[k] / count : 0);
    const labels = keys.map(k => k.charAt(0).toUpperCase() + k.slice(1));

    const trace = {
      type: 'scatterpolar',
      r: [...values, values[0]],
      theta: [...labels, labels[0]],
      fill: 'toself',
      fillcolor: 'rgba(99,102,241,0.2)',
      line: { color: '#6366f1', width: 2 },
      hovertemplate: '%{theta}: %{r:.3f}<extra></extra>',
    };

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      polar: {
        radialaxis: { range: [0, 1], gridcolor: '#2a2d3e', linecolor: '#2a2d3e' },
        angularaxis: { gridcolor: '#2a2d3e', linecolor: '#2a2d3e' },
        bgcolor: 'transparent',
      },
      margin: { t: 20, r: 30, b: 20, l: 30 },
    };

    Plotly.newPlot(containerId, [trace], layout, PLOTLY_CONFIG);
  }

  renderFileBars(containerId, files) {
    if (!files?.length) return;

    const container = document.getElementById(containerId);
    if (!container) return;

    const top = files.slice(0, 20);
    const labels = top.map(f => this.shortPath(f.file));
    const scores = top.map(f => f.risk_score);
    const colors = scores.map(s => RISK_COLORS[getRiskColor(s)]);

    const trace = {
      y: labels,
      x: scores,
      type: 'bar',
      orientation: 'h',
      marker: { color: colors },
      hovertemplate: '%{y}<br>Risk: %{x:.3f}<extra></extra>',
    };

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, range: [0, 1] },
      yaxis: { ...PLOTLY_LAYOUT_BASE.yaxis, automargin: true },
      margin: { t: 10, r: 10, b: 40, l: 200 },
    };

    Plotly.newPlot(containerId, [trace], layout, PLOTLY_CONFIG);
  }

  renderAuthorBars(containerId, authors) {
    if (!authors?.length) return;

    const container = document.getElementById(containerId);
    if (!container) return;

    const top = authors.slice(0, 10);
    const labels = top.map(a => a.author);
    const scores = top.map(a => a.avg_risk_proxy ?? 0);
    const colors = scores.map(s => RISK_COLORS[getRiskColor(s)]);

    const trace = {
      y: labels,
      x: scores,
      type: 'bar',
      orientation: 'h',
      marker: { color: colors },
      hovertemplate: '%{y}<br>Risk: %{x:.3f}<br>Commits: %{customdata}<extra></extra>',
      customdata: top.map(a => a.commit_count),
    };

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, range: [0, 1] },
      yaxis: { ...PLOTLY_LAYOUT_BASE.yaxis, automargin: true },
      margin: { t: 10, r: 10, b: 40, l: 130 },
    };

    Plotly.newPlot(containerId, [trace], layout, PLOTLY_CONFIG);
  }

  renderHotspots(containerId, hotspots) {
    if (!hotspots?.length) return;

    const container = document.getElementById(containerId);
    if (!container) return;

    const trace = {
      x: hotspots.map(h => h.churn),
      y: hotspots.map(h => h.cyclomatic_avg),
      text: hotspots.map(h => this.shortPath(h.file)),
      mode: 'markers+text',
      type: 'scatter',
      textposition: 'top center',
      textfont: { size: 9, color: '#8892a4' },
      marker: {
        size: hotspots.map(h => Math.max(6, Math.min(h.loc / 20, 30))),
        color: hotspots.map(h => h.hotspot_score),
        colorscale: [[0, RISK_COLORS.green], [0.5, RISK_COLORS.yellow], [1, RISK_COLORS.red]],
        showscale: true,
        colorbar: { title: 'Hotspot', tickfont: { color: '#8892a4' }, len: 0.6 },
      },
      hovertemplate: 
        '<b>%{text}</b><br>Churn: %{x} lines<br>CC: %{y:.1f}<extra></extra>',
    };

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, title: { text: 'Code Churn (lines)' } },
      yaxis: { ...PLOTLY_LAYOUT_BASE.yaxis, title: { text: 'Cyclomatic Complexity' } },
    };

    Plotly.newPlot(containerId, [trace], layout, PLOTLY_CONFIG);
  }

  shortPath(p) {
    const parts = p.split('/');
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
  }
}