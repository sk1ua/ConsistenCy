import { useState, useMemo, useRef, useEffect, type KeyboardEvent } from "react";
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
import { useI18n } from "../i18n";
import { StatusBadge } from "../components/StatusBadge";
import { Button, ButtonLink } from "../design-system/Button";
import { ApiRequestError } from "../api/client";

function localRepositoryName(pulse: HeartbeatPulse): string {
  if (pulse.repository.root === "unknown") return "Local repository";
  const segments = pulse.repository.root.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? "Local repository";
}

export function publicRepositoryErrorMessage(error: unknown, zh: boolean): string | undefined {
  if (!error) return undefined;
  const code = error instanceof ApiRequestError ? error.code : undefined;
  const messages: Record<string, [string, string]> = {
    PUBLIC_REPOSITORY_INVALID_INPUT: ["Enter owner/repository or a canonical GitHub URL.", "请输入 owner/repository 或规范的 GitHub URL。"],
    PUBLIC_REPOSITORY_UNSUPPORTED_HOST: ["Only public repositories on github.com are supported.", "仅支持 github.com 上的公开仓库。"],
    PUBLIC_REPOSITORY_NOT_FOUND: ["The public repository was not found or is unavailable.", "未找到该公开仓库，或仓库当前不可用。"],
    PUBLIC_REPOSITORY_AUTH_REQUIRED: ["This repository is private or requires GitHub authentication.", "该仓库为私有仓库或需要 GitHub 身份验证。"],
    PUBLIC_REPOSITORY_RATE_LIMITED: ["GitHub rate limit reached. Try again after the limit resets.", "已达到 GitHub 速率限制，请在限制重置后重试。"],
    PUBLIC_REPOSITORY_PROVIDER_UNAVAILABLE: ["GitHub is temporarily unavailable. Try again later.", "GitHub 暂时不可用，请稍后重试。"],
    PUBLIC_REPOSITORY_CONNECTION_UNAVAILABLE: ["Public repository connection is unavailable.", "公开仓库连接当前不可用。"]
  };
  const message = code === undefined ? undefined : messages[code];
  if (message) return message[zh ? 1 : 0];
  return zh ? "无法连接公开仓库，请重试。" : "Could not connect the public repository. Try again.";
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
  connectingPublicRepository = false,
  publicRepositoryError,
  onConnectPublicRepository,
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
  connectingPublicRepository?: boolean;
  publicRepositoryError?: unknown;
  onConnectPublicRepository?: (input: string) => Promise<Repository>;
  monitoringRepositoryId?: string;
  onSetMonitoring?: (repository: Repository, enabled: boolean) => void;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [filterQuery, setFilterQuery] = useState("");
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [publicRepoInput, setPublicRepoInput] = useState("");
  const connectButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (connectModalOpen) {
      firstInputRef.current?.focus();
    }
  }, [connectModalOpen]);

  function closeConnectModal() {
    setConnectModalOpen(false);
    window.requestAnimationFrame(() => connectButtonRef.current?.focus());
  }

  function handleModalKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeConnectModal();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(modalRef.current?.querySelectorAll<HTMLElement>("input, button:not([disabled]), [tabindex='0']") ?? [])]
      .filter(el => !el.hasAttribute("disabled") && el.offsetParent !== null);
    if (focusable.length === 0) return;
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex >= focusable.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }

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
        id: `pulse-${name}`,
        name,
        branch: pulse.repository.branch ?? "detached",
        isLive: true
      });
    }
    return list.filter(r => r.name.toLowerCase().includes(filterQuery.toLowerCase()));
  }, [repositories, pulse, filterQuery]);

  // Remote / public connected repositories (canonical remote identity only).
  const remoteRepos = useMemo(() => {
    const list: Array<{ id: string; name: string; branch: string; reviewCount: number; raw?: Repository }> = [];
    const canonicalRemoteNames = new Set(
      repositories.flatMap(repository => repository.remoteFullName ? [repository.remoteFullName.toLowerCase()] : [])
    );
    for (const repository of repositories) {
      if (repository.source !== "local_git") {
        list.push({
          id: repository.id,
          name: repository.displayName,
          branch: repository.defaultBranch ?? "main",
          reviewCount: 0,
          raw: repository
        });
      }
    }
    for (const source of sources) {
      if (!canonicalRemoteNames.has(source.name.toLowerCase())) {
        list.push({ id: `source-${source.name}`, name: source.name, branch: "main", reviewCount: source.jobs.length });
      }
    }
    return list.filter(repository => repository.name.toLowerCase().includes(filterQuery.toLowerCase()));
  }, [repositories, sources, filterQuery]);

  async function handleConnectPublic(e: React.FormEvent) {
    e.preventDefault();
    const input = publicRepoInput.trim();
    if (!input || !onConnectPublicRepository || connectingPublicRepository) return;
    try {
      await onConnectPublicRepository(input);
      setConnectModalOpen(false);
      setPublicRepoInput("");
    } catch {
      // The mutation error is rendered inline below the field.
    }
  }

  const publicConnectErrorMessage = publicRepositoryErrorMessage(publicRepositoryError, zh);

  return (
    <div className="repository-hub-page page-stack">
      {/* Intro Header */}
      <section className="section-block repo-hub-intro">
        <div className="hub-intro-left">
          <span className="panel-kicker"><FolderGit2 size={13} />{zh ? "代码仓库" : "Repositories"}</span>
          <h2>{zh ? "已连接仓库" : "Connected Repositories"}</h2>
          <p>{zh ? "查看 Git 状态、提交历史与拉取请求，并发起代码审查。" : "Inspect Git status, commits, pull requests, and launch code reviews."}</p>
        </div>

        <div className="hub-intro-actions">
          <Button ref={connectButtonRef} variant="primary" type="button" className="connect-btn-main"
            aria-haspopup="dialog"
            aria-expanded={connectModalOpen}
            onClick={() => setConnectModalOpen(true)}
          >
            <FolderPlus size={14} /> {zh ? "连接仓库" : "Connect repository"}
          </Button>
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
          <span><strong>{localRepos.length + remoteRepos.length}</strong> {zh ? "个已观察仓库" : "observed repositories"}</span>
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
                   {repo.raw?.trustLevel && (
                     <small>{repo.raw.trustLevel === "trusted_local" ? (zh ? "受信本地" : "trusted local") : (zh ? "只读" : "read-only")}</small>
                   )}
                  <code><GitBranch size={11} /> {repo.branch}</code>
                </div>
                <div className="repo-row-actions">
                  {repo.raw && (
                    <ButtonLink to={`/repositories/${encodeURIComponent(repo.id)}`} variant="primary" size="sm">
                      {zh ? "打开" : "Open"}
                    </ButtonLink>
                  )}
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
                  {repo.raw && (
                    <ButtonLink to={`/repositories/${encodeURIComponent(repo.id)}`} variant="primary" size="sm">
                      {zh ? "打开" : "Open"}
                    </ButtonLink>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Connect Repository Modal */}
      {connectModalOpen && (
        <div className="modal-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) closeConnectModal(); }}>
          <div
            ref={modalRef}
            className="modal-card connect-repo-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-repo-modal-title"
            onKeyDown={handleModalKeyDown}
          >
            <div className="modal-header">
              <div>
                <span className="panel-kicker">{zh ? "接入代码" : "Repository Workspace"}</span>
                <h3 id="connect-repo-modal-title">{zh ? "连接代码仓库" : "Connect Repository"}</h3>
              </div>
              <button type="button" className="drawer-close-btn" aria-label={zh ? "关闭" : "Close"} onClick={closeConnectModal}><X size={16} /></button>
            </div>
            <div className="modal-body">
              {/* Option 1: Local */}
              {canSelectRepository && (
                <div className="connect-option-block">
                  <div className="option-head">
                    <FolderGit2 size={20} />
                    <div>
                      <strong>{zh ? "本地 Git 仓库" : "Local Git Repository"}</strong>
                      <p>{zh ? "通过受保护的系统目录选择器打开本地工作树，路径安全隔离" : "Select a local worktree via privileged desktop dialog"}</p>
                    </div>
                  </div>
                  <Button variant="primary" type="button" className="connect-action-btn" onClick={() => { closeConnectModal(); onAddRepository?.(); }}>
                    <FolderPlus size={15} /> {zh ? "选择本地文件夹" : "Select local folder"}
                  </Button>
                </div>
              )}

              {/* Option 2: Public GitHub */}
              <form onSubmit={handleConnectPublic} className="connect-option-block">
                <div className="option-head">
                  <Github size={20} />
                  <div>
                    <strong>{zh ? "公开 GitHub 仓库" : "Public GitHub Repository"}</strong>
                    <p>{zh ? "输入 owner/repo 或 GitHub URL，直接浏览 PR 与代码并启动只读审查" : "Enter owner/repo or URL to inspect PRs and launch read-only review"}</p>
                  </div>
                </div>
                <div className="public-connect-input-group">
                  <input
                    ref={firstInputRef}
                    type="text"
                    aria-label={zh ? "公开 GitHub 仓库地址" : "Public GitHub repository URL"}
                    placeholder="e.g. openai/codex or https://github.com/owner/repo"
                    value={publicRepoInput}
                    disabled={connectingPublicRepository}
                    aria-describedby={publicConnectErrorMessage ? "public-repository-connect-error" : undefined}
                    onChange={e => setPublicRepoInput(e.target.value)}
                  />
                  <Button
                    variant="primary"
                    type="submit"
                    className="connect-action-btn"
                    disabled={!publicRepoInput.trim() || connectingPublicRepository || !onConnectPublicRepository}
                  >
                    {connectingPublicRepository && <LoaderCircle size={14} className="spinning" />}
                    {connectingPublicRepository ? (zh ? "正在连接" : "Connecting") : (zh ? "连接" : "Connect")}
                  </Button>
                </div>
                {publicConnectErrorMessage && (
                  <div id="public-repository-connect-error" className="route-query-notice" role="alert">
                    <strong>{zh ? "无法连接仓库" : "Could not connect repository"}</strong>
                    <span>{publicConnectErrorMessage}</span>
                  </div>
                )}
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
