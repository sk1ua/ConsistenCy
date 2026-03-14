/**
 * ConsistenCy Dashboard App
 * Modern, modular architecture with full CLI parity
 */

import { StateManager } from './modules/state.js';
import { ApiClient } from './modules/api.js';
import { ChartRenderer } from './modules/charts.js';
import { FileBrowser } from './modules/fileBrowser.js';
import { PrAnalyzer } from './modules/prAnalyzer.js';
import { ExportManager } from './modules/export.js';
import { Toast, Modal, Tooltip } from './modules/ui.js';

class ConsistencyApp {
  constructor() {
    this.state = new StateManager();
    this.api = new ApiClient();
    this.charts = new ChartRenderer();
    this.fileBrowser = new FileBrowser(this.api);
    this.prAnalyzer = new PrAnalyzer(this.api);
    this.exportManager = new ExportManager(this.api);
    
    this.init();
  }

  init() {
    this.bindEvents();
    this.initNavigation();
    this.loadInitialState();
  }

  bindEvents() {
    // Global analyze button
    document.getElementById('globalAnalyzeBtn')?.addEventListener('click', 
      () => this.handleGlobalAnalyze());

    // Navigation
    document.querySelectorAll('[data-nav]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        this.navigateTo(el.dataset.nav);
      });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        switch(e.key) {
          case 'Enter':
            e.preventDefault();
            this.handleGlobalAnalyze();
            break;
          case '1':
            e.preventDefault();
            this.navigateTo('overview');
            break;
          case '2':
            e.preventDefault();
            this.navigateTo('files');
            break;
          case '3':
            e.preventDefault();
            this.navigateTo('pr');
            break;
        }
      }
    });
  }

  initNavigation() {
    const hash = window.location.hash.slice(1) || 'overview';
    this.navigateTo(hash);
  }

  navigateTo(view) {
    // Update nav active state
    document.querySelectorAll('[data-nav]').forEach(el => {
      el.classList.toggle('active', el.dataset.nav === view);
    });

    // Show/hide views
    document.querySelectorAll('.view-section').forEach(el => {
      el.classList.toggle('active', el.id === `view-${view}`);
    });

    // Update URL
    window.history.replaceState(null, null, `#${view}`);
  }

  async handleGlobalAnalyze() {
    const repoPath = document.getElementById('repoInput')?.value.trim();
    
    if (!repoPath) {
      Toast.show('Please enter a repository path', 'warning');
      return;
    }

    this.state.set('repoPath', repoPath);
    this.state.set('loading', true);

    try {
      const results = await this.api.analyzeAll(repoPath);
      this.state.set('lastResults', results);
      this.renderAll(results);
      Toast.show('Analysis complete', 'success');
    } catch (err) {
      console.error('Analysis failed:', err);
      Toast.show(err.message, 'error');
    } finally {
      this.state.set('loading', false);
    }
  }

  renderAll(data) {
    // Overview view
    this.renderRiskBanner(data.analyze);
    this.charts.renderTimeline('chartTimeline', data.history);
    this.charts.renderRadar('chartRadar', data.analyze);
    this.charts.renderHotspots('chartHotspots', data.hotspots);

    // Files view
    this.fileBrowser.renderFileList(data.files);
    this.charts.renderFileBars('chartFiles', data.files);

    // Authors view
    this.charts.renderAuthorBars('chartAuthors', data.authors);

    // Evidence
    this.renderEvidence(data.analyze);
  }

  renderRiskBanner(data) {
    const banner = document.getElementById('riskBanner');
    const score = data?.final_risk_score ?? 0;
    const level = this.getRiskLevel(score);
    const color = this.getRiskColor(score);

    banner.innerHTML = `
      <div class="risk-indicator ${color}">
        <span class="risk-badge">${level}</span>
        <span class="risk-score">${score.toFixed(3)}</span>
      </div>
      <div class="risk-meta">
        <span>${data?.commit?.sha?.slice(0, 8) || 'HEAD'}</span>
        <span>•</span>
        <span>${data?.files_analyzed || 0} files</span>
      </div>
    `;
    banner.classList.remove('hidden');
  }

  renderEvidence(data) {
    const list = document.getElementById('evidenceList');
    if (!list) return;

    const items = [];
    
    // Evolution evidence
    (data.evolution_evidence || []).forEach(e => {
      items.push({ text: e, type: 'info' });
    });

    // File evidence
    const files = Object.entries(data.file_results || {})
      .sort(([,a], [,b]) => b.risk_score - a.risk_score)
      .slice(0, 5);

    files.forEach(([path, result]) => {
      const color = this.getRiskColor(result.risk_score);
      items.push({
        text: `${path} (${result.risk_score.toFixed(3)})`,
        type: color,
        details: (result.evidence || []).slice(0, 3)
      });
    });

    list.innerHTML = items.map(item => `
      <li class="evidence-item ${item.type}">
        <div class="evidence-header">${escapeHtml(item.text)}</div>
        ${item.details ? `
          <ul class="evidence-details">
            ${item.details.map(d => `<li>${escapeHtml(d)}</li>`).join('')}
          </ul>
        ` : ''}
      </li>
    `).join('') || '<li class="placeholder">No evidence</li>';
  }

  getRiskLevel(score) {
    if (score >= 0.75) return 'High Risk';
    if (score >= 0.50) return 'Significant Drift';
    if (score >= 0.25) return 'Minor Drift';
    return 'Consistent';
  }

  getRiskColor(score) {
    if (score >= 0.75) return 'red';
    if (score >= 0.50) return 'orange';
    if (score >= 0.25) return 'yellow';
    return 'green';
  }

  loadInitialState() {
    const savedPath = localStorage.getItem('consistency_repo_path');
    if (savedPath) {
      const input = document.getElementById('repoInput');
      if (input) input.value = savedPath;
    }
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  window.app = new ConsistencyApp();
});