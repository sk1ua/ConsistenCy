/**
 * PR Analyzer
 * Analyze pull requests and show reports
 */

export class PrAnalyzer {
  constructor(api) {
    this.api = api;
  }

  async analyze(repoPath, baseRef, headRef, options = {}) {
    try {
      const result = await this.api.analyzePR(repoPath, baseRef, headRef, options);
      this.renderReport(result);
      return result;
    } catch (err) {
      throw new Error(`PR analysis failed: ${err.message}`);
    }
  }

  renderReport(report) {
    const container = document.getElementById('prReport');
    if (!container) return;

    const avgRisk = report.avg_risk ?? 0;
    const maxRisk = report.max_risk ?? 0;
    const color = this.getRiskColor(avgRisk);

    container.innerHTML = `
      <div class="pr-summary card glass">
        <div class="pr-header">
          <h3>PR Risk Analysis</h3>
          <div class="pr-stats">
            <div class="stat">
              <span class="stat-value ${color}">${avgRisk.toFixed(3)}</span>
              <span class="stat-label">Avg Risk</span>
            </div>
            <div class="stat">
              <span class="stat-value">${maxRisk.toFixed(3)}</span>
              <span class="stat-label">Max Risk</span>
            </div>
            <div class="stat">
              <span class="stat-value">${report.commit_count || 0}</span>
              <span class="stat-label">Commits</span>
            </div>
            <div class="stat">
              <span class="stat-value">${report.high_risk_commits || 0}</span>
              <span class="stat-label">High Risk</span>
            </div>
          </div>
        </div>

        ${this.renderFormula(report.risk_composition)}
        ${this.renderTopFiles(report.top_risky_files)}
        ${this.renderCommits(report.commits)}
        ${this.renderSecurity(report.security_findings)}
      </div>
    `;
  }

  renderFormula(composition) {
    if (!composition) return '';
    
    return `
      <div class="formula-section">
        <h4>Risk Formula</h4>
        <div class="formula-box">
          <code>${escapeHtml(composition.formula || '')}</code>
        </div>
        ${composition.components_avg ? `
          <div class="composition-bars">
            ${Object.entries(composition.components_avg).map(([key, val]) => `
              <div class="comp-item">
                <span class="comp-label">${key}</span>
                <div class="comp-bar-bg">
                  <div class="comp-bar" style="width: ${(val * 100).toFixed(1)}%"></div>
                </div>
                <span class="comp-value">${(val * 100).toFixed(1)}%</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  renderTopFiles(files) {
    if (!files?.length) return '';

    return `
      <div class="top-files-section">
        <h4>Highest Risk Files</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Avg Risk</th>
              <th>Max Risk</th>
              <th>Churn</th>
              <th>Complexity</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            ${files.slice(0, 10).map(f => `
              <tr>
                <td class="file-cell" title="${escapeHtml(f.file)}">${escapeHtml(f.file)}</td>
                <td class="risk-cell ${this.getRiskColor(f.avg_risk)}">${f.avg_risk.toFixed(3)}</td>
                <td>${f.max_risk.toFixed(3)}</td>
                <td>${f.churn_lines || 0}</td>
                <td>${(f.complexity || 0).toFixed(1)}</td>
                <td>${f.owner || 'unknown'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  renderCommits(commits) {
    if (!commits?.length) return '';

    return `
      <div class="commits-section">
        <h4>Commit Breakdown</h4>
        <div class="commits-list">
          ${commits.slice(0, 10).map(c => `
            <div class="commit-item">
              <span class="commit-sha">${c.sha?.slice(0, 8)}</span>
              <span class="commit-author">${escapeHtml(c.author)}</span>
              <span class="commit-risk ${this.getRiskColor(c.risk_score)}">${c.risk_score.toFixed(3)}</span>
              <span class="commit-msg" title="${escapeHtml(c.message)}">${escapeHtml(c.message?.slice(0, 50) || '')}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  renderSecurity(findings) {
    if (!findings?.length) return '';

    return `
      <div class="security-section">
        <h4>🛡️ Security Findings</h4>
        <div class="security-list">
          ${findings.slice(0, 10).map(f => `
            <div class="security-item ${f.evidence?.includes('CRITICAL') ? 'critical' : f.evidence?.includes('HIGH') ? 'high' : 'medium'}">
              <span class="sec-file">${escapeHtml(f.filepath)}</span>
              <span class="sec-evidence">${escapeHtml(f.evidence)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  getRiskColor(score) {
    if (score >= 0.75) return 'red';
    if (score >= 0.50) return 'orange';
    if (score >= 0.25) return 'yellow';
    return 'green';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}