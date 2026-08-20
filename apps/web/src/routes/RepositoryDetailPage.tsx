import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Automation,
  HeartbeatPulse,
  PullRequestSummary,
  Repository,
  ReviewJob,
  VcsCommitSummary
} from "@consistency/schema";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileCode2,
  FileSearch2,
  FolderGit2,
  GitBranch,
  GitCommit,
  GitPullRequest,
  History,
  Layers,
  LoaderCircle,
  Play,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  X
} from "lucide-react";
import { Link, NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, type HealthResponse } from "../api/client";
import { useI18n } from "../i18n";
import { workspaceQueryKeys } from "../query/client";
import { safeRequestError } from "../query/safeRequestError";
import { StatusBadge } from "../components/StatusBadge";

function localRepositoryName(pulse: HeartbeatPulse): string {
  if (pulse.repository.root === "unknown") return "Local repository";
  return pulse.repository.root.split(/[\\/]/).filter(Boolean).at(-1) ?? "Local repository";
}

type RepositoryView = "overview" | "changes" | "history" | "pull-requests" | "runs" | "evolution" | "findings" | "automations" | "audit-log";

function CommitDetailModal({
  commit,
  zh,
  onClose
}: {
  commit: VcsCommitSummary;
  zh: boolean;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card commit-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="panel-kicker">{zh ? "提交详情" : "Commit Details"}</span>
            <h3><code>{commit.sha.slice(0, 10)}</code></h3>
          </div>
          <button type="button" className="drawer-close-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <p className="commit-full-message">{commit.message}</p>
          <div className="kv-grid">
            <div>
              <strong>{zh ? "作者" : "Author"}</strong>
              <span>{commit.author.name} {commit.author.email ? `<${commit.author.email}>` : ""}</span>
            </div>
            <div>
              <strong>{zh ? "提交时间" : "Authored"}</strong>
              <span>{new Date(commit.authoredAt).toLocaleString()}</span>
            </div>
            <div>
              <strong>{zh ? "父提交" : "Parents"}</strong>
              <div className="parent-shas-list">
                {commit.parentShas.length === 0 ? <span>{zh ? "无 (根提交)" : "None (Root)"}</span>
                  : commit.parentShas.map(p => <code key={p}>{p.slice(0, 8)}</code>)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewComposerModal({
  displayName,
  branch,
  defaultBranch,
  headSha,
  dirtyCount,
  health,
  submitting = false,
  error,
  zh,
  onClose,
  onStartReview
}: {
  displayName: string;
  branch?: string | null;
  defaultBranch?: string | null;
  headSha?: string | null;
  dirtyCount: number;
  health?: HealthResponse;
  submitting?: boolean;
  error?: string;
  zh: boolean;
  onClose: () => void;
  onStartReview: (options: {
    source: "working_tree" | "branch";
    baseRef?: string;
    headRef?: string;
    modelOverride?: { provider: "deepseek" | "openai"; model: string };
  }) => void;
}) {
  const hasWorkingTreeChanges = dirtyCount > 0;
  const [source, setSource] = useState<"working_tree" | "branch">(hasWorkingTreeChanges ? "working_tree" : "branch");

  const defaultProvider = (health?.llmProvider && health.llmProvider !== "none")
    ? (health.llmProvider as "deepseek" | "openai")
    : (health?.llmCapabilities?.deepseek?.configured ? "deepseek" : health?.llmCapabilities?.openai?.configured ? "openai" : "none");

  const defaultModel = health?.llmModel || (
    defaultProvider === "deepseek"
      ? (health?.llmCapabilities?.deepseek?.defaultModel || "deepseek-v4-flash")
      : defaultProvider === "openai"
      ? (health?.llmCapabilities?.openai?.defaultModel || "gpt-4.1-mini")
      : ""
  );

  const [isCustomModel, setIsCustomModel] = useState(false);
  const [overrideProvider, setOverrideProvider] = useState<"deepseek" | "openai">(defaultProvider === "openai" ? "openai" : "deepseek");
  const [overrideModel, setOverrideModel] = useState("");

  const deepseekConfigured = Boolean(health?.llmCapabilities?.deepseek?.configured ?? (health?.llmProvider === "deepseek"));
  const openaiConfigured = Boolean(health?.llmCapabilities?.openai?.configured ?? (health?.llmProvider === "openai"));

  const targetModelName = isCustomModel
    ? (overrideModel.trim() || (overrideProvider === "deepseek" ? "deepseek-v4-flash" : "gpt-4.1-mini"))
    : defaultModel;

  const resolvedProvider = isCustomModel ? overrideProvider : (defaultProvider !== "none" ? defaultProvider : undefined);

  const canStart = Boolean(
    (source === "branch" || hasWorkingTreeChanges) &&
    resolvedProvider &&
    targetModelName &&
    !submitting
  );

  const validationHint = !hasWorkingTreeChanges && source === "working_tree"
    ? (zh ? "当前工作区没有未提交变更，请选择当前分支变更" : "Clean working tree; select current branch changes")
    : !resolvedProvider
    ? (zh ? "尚未配置大语言模型，请前往设置页配置" : "LLM not configured; configure in settings first")
    : isCustomModel && !overrideModel.trim() && !targetModelName
    ? (zh ? "请输入模型名称" : "Enter model name")
    : undefined;

  const targetBranchText = defaultBranch
    ? `${branch ?? "HEAD"} → ${defaultBranch}`
    : `${branch ?? "HEAD"} (${zh ? "默认分支未知" : "default branch unknown"})`;

  function handleSubmit() {
    if (!canStart || !resolvedProvider) return;
    onStartReview({
      source,
      baseRef: defaultBranch ?? "main",
      headRef: branch ?? "HEAD",
      modelOverride: isCustomModel ? { provider: overrideProvider, model: targetModelName } : undefined
    });
  }

  return (
    <div className="modal-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="modal-card review-composer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-composer-title"
        onKeyDown={e => { if (e.key === "Escape") onClose(); }}
      >
        <div className="modal-header">
          <div>
            <span className="panel-kicker">{zh ? "发起代码审查" : "Launch Review"}</span>
            <h3 id="review-composer-title">{displayName}</h3>
          </div>
          <button type="button" className="drawer-close-btn" aria-label={zh ? "关闭" : "Close"} onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          {error && (
            <div className="route-query-notice" role="alert">
              <strong>{zh ? "发起审查失败" : "Could not launch review"}</strong>
              <span>{error}</span>
            </div>
          )}

          <div className="composer-field">
            <label><strong>{zh ? "审查范围" : "Review Source"}</strong></label>
            <div className="source-option-list">
              <label className={`source-option-card ${source === "working_tree" ? "selected" : ""} ${!hasWorkingTreeChanges ? "disabled" : ""}`}>
                <input
                  type="radio"
                  name="reviewSource"
                  value="working_tree"
                  checked={source === "working_tree"}
                  disabled={!hasWorkingTreeChanges}
                  onChange={() => setSource("working_tree")}
                />
                <div>
                  <strong>{zh ? "工作区未提交变更 (Working Tree)" : "Working Tree Changes"}</strong>
                  <small>
                    {hasWorkingTreeChanges
                      ? (zh ? `比对未提交修改 (${dirtyCount} 个修改文件)` : `Diff uncommitted modifications (${dirtyCount} changed files)`)
                      : (zh ? "当前工作区没有未提交变更 (0 个修改文件)" : "Clean working tree (0 changed files)")}
                  </small>
                </div>
              </label>
              <label className={`source-option-card ${source === "branch" ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="reviewSource"
                  value="branch"
                  checked={source === "branch"}
                  onChange={() => setSource("branch")}
                />
                <div>
                  <strong>{zh ? `当前分支变更 (${targetBranchText})` : `Current Branch (${targetBranchText})`}</strong>
                  <small>{zh ? "比对分支相对于主干的基础变更" : "Diff branch merge base against default branch"}</small>
                </div>
              </label>
            </div>
          </div>

          <div className="composer-field composer-model-section">
            <div className="composer-field-header">
              <label><strong>{zh ? "审查模型" : "Review Model"}</strong></label>
              <button
                type="button"
                className="text-link-button"
                onClick={() => {
                  if (!isCustomModel) {
                    setOverrideModel(defaultModel);
                  }
                  setIsCustomModel(prev => !prev);
                }}
              >
                {isCustomModel ? (zh ? "使用全局默认" : "Use default") : (zh ? "更改模型" : "Change model")}
              </button>
            </div>

            {!isCustomModel ? (
              <div className="model-default-display">
                <div className="model-default-pill">
                  <Sparkles size={14} className="model-sparkle" />
                  <strong>
                    {defaultProvider !== "none"
                      ? `${defaultProvider === "deepseek" ? "DeepSeek" : "OpenAI"} · ${defaultModel}`
                      : (zh ? "未配置 LLM" : "LLM not configured")}
                  </strong>
                  <span className="model-default-tag">{zh ? "全局默认" : "Global default"}</span>
                </div>
              </div>
            ) : (
              <div className="custom-model-editor">
                <div className="custom-model-row">
                  <div className="custom-model-input-group">
                    <label htmlFor="composer-override-provider"><small>{zh ? "提供商" : "Provider"}</small></label>
                    <select
                      id="composer-override-provider"
                      value={overrideProvider}
                      onChange={e => {
                        const next = e.target.value as "deepseek" | "openai";
                        setOverrideProvider(next);
                        if (!overrideModel.trim() || overrideModel === "deepseek-v4-flash" || overrideModel === "gpt-4.1-mini") {
                          setOverrideModel(next === "deepseek" ? (health?.llmCapabilities?.deepseek?.defaultModel || "deepseek-v4-flash") : (health?.llmCapabilities?.openai?.defaultModel || "gpt-4.1-mini"));
                        }
                      }}
                    >
                      <option value="deepseek" disabled={!deepseekConfigured}>
                        DeepSeek {!deepseekConfigured ? (zh ? "(未配置密钥)" : "(unconfigured)") : ""}
                      </option>
                      <option value="openai" disabled={!openaiConfigured}>
                        OpenAI {!openaiConfigured ? (zh ? "(未配置密钥)" : "(unconfigured)") : ""}
                      </option>
                    </select>
                  </div>

                  <div className="custom-model-input-group flex-1">
                    <label htmlFor="composer-override-model"><small>{zh ? "模型名称" : "Model"}</small></label>
                    <input
                      id="composer-override-model"
                      type="text"
                      placeholder={overrideProvider === "deepseek" ? "deepseek-v4-flash" : "gpt-4.1-mini"}
                      value={overrideModel}
                      onChange={e => setOverrideModel(e.target.value)}
                    />
                  </div>
                </div>
                <small className="custom-model-hint">
                  {zh ? "仅对本次审查生效，不修改全局设置" : "Applies to this review only; does not mutate global settings"}
                </small>
              </div>
            )}
          </div>

          <div className="composer-meta-summary">
            <div><span>{zh ? "目标分支" : "Branch"}:</span> <code>{branch ?? "HEAD"}</code></div>
            <div><span>{zh ? "提交基线" : "HEAD SHA"}:</span> <code>{headSha?.slice(0, 10) ?? "latest"}</code></div>
            <div>
              <span>{zh ? "执行模型" : "Execution"}:</span>
              <code>{resolvedProvider ? `${resolvedProvider === "deepseek" ? "DeepSeek" : "OpenAI"} · ${targetModelName}` : (zh ? "未配置" : "None")}</code>
            </div>
          </div>

          {validationHint && (
            <div className="composer-validation-warning">
              <AlertCircle size={13} />
              <span>{validationHint}</span>
            </div>
          )}

          <div className="composer-actions">
            <button type="button" className="secondary-button" onClick={onClose} disabled={submitting}>
              {zh ? "取消" : "Cancel"}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!canStart}
              onClick={handleSubmit}
            >
              {submitting ? <LoaderCircle className="spinning" size={14} /> : <Play size={14} />}
              {zh ? (submitting ? "正在发起..." : "开始审查") : (submitting ? "Launching..." : "Start Review")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function RepositoryDetailPage({
  jobs,
  repositories = [],
  automations = [],
  pulse,
  health
}: {
  jobs: ReviewJob[];
  repositories?: Repository[];
  automations?: Automation[];
  pulse: HeartbeatPulse | null;
  health?: HealthResponse;
}) {
  const { repositoryId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { locale } = useI18n();
  const zh = locale === "zh-CN";

  const [selectedCommit, setSelectedCommit] = useState<VcsCommitSummary | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [prFilter, setPrFilter] = useState<"all" | "open" | "merged" | "closed">("all");

  const localId = pulse ? `local:${localRepositoryName(pulse)}` : "";
  const isLocalMonitor = Boolean(pulse && repositoryId === localId);
  const registered = repositories.find(repository => repository.id === repositoryId || repository.remoteFullName === repositoryId);
  const sourceJobs = jobs.filter(job =>
    job.repositoryFullName === (registered?.remoteFullName ?? repositoryId) ||
    repositoryId.includes(job.repositoryFullName) ||
    (isLocalMonitor && job.accessMode === "local_git")
  );
  const title = registered?.displayName ?? (isLocalMonitor ? localRepositoryName(pulse!) : (repositoryId === "sk1ua/ConsistenCy" && pulse ? localRepositoryName(pulse) : repositoryId));

  const gitStatusQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryGitStatus(repositoryId),
    queryFn: ({ signal }) => api.repositoryGitStatus(repositoryId, signal),
    staleTime: 10_000
  });

  const gitStatus = gitStatusQuery.data;

  const isLocal = Boolean(
    registered?.source === "local_git" ||
    isLocalMonitor ||
    gitStatus?.available ||
    Boolean(gitStatus?.branch) ||
    (pulse && (repositoryId === "sk1ua/ConsistenCy" || repositoryId === "ConsistenCy" || repositoryId.includes("ConsistenCy")))
  );

  const startLocalReview = useMutation({
    mutationFn: async (options: {
      source: "working_tree" | "branch";
      baseRef?: string;
      headRef?: string;
      modelOverride?: { provider: "deepseek" | "openai"; model: string };
    }) => {
      let targetPath = registered?.source === "local_git" ? registered.displayName : (pulse?.repository.root ?? "");
      if (repositoryId.startsWith("local:")) {
        targetPath = repositoryId.replace(/^local:/, "");
      }
      return api.triggerLocalReview({
        repoPath: targetPath,
        ...(options.source === "branch" ? { baseRef: options.baseRef ?? registered?.defaultBranch ?? "main", headRef: branch } : {}),
        ...(options.modelOverride ? { model: { provider: options.modelOverride.provider, model: options.modelOverride.model } } : {})
      });
    },
    onSuccess: async res => {
      setComposerOpen(false);
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
      navigate(`/runs/${encodeURIComponent(res.jobId)}/overview`);
    }
  });

  // Parse path segments to determine active view and optional sub-parameter (like PR number)
  const segments = location.pathname.split("/").filter(Boolean);
  const repoIdx = segments.indexOf("repositories");
  const subSegment = repoIdx >= 0 ? segments[repoIdx + 2] : undefined;
  const paramSegment = repoIdx >= 0 ? segments[repoIdx + 3] : undefined;

  const view: RepositoryView =
    subSegment === "changes" ? "changes"
    : subSegment === "history" ? "history"
    : subSegment === "pull-requests" ? "pull-requests"
    : subSegment === "runs" ? "runs"
    : subSegment === "automations" ? "automations"
    : "overview";

  const selectedPrNumber = subSegment === "pull-requests" && paramSegment ? Number(paramSegment) : undefined;

  const commitsQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryCommits(repositoryId),
    queryFn: ({ signal }) => api.repositoryCommits(repositoryId, 30, signal),
    staleTime: 15_000
  });

  const pullRequestsQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryPullRequests(repositoryId),
    queryFn: ({ signal }) => api.repositoryPullRequests(repositoryId, signal),
    staleTime: 15_000
  });

  const repositoryAutomations = automations.filter(automation => automation.repositoryId === repositoryId);

  const commits = commitsQuery.data?.commits ?? [];
  const prsData = pullRequestsQuery.data;
  const filteredPrs = useMemo(() => {
    if (!prsData?.pullRequests) return [];
    if (prFilter === "all") return prsData.pullRequests;
    return prsData.pullRequests.filter(p => p.state === prFilter);
  }, [prsData?.pullRequests, prFilter]);

  const latestJob = sourceJobs[0];
  const branch = gitStatus?.branch ?? pulse?.repository.branch ?? "main";
  const headSha = gitStatus?.headSha ?? pulse?.repository.headSha ?? latestJob?.headSha;
  const tabs: Array<{ id: RepositoryView; label: string; count?: number }> = [
    { id: "overview", label: zh ? "概览" : "Overview" },
    ...(isLocal ? [{ id: "changes" as const, label: zh ? "变更" : "Changes", count: gitStatus?.dirtyFileCount || undefined }] : []),
    { id: "history", label: zh ? "提交历史" : "Git History", count: commits.length || undefined },
    { id: "pull-requests", label: zh ? "拉取请求" : "Pull Requests", count: prsData?.pullRequests.length || undefined },
    { id: "runs", label: zh ? "审查" : "Reviews", count: sourceJobs.length || undefined },
    { id: "automations", label: zh ? "自动化" : "Automations", count: repositoryAutomations.length || undefined },
  ];

  const selectedPr = useMemo(() => {
    if (selectedPrNumber === undefined || !prsData?.pullRequests) return undefined;
    return prsData.pullRequests.find(p => p.number === selectedPrNumber);
  }, [prsData?.pullRequests, selectedPrNumber]);

  return (
    <div className="repository-workspace-page page-stack">
      {/* Hero Workspace Header */}
      <section className="section-block repo-workspace-hero">
        <div className="repo-hero-main">
          <div className="repo-hero-title-group">
            <FolderGit2 size={24} className="repo-hero-icon" />
            <div>
              <div className="repo-hero-tags">
                <span className="provenance-pill">
                  {isLocal ? (zh ? "本地 Git · GitHub 公开" : "LOCAL GIT · GITHUB PUBLIC") : (zh ? "GitHub · 公开" : "GITHUB PUBLIC")}
                </span>
              </div>
              <h2>{title}</h2>
            </div>
          </div>

          <div className="repo-hero-actions">
            <button
              type="button"
              className="primary-button review-launch-button"
              onClick={() => setComposerOpen(true)}
            >
              <Play size={14} /> {zh ? "审查代码" : "Review code"}
            </button>
          </div>
        </div>

        {/* Deterministic Git Status Line */}
        {isLocal ? (
          <div className="git-status-strip">
            <div className="status-item">
              <span className="status-label">{zh ? "当前分支" : "Branch"}</span>
              <div className="status-val">
                <GitBranch size={13} />
                <strong>{branch ?? (zh ? "分离头指针" : "detached")}</strong>
              </div>
            </div>
            <div className="status-item">
              <span className="status-label">{zh ? "HEAD 提交" : "HEAD SHA"}</span>
              <code>{headSha ? headSha.slice(0, 10) : "working tree"}</code>
            </div>
            <div className="status-item">
              <span className="status-label">{zh ? "工作区状态" : "Working Tree"}</span>
              <span className={gitStatus?.available === false ? "status-dim" : gitStatus && gitStatus.dirtyFileCount > 0 ? "dirty-tag" : "clean-tag"}>
                {gitStatus?.available === false
                  ? (zh ? "本地路径不可用" : "Local path unavailable")
                  : gitStatus && gitStatus.dirtyFileCount > 0
                  ? `${gitStatus.dirtyFileCount} ${zh ? "项工作区变更" : "changed files"}`
                  : (zh ? "工作区干净" : "Clean working tree")}
              </span>
            </div>
            {gitStatus?.primaryRemote && (
              <div className="status-item">
                <span className="status-label">{zh ? "Git 远端" : "Remote"}</span>
                <code title={gitStatus.primaryRemote.url}>{gitStatus.primaryRemote.name} · {gitStatus.primaryRemote.githubFullName ?? gitStatus.primaryRemote.url}</code>
              </div>
            )}
          </div>
        ) : (
          <div className="git-status-strip">
            <div className="status-item">
              <span className="status-label">{zh ? "默认分支" : "Default Branch"}</span>
              <div className="status-val">
                <GitBranch size={13} />
                <strong>{registered?.defaultBranch ?? "main"}</strong>
              </div>
            </div>
            <div className="status-item">
              <span className="status-label">{zh ? "最新审查 SHA" : "Reviewed SHA"}</span>
              <code>{latestJob?.headSha ? latestJob.headSha.slice(0, 10) : "—"}</code>
            </div>
            <div className="status-item">
              <span className="status-label">{zh ? "历史审查" : "Reviews"}</span>
              <strong>{sourceJobs.length} {zh ? "次" : "runs"}</strong>
            </div>
            <div className="status-item">
              <span className="status-label">{zh ? "数据来源" : "Provenance"}</span>
              <span>{isLocal ? (zh ? "本地 Git" : "Local Git") : (zh ? "GitHub 只读" : "GitHub read-only")}</span>
            </div>
          </div>
        )}
      </section>

      {/* Sub-Navigation Tabs */}
      <nav className="repo-workspace-tabs" role="tablist" aria-label={zh ? "仓库视图" : "Repository views"}>
        {tabs.map(tab => {
          const active = view === tab.id;
          const targetUrl = `/repositories/${encodeURIComponent(repositoryId)}${tab.id === "overview" ? "" : `/${tab.id}`}`;
          return (
            <NavLink
              key={tab.id}
              role="tab"
              aria-selected={active}
              className={`repo-tab ${active ? "active" : ""}`}
              to={targetUrl}
            >
              <span>{tab.label}</span>
              {tab.count !== undefined && <span className="tab-count-badge">{tab.count}</span>}
            </NavLink>
          );
        })}
      </nav>

      {/* VIEW: OVERVIEW */}
      {view === "overview" && (
        <div className="repo-view-stack">
          {/* Section 1: Working Tree Status (Local repositories only) */}
          {isLocal && (
            <section className="section-block repo-overview-card">
              <div className="panel-title">
                <div>
                  <span className="panel-kicker">{zh ? "本地工作区" : "Local Working Tree"}</span>
                  <h2>{zh ? "工作区状态" : "Working Tree Status"}</h2>
                </div>
                <Link to={`/repositories/${encodeURIComponent(repositoryId)}/changes`} className="text-link">
                  {zh ? "查看变更详情" : "View changes"} →
                </Link>
              </div>
              <div className="card-body-compact">
                {gitStatus && (gitStatus.dirtyFileCount > 0 || gitStatus.untrackedFileCount > 0) ? (
                  <div className="dirty-files-summary-row">
                    <div>
                      <span className="dirty-tag">{gitStatus.dirtyFileCount} {zh ? "个已修改文件" : "modified files"}</span>
                      {gitStatus.untrackedFileCount > 0 && <span> · {gitStatus.untrackedFileCount} {zh ? "个未跟踪文件" : "untracked files"}</span>}
                    </div>
                    <div className="dirty-files-mini-list">
                      {gitStatus.changedFiles.slice(0, 3).map(file => (
                        <div key={file.path} className="dirty-mini-item">
                          <span className={`diff-status diff-status-${file.status}`}>{file.status.slice(0, 1).toUpperCase()}</span>
                          <code>{file.path}</code>
                          <small>+{file.additions} -{file.deletions}</small>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="clean-inline-status">
                    <CheckCircle2 size={16} className="icon-success" />
                    <span>{zh ? "工作区干净，无未提交修改" : "Working tree clean, no uncommitted changes"}</span>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Section 2: Latest Review */}
          <section className="section-block repo-overview-card">
            <div className="panel-title">
              <div>
                <span className="panel-kicker">{zh ? "审查记录" : "Reviews"}</span>
                <h2>{zh ? "最新审查运行" : "Latest Review Run"}</h2>
              </div>
              <Link to={`/repositories/${encodeURIComponent(repositoryId)}/runs`} className="text-link">
                {zh ? "查看全部审查" : "View all reviews"} →
              </Link>
            </div>
            <div className="card-body-compact">
              {latestJob ? (
                <div className="latest-review-summary">
                  <div className="review-hero-row">
                    <div>
                      <strong>{latestJob.pullRequestNumber ? `PR #${latestJob.pullRequestNumber}` : latestJob.id}</strong>
                      <p>{latestJob.report?.summary ?? (zh ? "审查任务已记录" : "Review task recorded")}</p>
                    </div>
                    {latestJob.report && (
                      <div className="review-score-pill">
                        <strong>{latestJob.report.score}</strong>
                        <StatusBadge value={latestJob.report.riskLevel} />
                      </div>
                    )}
                  </div>
                  <div className="review-meta-row">
                    <StatusBadge value={latestJob.status} />
                    <small>{new Date(latestJob.createdAt).toLocaleString(locale)}</small>
                    <Link className="primary-button btn-small" to={`/runs/${encodeURIComponent(latestJob.id)}/overview`}>
                      {zh ? "打开审查报告" : "Open Review"}
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="empty-inline-compact">{zh ? "暂无历史审查运行。" : "No historical review runs yet."}</div>
              )}
            </div>
          </section>

          {/* Section 3: Recent Commits */}
          <section className="section-block repo-overview-card">
            <div className="panel-title">
              <div>
                <span className="panel-kicker">{zh ? "提交日志" : "Git Commits"}</span>
                <h2>{zh ? "最近提交" : "Recent Commits"}</h2>
              </div>
              <Link to={`/repositories/${encodeURIComponent(repositoryId)}/history`} className="text-link">
                {zh ? "查看全部" : "View all"} →
              </Link>
            </div>
            <div className="commit-preview-list">
              {commits.length === 0 ? (
                <div className="empty-inline-compact">{zh ? "暂无最近提交记录。" : "No recent commits."}</div>
              ) : (
                commits.slice(0, 4).map(commit => (
                  <div key={commit.sha} className="commit-preview-row" onClick={() => setSelectedCommit(commit)}>
                    <code>{commit.sha.slice(0, 8)}</code>
                    <span className="commit-preview-msg">{commit.message.split("\n")[0]}</span>
                    <small>{new Date(commit.authoredAt).toLocaleDateString()}</small>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Section 4: Open Pull Requests */}
          <section className="section-block repo-overview-card">
            <div className="panel-title">
              <div>
                <span className="panel-kicker">{zh ? "协同审查" : "Collaboration"}</span>
                <h2>{zh ? "开放拉取请求" : "Open Pull Requests"}</h2>
              </div>
              <Link to={`/repositories/${encodeURIComponent(repositoryId)}/pull-requests`} className="text-link">
                {zh ? "查看全部" : "View all"} →
              </Link>
            </div>
            <div className="pr-preview-list">
              {prsData?.available === false ? (
                <div className="empty-inline-compact">{zh ? "未连接 GitHub 远端或 PR 历史不可用。" : "No GitHub remote or PR history unavailable."}</div>
              ) : prsData?.pullRequests.filter(p => p.state === "open").length === 0 ? (
                <div className="empty-inline-compact">{zh ? "当前无开放拉取请求。" : "No open pull requests."}</div>
              ) : (
                prsData?.pullRequests.filter(p => p.state === "open").slice(0, 4).map(pr => (
                  <div key={pr.number} className="pr-preview-row">
                    <span className="pr-number">#{pr.number}</span>
                    <strong className="pr-title">{pr.title}</strong>
                    {pr.jobId && (
                      <Link to={`/runs/${encodeURIComponent(pr.jobId)}/overview`} className="badge badge-succeeded">
                        {zh ? "查看报告" : "Report"}
                      </Link>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      )}

      {/* VIEW: CHANGES (WORKING TREE) */}
      {view === "changes" && (
        <section className="section-block repo-changes-panel">
          <div className="panel-title">
            <div>
              <span className="panel-kicker">{zh ? "工作区改动 (HEAD → Working Copy)" : "Working Tree (HEAD → Working Copy)"}</span>
              <h2>{zh ? "本地未提交文件变更" : "Uncommitted Working Tree Changes"}</h2>
            </div>
            <button
              type="button"
              className="primary-button btn-small"
              onClick={() => setComposerOpen(true)}
            >
              <Play size={13} /> {zh ? "审查这些变更" : "Review these changes"}
            </button>
          </div>

          {gitStatus && (gitStatus.dirtyFileCount > 0 || gitStatus.untrackedFileCount > 0) ? (
            <div className="changes-content-layout">
              <div className="changes-summary-bar">
                <span><strong>{gitStatus.dirtyFileCount}</strong> {zh ? "个已修改文件" : "modified files"}</span>
                <span><strong>{gitStatus.untrackedFileCount}</strong> {zh ? "个未跟踪文件" : "untracked files"}</span>
                <code>HEAD: {headSha ? headSha.slice(0, 10) : "working tree"}</code>
              </div>

              <div className="changes-file-list">
                {gitStatus.changedFiles.map(file => (
                  <div key={file.path} className="changes-file-card">
                    <div className="changes-file-head">
                      <span className={`diff-status diff-status-${file.status}`}>{file.status.slice(0, 1).toUpperCase()}</span>
                      <strong className="changes-file-path">{file.path}</strong>
                      <span className="changes-file-stats">+{file.additions} -{file.deletions}</span>
                    </div>
                    {file.hunks.length > 0 && (
                      <pre className="changes-diff-preview">
                        {file.hunks.map(h => h.content).join("\n")}
                      </pre>
                    )}
                  </div>
                ))}

                {gitStatus.untrackedFiles.map(filePath => (
                  <div key={filePath} className="changes-file-card untracked">
                    <div className="changes-file-head">
                      <span className="diff-status diff-status-untracked">U</span>
                      <strong className="changes-file-path">{filePath}</strong>
                      <small className="muted-text">{zh ? "未跟踪新文件" : "untracked"}</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="clean-tree-box">
              <CheckCircle2 size={32} className="icon-success" />
              <strong>{zh ? "工作区干净，无未提交修改" : "Working tree clean, no uncommitted changes"}</strong>
              <p>{zh ? "没有需要审查的本地改动。可切换至提交历史或拉取请求标签页审查历史提交。" : "No local changes to review. Switch to Git History or Pull Requests to review commits."}</p>
            </div>
          )}
        </section>
      )}

      {/* VIEW: GIT HISTORY */}
      {view === "history" && (
        <section className="section-block git-history-panel">
          <div className="panel-title">
            <div>
              <span className="panel-kicker">{zh ? "确定性提交日志" : "Deterministic Git Log"}</span>
              <h2>{zh ? "Git 提交历史" : "Git History"}</h2>
            </div>
            <GitCommit size={18} className="panel-icon" />
          </div>

          <div className="git-commit-list">
            {commits.map(commit => {
              const firstLine = commit.message.split("\n")[0];
              return (
                <div
                  key={commit.sha}
                  className="git-commit-item"
                  onClick={() => setSelectedCommit(commit)}
                >
                  <div className="commit-header-row">
                    <div className="commit-sha-group">
                      <code>{commit.sha.slice(0, 8)}</code>
                      <strong className="commit-title">{firstLine}</strong>
                    </div>
                    <time dateTime={commit.authoredAt}>{new Date(commit.authoredAt).toLocaleString()}</time>
                  </div>
                  <div className="commit-sub-row">
                    <span className="commit-author">{commit.author.name}</span>
                    {commit.parentShas.length > 0 && (
                      <span className="parent-indicator">{commit.parentShas.length} {zh ? "个父提交" : "parents"}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* VIEW: PULL REQUEST DETAIL */}
      {view === "pull-requests" && selectedPr && (
        <section className="section-block pr-detail-panel">
          <div className="panel-title">
            <div>
              <Link to={`/repositories/${encodeURIComponent(repositoryId)}/pull-requests`} className="text-link">
                ← {zh ? "返回拉取请求列表" : "Back to Pull Requests"}
              </Link>
              <h2>#{selectedPr.number} · {selectedPr.title}</h2>
            </div>
            <span className={`pr-badge pr-${selectedPr.state}`}>{selectedPr.state.toUpperCase()}</span>
          </div>

          <div className="pr-detail-meta-box">
            <div className="pr-detail-grid">
              <div>
                <span>{zh ? "分支方向" : "Branch Range"}:</span>
                <strong>{selectedPr.baseRef} ← {selectedPr.headRef}</strong>
              </div>
              <div>
                <span>{zh ? "作者" : "Author"}:</span>
                <strong>{selectedPr.author}</strong>
              </div>
              <div>
                <span>{zh ? "创建时间" : "Created"}:</span>
                <time dateTime={selectedPr.createdAt}>{new Date(selectedPr.createdAt).toLocaleString()}</time>
              </div>
              <div>
                <span>{zh ? "HEAD 提交" : "HEAD SHA"}:</span>
                <code>{selectedPr.headSha.slice(0, 10)}</code>
              </div>
            </div>

            <div className="pr-detail-actions">
              {selectedPr.jobId ? (
                <Link to={`/runs/${encodeURIComponent(selectedPr.jobId)}/overview`} className="primary-button">
                  {zh ? "查看已有审查报告" : "View Existing Review"} {selectedPr.score !== undefined ? `(${selectedPr.score})` : ""}
                </Link>
              ) : (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setComposerOpen(true)}
                >
                  <Play size={14} /> {zh ? "使用 ConsistenCy 审查此 PR" : "Review with ConsistenCy"}
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* VIEW: PULL REQUESTS LIST */}
      {view === "pull-requests" && !selectedPr && (
        <section className="section-block pr-history-panel">
          <div className="panel-title">
            <div>
              <span className="panel-kicker">{zh ? "GitHub 协同历史" : "GitHub Pull Requests"}</span>
              <h2>{zh ? "拉取请求列表" : "Pull Requests"}</h2>
            </div>
            <div className="pr-filter-buttons" role="group">
              {(["all", "open", "merged", "closed"] as const).map(filter => (
                <button
                  key={filter}
                  type="button"
                  className={`segmented-btn ${prFilter === filter ? "active" : ""}`}
                  onClick={() => setPrFilter(filter)}
                >
                  {zh ? (filter === "all" ? "全部" : filter === "open" ? "开启中" : filter === "merged" ? "已合并" : "已关闭") : filter.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {prsData?.available === false ? (
            <div className="honest-fallback-box">
              <AlertCircle size={20} className="icon-warning" />
              <div>
                <strong>{zh ? "拉取请求历史不可用" : "Pull Request History Unavailable"}</strong>
                <p>{prsData.reason ?? (zh ? "此仓库为本地独立仓库或尚未绑定 GitHub 远端；不会从 Git 提交日志猜测假 PR。" : "This repository is local-only or has no authoritative GitHub remote; PR history is never fabricated.")}</p>
              </div>
            </div>
          ) : filteredPrs.length === 0 ? (
            <div className="empty-inline-compact">{zh ? "无匹配拉取请求。" : "No matching pull requests found."}</div>
          ) : (
            <div className="pull-request-table-list">
              {filteredPrs.map(pr => (
                <div key={pr.number} className="pr-item-card">
                  <div className="pr-main-info">
                    <div className="pr-title-row">
                      <span className={`pr-badge pr-${pr.state}`}>{pr.state.toUpperCase()}</span>
                      <Link
                        to={`/repositories/${encodeURIComponent(repositoryId)}/pull-requests/${pr.number}`}
                        className="pr-title-text"
                      >
                        #{pr.number} · {pr.title}
                      </Link>
                    </div>
                    <div className="pr-meta-row">
                      <span>{pr.baseRef} ← {pr.headRef}</span>
                      <span>·</span>
                      <span>{pr.author}</span>
                      <span>·</span>
                      <time dateTime={pr.createdAt}>{new Date(pr.createdAt).toLocaleDateString()}</time>
                    </div>
                  </div>

                  <div className="pr-review-actions">
                    {pr.jobId ? (
                      <Link to={`/runs/${encodeURIComponent(pr.jobId)}/overview`} className="primary-button btn-small">
                        {zh ? "查看审查报告" : "View Review"} {pr.score !== undefined ? `(${pr.score})` : ""}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="secondary-button btn-small"
                        onClick={() => setComposerOpen(true)}
                      >
                        <Play size={12} /> {zh ? "审查此 PR" : "Review PR"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* VIEW: REVIEW RUNS */}
      {view === "runs" && (
        <section className="section-block repo-runs-panel">
          <div className="panel-title">
            <div>
              <span className="panel-kicker">{zh ? "ConsistenCy 审查记录" : "Review Executions"}</span>
              <h2>{zh ? "关联审查运行" : "Related Review Runs"}</h2>
            </div>
            <strong>{sourceJobs.length} {zh ? "项" : "runs"}</strong>
          </div>

          {sourceJobs.length === 0 ? (
            <div className="empty-inline-compact">{zh ? "该仓库暂无审查记录。" : "No review runs recorded for this repository."}</div>
          ) : (
            <div className="repo-runs-list" role="list">
              {sourceJobs.map(job => {
                const isJobDemo = job.id.startsWith("job_demo");
                return (
                  <div key={job.id} className="repo-run-row" role="listitem" onClick={() => navigate(`/runs/${encodeURIComponent(job.id)}/overview`)}>
                    <div className="run-identity">
                      <StatusBadge value={job.status} />
                      <strong>{job.pullRequestNumber ? `PR #${job.pullRequestNumber}` : job.id.slice(0, 8)}</strong>
                      <span className="run-summary-text">{job.report?.summary ?? (zh ? "审查任务已记录" : "Review task")}</span>
                      {isJobDemo && <span className="provenance-pill demo-provenance">{zh ? "演示数据" : "FIXTURE"}</span>}
                    </div>
                    <div className="run-metrics">
                      {job.report && (
                        <div className="score-mini-pill">
                          <strong>{job.report.score}</strong>
                          <StatusBadge value={job.report.riskLevel} />
                        </div>
                      )}
                      <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString(locale)}</time>
                      <Link to={`/runs/${encodeURIComponent(job.id)}/overview`} className="primary-button btn-small" onClick={e => e.stopPropagation()}>
                        {zh ? "打开审查报告" : "Open Report"}
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* VIEW: AUTOMATIONS */}
      {view === "automations" && (
        <section className="section-block repo-automations-panel">
          <div className="panel-title">
            <div>
              <span className="panel-kicker">{zh ? "持续策略绑定" : "Policy Bindings"}</span>
              <h2>{zh ? "仓库自动化" : "Repository Automations"}</h2>
            </div>
            <Link to="/automations" className="text-link">{zh ? "打开控制面" : "Open Control Plane"} →</Link>
          </div>
          {repositoryAutomations.length === 0 ? (
            <div className="empty-inline-compact">{zh ? "暂无绑定的自动化计划。" : "No automations bound to this repository."}</div>
          ) : (
            <div className="automation-list">
              {repositoryAutomations.map(automation => (
                <div key={automation.id} className="automation-row">
                  <span className={automation.enabled ? "automation-state enabled" : "automation-state"}><i />{automation.enabled ? (zh ? "启用" : "Enabled") : (zh ? "暂停" : "Paused")}</span>
                  <div>
                    <strong>{automation.name}</strong>
                    <small>{automation.trigger.type} · {automation.executionProfile}</small>
                  </div>
                  <code>{automation.workflowRevisionId.slice(0, 10)}</code>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Modals */}
      {selectedCommit && (
        <CommitDetailModal commit={selectedCommit} zh={zh} onClose={() => setSelectedCommit(null)} />
      )}

      {composerOpen && (
        <ReviewComposerModal
          displayName={title}
          branch={branch}
          defaultBranch={registered?.defaultBranch ?? "main"}
          headSha={headSha}
          dirtyCount={(gitStatus?.dirtyFileCount ?? 0) + (gitStatus?.untrackedFileCount ?? 0)}
          health={health}
          submitting={startLocalReview.isPending}
          error={startLocalReview.error ? safeRequestError(startLocalReview.error) : undefined}
          zh={zh}
          onClose={() => setComposerOpen(false)}
          onStartReview={options => startLocalReview.mutate(options)}
        />
      )}
    </div>
  );
}
