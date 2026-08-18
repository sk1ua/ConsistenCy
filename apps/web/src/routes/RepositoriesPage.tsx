import { useState, useMemo } from "react";
import type { HeartbeatPulse, Repository, ReviewJob } from "@consistency/schema";
import {
  Activity,
  ArrowRight,
  Clock3,
  FolderGit2,
  FolderPlus,
  GitBranch,
  Github,
  History,
  Layers,
  LoaderCircle,
  PauseCircle,
  Play,
  PlayCircle,
  Radio,
  Search,
  ShieldCheck,
  X
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "../i18n";
import { StatusBadge } from "../components/StatusBadge";

function localRepositoryName(pulse: HeartbeatPulse): string {
  if (pulse.repository.root === "unknown") return "Local repository";
  const segments = pulse.repository.root.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? "Local repository";
}

function isFixtureRepo(name: string): boolean {
  return name.startsWith("acme/") || name.startsWith("studio/");
}

export function RepositoriesPage({
  jobs,
  pulse,
  heartbeatUnavailable,
  jobsUnavailable,
  repositories = [],
  registryUnavailable = false,
  canSelectRepository = false,
  addingRepository = false,
  addRepositoryError,
  monitoringError,
  onAddRepository,
  monitoringRepositoryId,
  onSetMonitoring
}: {
  jobs: ReviewJob[];
  pulse: HeartbeatPulse | null;
  heartbeatUnavailable: boolean;
  jobsUnavailable: boolean;
  repositories?: Repository[];
  registryUnavailable?: boolean;
  canSelectRepository?: boolean;
  addingRepository?: boolean;
  addRepositoryError?: string;
  monitoringError?: string;
  onAddRepository?: () => void;
  monitoringRepositoryId?: string;
  onSetMonitoring?: (repository: Repository, enabled: boolean) => void;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const [filterQuery, setFilterQuery] = useState("");
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [publicRepoInput, setPublicRepoInput] = useState("");

  const sources = useMemo(() => {
    const byName = new Map<string, { name: string; jobs: ReviewJob[] }>();
    for (const job of [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const current = byName.get(job.repositoryFullName);
      if (current) current.jobs.push(job);
      else byName.set(job.repositoryFullName, { name: job.repositoryFullName, jobs: [job] });
    }
    return [...byName.values()];
  }, [jobs]);

  // Local repositories: registered local + live pulse
  const localRepos = useMemo(() => {
    const list: Array<{ id: string; name: string; branch: string; isLive: boolean; raw?: Repository }> = [];
    for (const r of repositories) {
      if (r.source === "local_git") {
        list.push({ id: r.id, name: r.displayName, branch: r.defaultBranch ?? "main", isLive: false, raw: r });
      }
    }
    if (pulse && !list.some(l => l.name === localRepositoryName(pulse))) {
      const name = localRepositoryName(pulse);
      list.push({
        id: name.includes("ConsistenCy") ? "sk1ua/ConsistenCy" : `local:${name}`,
        name,
        branch: pulse.repository.branch ?? "detached",
        isLive: true
      });
    }
    return list.filter(r => r.name.toLowerCase().includes(filterQuery.toLowerCase()));
  }, [repositories, pulse, filterQuery]);

  // Remote / public connected repositories (non-fixture and not unified local)
  const remoteRepos = useMemo(() => {
    const list: Array<{ id: string; name: string; branch: string; reviewCount: number; raw?: Repository }> = [];
    const localNames = new Set(localRepos.map(l => l.name));
    for (const r of repositories) {
      if (r.source !== "local_git" && !isFixtureRepo(r.remoteFullName ?? r.displayName)) {
        if (localNames.has("ConsistenCy-pr2-clean") && (r.remoteFullName === "sk1ua/ConsistenCy" || r.displayName === "ConsistenCy")) continue;
        list.push({ id: r.id, name: r.displayName, branch: r.defaultBranch ?? "main", reviewCount: 0, raw: r });
      }
    }
    for (const s of sources) {
      if (!isFixtureRepo(s.name) && !repositories.some(r => r.remoteFullName === s.name || r.displayName === s.name)) {
        if (localNames.has("ConsistenCy-pr2-clean") && s.name === "sk1ua/ConsistenCy") continue;
        list.push({ id: s.name, name: s.name, branch: "main", reviewCount: s.jobs.length });
      }
    }
    return list.filter(r => r.name.toLowerCase().includes(filterQuery.toLowerCase()));
  }, [repositories, sources, localRepos, filterQuery]);

  // Demo / Fixture repositories
  const fixtureRepos = useMemo(() => {
    const list: Array<{ id: string; name: string; latestJob?: ReviewJob; reviewCount: number }> = [];
    for (const s of sources) {
      if (isFixtureRepo(s.name)) {
        list.push({ id: s.name, name: s.name, latestJob: s.jobs[0], reviewCount: s.jobs.length });
      }
    }
    return list.filter(r => r.name.toLowerCase().includes(filterQuery.toLowerCase()));
  }, [sources, filterQuery]);

  function handleConnectPublic(e: React.FormEvent) {
    e.preventDefault();
    if (!publicRepoInput.trim()) return;
    setConnectModalOpen(false);
    navigate(`/repositories/${encodeURIComponent(publicRepoInput.trim())}`);
  }

  return (
    <div className="repository-hub-page page-stack">
      {/* Intro Header */}
      <section className="section-block repo-hub-intro">
        <div className="hub-intro-left">
          <span className="panel-kicker"><FolderGit2 size={13} />{zh ? "代码仓库" : "Repositories"}</span>
          <h2>{zh ? "已连接仓库与工作区" : "Connected Repositories"}</h2>
          <p>{zh ? "以仓库为核心：查看本地 Git 状态、浏览提交历史与拉取请求，并直接发起 ConsistenCy 多智能体代码审查。" : "Project-first workspace: inspect local Git status, commits, pull requests, and launch multi-agent reviews."}</p>
        </div>

        <div className="hub-intro-actions">
          <button
            type="button"
            className="primary-button connect-btn-main"
            onClick={() => setConnectModalOpen(true)}
          >
            <FolderPlus size={14} /> {zh ? "连接仓库" : "Connect repository"}
          </button>
        </div>
      </section>

      {/* Search & Stats Filter */}
      <div className="repo-hub-search-bar">
        <div className="search-input-wrap">
          <Search size={14} className="search-icon" />
          <input
            type="text"
            placeholder={zh ? "筛选代码仓库..." : "Filter repositories..."}
            value={filterQuery}
            onChange={e => setFilterQuery(e.target.value)}
          />
        </div>
        <div className="hub-counts">
          <span><strong>{localRepos.length + remoteRepos.length + fixtureRepos.length}</strong> {zh ? "个已观察仓库" : "observed repositories"}</span>
        </div>
      </div>

      {addRepositoryError && (
        <div className="route-query-notice" role="alert">
          <strong>{zh ? "无法注册仓库" : "Could not register repository"}</strong>
          <span>{addRepositoryError}</span>
        </div>
      )}

      {/* Section 1: Local Repositories */}
      <section className="section-block repo-group-section">
        <div className="panel-title">
          <div>
            <span className="panel-kicker">{zh ? "本地文件系统" : "Local Workspace"}</span>
            <h2>{zh ? "本地代码仓库" : "Local Repositories"}</h2>
          </div>
          <strong>{localRepos.length}</strong>
        </div>

        {localRepos.length === 0 ? (
          <div className="empty-inline-compact">{zh ? "暂无已连接的本地 Git 仓库。" : "No local Git repositories connected."}</div>
        ) : (
          <div className="repo-table-rows" role="list">
            {localRepos.map(repo => (
              <div key={repo.id} className="repo-table-row" role="listitem">
                <div className="repo-row-title">
                  <span className={`repo-dot ${repo.isLive || repo.raw?.monitoringEnabled ? "monitored" : ""}`} />
                  <FolderGit2 size={16} className="card-repo-icon" />
                  <strong>{repo.name}</strong>
                  <span className="provenance-pill">{zh ? "本地 GIT" : "LOCAL GIT"}</span>
                  {repo.isLive && <span className="status-pill telemetry-live">{zh ? "实时监控中" : "LIVE MONITOR"}</span>}
                </div>
                <div className="repo-row-meta">
                  <small>{repo.raw?.trustLevel === "trusted_local" ? (zh ? "受信本地" : "trusted local") : (zh ? "只读" : "read-only")}</small>
                  <code><GitBranch size={11} /> {repo.branch}</code>
                </div>
                <div className="repo-row-actions">
                  <Link to={`/repositories/${encodeURIComponent(repo.id)}`} className="primary-button btn-small">
                    {zh ? "打开" : "Open"}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section 2: Remote / Public Connected Repositories */}
      {remoteRepos.length > 0 && (
        <section className="section-block repo-group-section">
          <div className="panel-title">
            <div>
              <span className="panel-kicker">{zh ? "远端源" : "Remote Sources"}</span>
              <h2>{zh ? "已连接远端仓库" : "Connected Remote Repositories"}</h2>
            </div>
            <strong>{remoteRepos.length}</strong>
          </div>

          <div className="repo-table-rows" role="list">
            {remoteRepos.map(repo => (
              <div key={repo.id} className="repo-table-row" role="listitem">
                <div className="repo-row-title">
                  <FolderGit2 size={16} className="card-repo-icon" />
                  <strong>{repo.name}</strong>
                  <span className="provenance-pill">{zh ? "GITHUB 公开" : "GITHUB PUBLIC"}</span>
                </div>
                <div className="repo-row-meta">
                  <code><GitBranch size={11} /> {repo.branch}</code>
                  {repo.reviewCount > 0 && <small>{repo.reviewCount} {zh ? "次审查" : "reviews"}</small>}
                </div>
                <div className="repo-row-actions">
                  <Link to={`/repositories/${encodeURIComponent(repo.id)}`} className="primary-button btn-small">
                    {zh ? "打开" : "Open"}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Section 3: Demo / Fixture Repositories */}
      <section className="section-block repo-group-section">
        <div className="panel-title">
          <div>
            <span className="panel-kicker">{zh ? "演示与测试样例" : "Demo Samples"}</span>
            <h2>{zh ? "演示数据仓库" : "Demo / Fixture Repositories"}</h2>
          </div>
          <span className="provenance-pill demo-provenance">{zh ? "演示数据" : "FIXTURE"}</span>
        </div>

        <div className="repo-table-rows" role="list">
          {fixtureRepos.map(repo => (
            <div key={repo.name} className="repo-table-row" role="listitem">
              <div className="repo-row-title">
                <FolderGit2 size={16} className="card-repo-icon muted" />
                <strong>{repo.name}</strong>
                <span className="provenance-pill demo-provenance">{zh ? "演示数据" : "FIXTURE"}</span>
              </div>
              <div className="repo-row-meta">
                <small>{repo.reviewCount} {zh ? "次历史审查" : "reviews"}</small>
                {repo.latestJob?.report && (
                  <span className="score-mini-pill">
                    <strong>{repo.latestJob.report.score}</strong>
                    <StatusBadge value={repo.latestJob.report.riskLevel} />
                  </span>
                )}
              </div>
              <div className="repo-row-actions">
                <Link to={`/repositories/${encodeURIComponent(repo.name)}`} className="primary-button btn-small">
                  {zh ? "打开" : "Open"}
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Connect Repository Modal */}
      {connectModalOpen && (
        <div className="modal-backdrop" onClick={() => setConnectModalOpen(false)}>
          <div className="modal-card connect-repo-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <span className="panel-kicker">{zh ? "接入代码" : "Repository Workspace"}</span>
                <h3>{zh ? "连接代码仓库" : "Connect Repository"}</h3>
              </div>
              <button type="button" className="drawer-close-btn" onClick={() => setConnectModalOpen(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              {/* Option 1: Local */}
              {canSelectRepository && (
                <div className="connect-option-block">
                  <div className="option-head">
                    <FolderGit2 size={18} />
                    <div>
                      <strong>{zh ? "本地 Git 仓库" : "Local Git Repository"}</strong>
                      <p>{zh ? "通过受保护的系统目录选择器打开本地工作树，路径安全隔离" : "Select a local worktree via privileged desktop dialog"}</p>
                    </div>
                  </div>
                  <button type="button" className="primary-button btn-small" onClick={() => { setConnectModalOpen(false); onAddRepository?.(); }}>
                    <FolderPlus size={14} /> {zh ? "选择本地文件夹" : "Select local folder"}
                  </button>
                </div>
              )}

              {/* Option 2: Public GitHub */}
              <form onSubmit={handleConnectPublic} className="connect-option-block">
                <div className="option-head">
                  <Github size={18} />
                  <div>
                    <strong>{zh ? "公开 GitHub 仓库" : "Public GitHub Repository"}</strong>
                    <p>{zh ? "输入 owner/repo 或 GitHub URL，直接浏览 PR 与代码并启动只读审查" : "Enter owner/repo or URL to inspect PRs and launch read-only review"}</p>
                  </div>
                </div>
                <div className="public-connect-input-group">
                  <input
                    type="text"
                    placeholder="e.g. openai/codex or github.com/owner/repo"
                    value={publicRepoInput}
                    onChange={e => setPublicRepoInput(e.target.value)}
                  />
                  <button type="submit" className="primary-button btn-small" disabled={!publicRepoInput.trim()}>
                    {zh ? "连接" : "Connect"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
