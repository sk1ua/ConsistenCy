/**
 * File Browser
 * Browse and analyze individual files
 */

export class FileBrowser {
  constructor(api) {
    this.api = api;
    this.currentFilter = '';
    this.sortBy = 'risk';
  }

  renderFileList(files) {
    const container = document.getElementById('fileList');
    if (!container) return;

    if (!files?.length) {
      container.innerHTML = '<div class="empty-state">No files analyzed</div>';
      return;
    }

    // Sort files
    const sorted = [...files].sort((a, b) => {
      switch (this.sortBy) {
        case 'risk': return b.risk_score - a.risk_score;
        case 'name': return a.file.localeCompare(b.file);
        case 'level': return b.risk_score - a.risk_score;
        default: return 0;
      }
    });

    // Filter
    const filtered = this.currentFilter
      ? sorted.filter(f => f.file.toLowerCase().includes(this.currentFilter.toLowerCase()))
      : sorted;

    container.innerHTML = filtered.map(file => this.renderFileItem(file)).join('');

    // Bind click events
    container.querySelectorAll('.file-item').forEach(el => {
      el.addEventListener('click', () => this.showFileDetails(el.dataset.path));
    });
  }

  renderFileItem(file) {
    const color = this.getRiskColor(file.risk_score);
    const level = this.getRiskLevel(file.risk_score);

    return `
      <div class="file-item" data-path="${escapeHtml(file.file)}">
        <div class="file-risk-indicator ${color}"></div>
        <div class="file-info">
          <div class="file-path">${escapeHtml(file.file)}</div>
          <div class="file-meta">
            <span class="risk-badge ${color}">${level}</span>
            <span class="score">${file.risk_score.toFixed(3)}</span>
          </div>
        </div>
        <div class="file-breakdown">
          ${this.renderBreakdown(file.breakdown)}
        </div>
      </div>
    `;
  }

  renderBreakdown(bd) {
    if (!bd) return '';
    return `
      <div class="breakdown-bars">
        <div class="bar" style="width: ${(bd.style || 0) * 100}%; background: #8b5cf6;" title="Style: ${((bd.style || 0) * 100).toFixed(0)}%"></div>
        <div class="bar" style="width: ${(bd.structural || 0) * 100}%; background: #3b82f6;" title="Structural: ${((bd.structural || 0) * 100).toFixed(0)}%"></div>
        <div class="bar" style="width: ${(bd.semantic || 0) * 100}%; background: #10b981;" title="Semantic: ${((bd.semantic || 0) * 100).toFixed(0)}%"></div>
      </div>
    `;
  }

  async showFileDetails(filePath) {
    // Show modal with file details
    const modal = document.getElementById('fileModal');
    const content = modal.querySelector('.modal-body');
    
    content.innerHTML = '<div class="loading">Loading file details...</div>';
    modal.classList.add('active');

    try {
      // In real implementation, fetch file content from backend
      content.innerHTML = `
        <div class="file-detail-header">
          <h3>${escapeHtml(filePath)}</h3>
          <button class="btn-close">&times;</button>
        </div>
        <div class="file-detail-content">
          <p>File analysis details would be shown here.</p>
          <p>Compare with baseline, view diff, etc.</p>
        </div>
      `;
    } catch (err) {
      content.innerHTML = `<div class="error">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  setFilter(filter) {
    this.currentFilter = filter;
  }

  setSort(sortBy) {
    this.sortBy = sortBy;
  }

  getRiskColor(score) {
    if (score >= 0.75) return 'red';
    if (score >= 0.50) return 'orange';
    if (score >= 0.25) return 'yellow';
    return 'green';
  }

  getRiskLevel(score) {
    if (score >= 0.75) return 'High';
    if (score >= 0.50) return 'Significant';
    if (score >= 0.25) return 'Minor';
    return 'OK';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}