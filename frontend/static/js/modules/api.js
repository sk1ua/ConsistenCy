/**
 * API Client
 * Handles all backend communication
 */

export class ApiClient {
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
    this.abortControllers = new Map();
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    
    // Cancel previous request for same endpoint
    if (this.abortControllers.has(endpoint)) {
      this.abortControllers.get(endpoint).abort();
    }
    
    const controller = new AbortController();
    this.abortControllers.set(endpoint, controller);

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        signal: controller.signal,
      });

      this.abortControllers.delete(endpoint);

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      return data;
    } catch (err) {
      this.abortControllers.delete(endpoint);
      if (err.name === 'AbortError') {
        throw new Error('Request cancelled');
      }
      throw err;
    }
  }

  // Single analysis
  async analyze(repoPath, commitSha = null, baselineCommits = 50) {
    return this.request('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({
        repo_path: repoPath,
        commit_sha: commitSha,
        baseline_commits: baselineCommits,
      }),
    });
  }

  // History
  async getHistory(repoPath, weeks = 12) {
    return this.request(`/api/repo/history?repo_path=${encodeURIComponent(repoPath)}&weeks=${weeks}`);
  }

  // Files
  async getFiles(repoPath) {
    return this.request(`/api/repo/files?repo_path=${encodeURIComponent(repoPath)}`);
  }

  // Authors
  async getAuthors(repoPath) {
    return this.request(`/api/repo/authors?repo_path=${encodeURIComponent(repoPath)}`);
  }

  // Hotspots
  async getHotspots(repoPath) {
    return this.request(`/api/repo/hotspots?repo_path=${encodeURIComponent(repoPath)}`);
  }

  // PR Report
  async analyzePR(repoPath, baseRef, headRef = 'HEAD', options = {}) {
    return this.request('/api/pr/report', {
      method: 'POST',
      body: JSON.stringify({
        repo_path: repoPath,
        base_ref: baseRef,
        head_ref: headRef,
        baseline_commits: options.baselineCommits || 50,
        max_commits: options.maxCommits || 40,
      }),
    });
  }

  // Analyze range
  async analyzeRange(repoPath, weeks = 12, options = {}) {
    return this.request('/api/analyze-range', {
      method: 'POST',
      body: JSON.stringify({
        repo_path: repoPath,
        weeks: weeks,
        baseline_commits: options.baselineCommits || 50,
        max_commits: options.maxCommits || 40,
      }),
    });
  }

  // Export
  async export(repoPath, format = 'json', weeks = 12) {
    return this.request('/api/export', {
      method: 'POST',
      body: JSON.stringify({
        repo_path: repoPath,
        format: format,
        weeks: weeks,
      }),
    });
  }

  // Compare files
  async compareFiles(fileNow, fileBase) {
    return this.request('/api/compare', {
      method: 'POST',
      body: JSON.stringify({
        file_now: fileNow,
        file_base: fileBase,
      }),
    });
  }

  // Parallel analysis - all at once
  async analyzeAll(repoPath) {
    const [analyze, history, files, authors, hotspots] = await Promise.all([
      this.analyze(repoPath),
      this.getHistory(repoPath),
      this.getFiles(repoPath),
      this.getAuthors(repoPath),
      this.getHotspots(repoPath),
    ]);

    return {
      analyze,
      history,
      files,
      authors,
      hotspots,
    };
  }
}