import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import type {
  Automation,
  HeartbeatPulse,
  Repository,
  ReviewJob,
  ReviewPreparationResponse,
  LocalReviewRequest
} from "@consistency/schema";
import {
  FolderGit2,
  GitBranch,
  GitCommit,
  PlayCircle,
  Loader2,
  Github
} from "lucide-react";
import { api, type HealthResponse } from "../api/client";
import { workspaceQueryKeys } from "../query/client";
import { Button } from "../design-system/Button";
import { Badge } from "../design-system/Badge";
import { Tabs } from "../design-system/Tabs";
import { SectionHeader } from "../design-system/SectionHeader";
import { EmptyState } from "../design-system/EmptyState";
import { useI18n } from "../i18n";
import { ReviewComposerDialog } from "./ReviewComposerDialog";
import { RepositoryChangesView } from "./RepositoryChangesView";
import { RepositoryHistoryView } from "./RepositoryHistoryView";
import { RepositoryPullRequestsView } from "./RepositoryPullRequestsView";
import { RepositoryWorkflowsView } from "./RepositoryWorkflowsView";
import {
  canonicalRepositoryReviews,
  createRepositoryReviewsQueryOptions,
  RepositoryReviewsView
} from "./RepositoryReviewsView";

export interface RepositoryDetailPageProps {
  jobs: ReviewJob[];
  repositories: Repository[];
  automations?: Automation[];
  pulse?: HeartbeatPulse | null;
  health?: HealthResponse;
}

export function isReviewStartDisabled(preparation?: ReviewPreparationResponse): boolean {
  return preparation?.canStartReview !== true;
}

export function formatReviewMutationError(zh: boolean, _error: unknown): string {
  return zh ? "请求失败，请稍后重试。" : "Request failed. Please try again later.";
}

export function createRepositoryPullRequestsQueryOptions(
  repositoryId: string,
  activeTab: string,
  fetchPullRequests = (id: string, signal: AbortSignal) => api.repositoryPullRequests(id, signal)
) {
  return {
    queryKey: workspaceQueryKeys.repositoryPullRequests(repositoryId),
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchPullRequests(repositoryId, signal),
    enabled: activeTab === "pull-requests",
    staleTime: 30_000
  };
}

export const RepositoryDetailPage: React.FC<RepositoryDetailPageProps> = ({
  repositories = [],
  pulse,
  health
}) => {
  const { repositoryId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { locale } = useI18n();
  const zh = locale === "zh-CN";

  const [isReviewDialogOpen, setIsReviewDialogOpen] = useState(false);
  const [selectedReviewJob, setSelectedReviewJob] = useState<ReviewJob | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // Derive active tab from URL path
  const activeTab = useMemo(() => {
    if (location.pathname.includes("/changes")) return "changes";
    if (location.pathname.includes("/history")) return "history";
    if (location.pathname.includes("/pull-requests")) return "pull-requests";
    if (location.pathname.includes("/reviews")) return "reviews";
    if (location.pathname.includes("/workflows")) return "workflows";
    return "overview";
  }, [location.pathname]);

  const handleTabChange = (tabId: string) => {
    navigate(`/repositories/${encodeURIComponent(repositoryId)}/${tabId}`);
  };

  // Queries for repository git status, commits, PRs, review preparation
  const gitStatusKey = ["repository-git-status", repositoryId] as const;
  const gitStatusQuery = useQuery({
    queryKey: gitStatusKey,
    queryFn: () => api.repositoryGitStatus(repositoryId),
    refetchInterval: 10_000
  });
  const gitStatusError = gitStatusQuery.error ?? queryClient.getQueryState(gitStatusKey)?.error;
  const gitStatusLoading = gitStatusQuery.isLoading && !gitStatusError;
  const gitStatusData = gitStatusError ? {
    repositoryId,
    available: false,
    reason: zh ? "由于网络或服务异常，无法加载仓库状态" : "Failed to load repository status due to network or service error",
    branch: null,
    headSha: null,
    dirtyFileCount: 0,
    untrackedFileCount: 0,
    changedFiles: [],
    untrackedFiles: [],
    remotes: []
  } : gitStatusQuery.data;

  const commitsKey = ["repository-commits", repositoryId] as const;
  const commitsQuery = useQuery({
    queryKey: commitsKey,
    queryFn: () => api.repositoryCommits(repositoryId, 15)
  });
  const commitsError = commitsQuery.error ?? queryClient.getQueryState(commitsKey)?.error;
  const commitsLoading = commitsQuery.isLoading && !commitsError;
  const commitsData = commitsError ? {
    repositoryId,
    available: false,
    reason: zh ? "由于网络或服务异常，无法加载提交历史" : "Failed to load commit history due to network or service error",
    commits: []
  } : commitsQuery.data;

  const prepQuery = useQuery({
    queryKey: ["review-preparation", repositoryId],
    queryFn: () => api.reviewPreparation(repositoryId),
    refetchInterval: 15_000
  });

  const prsOptions = createRepositoryPullRequestsQueryOptions(repositoryId, activeTab);
  const prsKey = prsOptions.queryKey;
  const prsQuery = useQuery(prsOptions);
  const prsError = prsQuery.error ?? queryClient.getQueryState(prsKey)?.error;
  const prsLoading = prsQuery.isLoading && !prsError;
  const prsData = prsError ? {
    repositoryId,
    available: false as const,
    reasonCode: "provider_unavailable" as const,
    reason: zh ? "由于网络或服务异常，无法加载拉取请求" : "Failed to load pull requests due to network or service error",
    pullRequests: []
  } : prsQuery.data;

  const reviewsQuery = useQuery(createRepositoryReviewsQueryOptions(repositoryId));
  const repoJobs = useMemo(
    () => canonicalRepositoryReviews(reviewsQuery.data ?? [], repositoryId),
    [repositoryId, reviewsQuery.data]
  );

  // Find repository model
  const repo = useMemo(
    () => repositories.find(r => r.id === repositoryId),
    [repositories, repositoryId]
  );
  const preparedRepository = prepQuery.data?.repository;
  const displayName = preparedRepository?.displayName ?? repo?.displayName ?? (zh ? "仓库不可用" : "Repository unavailable");
  const sourceKind = preparedRepository?.sourceKind ?? repo?.source;
  const trust = preparedRepository?.trust ?? (repo?.trustLevel === "trusted_local" ? "trusted_local" : undefined);

  const triggerReview = useMutation({
    mutationFn: async (request: LocalReviewRequest) => {
      setReviewError(null);
      return api.triggerLocalReview(request);
    },
    onSuccess: result => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
      setIsReviewDialogOpen(false);
      navigate(`/runs/${encodeURIComponent(result.jobId)}/overview`);
    },
    onError: error => {
      setReviewError(formatReviewMutationError(zh, error));
    }
  });

  const tabs = [
    { id: "overview", label: zh ? "概览" : "Overview" },
    {
      id: "changes",
      label: zh ? "变更" : "Changes",
      count: gitStatusData && gitStatusData.available !== false ? gitStatusData.dirtyFileCount + gitStatusData.untrackedFileCount : undefined
    },
    { id: "history", label: zh ? "提交历史" : "History" },
    { id: "pull-requests", label: zh ? "拉取请求" : "Pull Requests" },
    { id: "reviews", label: zh ? "审查" : "Reviews", count: repoJobs.length || undefined },
    { id: "workflows", label: zh ? "工作流" : "Workflows" }
  ];

  const gitStatus = gitStatusData;
  const prep = prepQuery.data;
  const commits = commitsData?.commits ?? [];

  return (
    <div style={{ padding: "16px 24px", maxWidth: "1200px", margin: "0 auto" }}>
      {/* 1. REPOSITORY HEADER (Compact Desktop Strip) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingBottom: "14px",
          borderBottom: "1px solid var(--border)",
          marginBottom: "14px"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "var(--ds-radius-md)",
              background: "var(--primary-soft)",
              color: "var(--primary-strong)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center"
            }}
          >
            {sourceKind === "github" ? <Github size={18} /> : <FolderGit2 size={18} />}
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <h1 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>{displayName}</h1>
              <Badge variant="neutral" size="sm" mono>
                {sourceKind === "local_git" ? (zh ? "本地 Git" : "Local Git") : sourceKind === "github" ? "GitHub" : sourceKind ?? (zh ? "来源未知" : "Source unknown")}
              </Badge>
              {trust && (
                <Badge variant={trust === "trusted_local" ? "success" : "neutral"} size="sm">
                  {trust === "trusted_local" ? (zh ? "受信本地" : "Trusted local") : (zh ? "只读" : "Read-only")}
                </Badge>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "11px", color: "var(--muted)", marginTop: "1px" }}>
              <span style={{ display: "flex", alignItems: "center", gap: "3px" }}>
                <GitBranch size={11} />
                 <span>{gitStatus?.branch || (zh ? "分支未知" : "Branch unknown")}</span>
              </span>
              {gitStatus?.headSha && (
                <span style={{ display: "flex", alignItems: "center", gap: "3px", fontFamily: "var(--ds-font-mono)" }}>
                  <GitCommit size={11} />
                  <span>{gitStatus.headSha.substring(0, 7)}</span>
                </span>
              )}
              {gitStatus?.dirtyFileCount !== undefined && (
                <span>
                   {gitStatus.dirtyFileCount === 0
                     ? (zh ? "工作区干净" : "Clean working tree")
                     : (zh ? `${gitStatus.dirtyFileCount} 个未提交变更` : `${gitStatus.dirtyFileCount} uncommitted changes`)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Button
            variant="primary"
            size="sm"
            icon={<PlayCircle size={14} />}
            onClick={() => setIsReviewDialogOpen(true)}
            disabled={isReviewStartDisabled(prep)}
          >
            {zh ? "审查代码" : "Start Review"}
          </Button>
        </div>
      </div>

      {/* 2. LOCAL REPOSITORY NAVIGATION */}
      <div style={{ marginBottom: "16px" }}>
        <Tabs tabs={tabs} activeId={activeTab} onChange={handleTabChange} />
      </div>

      {/* 3. OVERVIEW VIEW (ONLY BUSINESS PAGE IMPLEMENTED IN THIS PROTOTYPE) */}
      {activeTab === "overview" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Review Readiness Status Bar */}
          <div
            style={{
              padding: "10px 14px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--ds-radius-md)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: "12px"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                style={{
                  width: "7px",
                  height: "7px",
                  borderRadius: "50%",
                  background: prep?.canStartReview ? "var(--success)" : "var(--warning)"
                }}
              />
               <span style={{ fontWeight: 600 }}>
                 {prep?.canStartReview
                    ? (zh ? "可以开始审查" : "Ready to review")
                   : (zh ? "审查待就绪" : "Review pending")}
               </span>
               <span style={{ color: "var(--muted)" }}>—</span>
                <span style={{ color: "var(--muted-strong)" }}>
                 {prep
                   ? prep.sources.workingTree.available
                     ? (zh ? `${prep.sources.workingTree.changedFileCount} 个工作区变更` : `${prep.sources.workingTree.changedFileCount} working-tree changes`)
                     : prep.sources.branch.available
                       ? `${prep.sources.branch.head} → ${prep.sources.branch.base}`
                       : (zh ? "当前没有可审查的工作区变更" : "No reviewable working-tree changes")
                   : (zh ? "正在读取审查准备状态" : "Loading review preparation")}
               </span>
               {prep?.canStartReview && prep.model.default.provider !== "none" && (
                 <span style={{ color: "var(--muted-strong)" }}>· {prep.model.default.provider === "deepseek" ? "DeepSeek" : "OpenAI"} · {prep.model.default.model}</span>
               )}
               {prep && !prep.canStartReview && prep.blockingReasons[0] && (
                 <span style={{ color: "var(--warning-strong)" }}>· {prep.blockingReasons[0]}</span>
               )}
             </div>
             {prep && prep.model.default.provider === "none" && (
               <Button variant="outline" size="sm" onClick={() => navigate("/settings")}>{zh ? "配置模型" : "Configure model"}</Button>
             )}
          </div>

          {/* DENSE CONTENT SECTIONS (NO CARD SOUP) */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            {/* Left: Recent Reviews (Dense List) */}
            <section
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--ds-radius-md)",
                overflow: "hidden"
              }}
            >
              <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", background: "var(--surface-subtle)" }}>
                <span style={{ fontWeight: 600, fontSize: "13px" }}>
                 {zh ? "最近审查" : "Recent Reviews"}
                </span>
              </div>

              {reviewsQuery.isLoading ? (
                <div style={{ padding: "20px", textAlign: "center", color: "var(--muted)", fontSize: "12px" }}>
                  <Loader2 size={16} className="ds-spin" style={{ margin: "0 auto 4px" }} />
                  <div>{zh ? "正在读取审查历史..." : "Loading review history..."}</div>
                </div>
              ) : reviewsQuery.isError ? (
                <div role="alert" style={{ padding: "16px", color: "var(--muted)", fontSize: "12px" }}>
                  {zh ? "审查历史暂时不可用。" : "Review history is temporarily unavailable."}
                </div>
              ) : repoJobs.length === 0 ? (
                <EmptyState
                  compact
                  className="repo-overview-empty"
                  title={zh ? "暂无审查记录" : "No reviews yet"}
                  description={zh ? "点击“审查代码”发起首次审查。" : "Start a review from the repository header."}
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {repoJobs.slice(0, 5).map(job => (
                    <div
                      key={job.id}
                      onClick={() => navigate(`/runs/${encodeURIComponent(job.id)}/overview`)}
                      className="ds-list-row ds-list-row--static"
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                        <Badge
                          variant={
                            job.status === "succeeded"
                              ? "success"
                              : job.status === "running"
                              ? "warning"
                              : job.status === "failed"
                              ? "danger"
                              : "neutral"
                          }
                          size="sm"
                        >
                          {job.status.toUpperCase()}
                        </Badge>
                        <span style={{ fontSize: "12px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {job.pullRequestNumber ? `PR #${job.pullRequestNumber}` : (zh ? "工作区审查" : "Working tree")}
                        </span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                        {job.report?.score !== undefined && (
                          <span style={{ fontWeight: 700, fontSize: "12px", color: "var(--foreground)" }}>
                             {zh ? `${job.report.score} 分` : `${job.report.score}`}
                          </span>
                        )}
                        <span style={{ fontSize: "11px", color: "var(--muted)", fontFamily: "var(--ds-font-mono)" }}>
                          {new Date(job.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Right: Recent Commits (Dense List) */}
            <section
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--ds-radius-md)",
                overflow: "hidden"
              }}
            >
              <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", background: "var(--surface-subtle)" }}>
                <span style={{ fontWeight: 600, fontSize: "13px" }}>
                   {zh ? "最近提交" : "Recent Commits"}
                </span>
              </div>

              {commitsQuery.isLoading ? (
                <div style={{ padding: "20px", textAlign: "center", color: "var(--muted)", fontSize: "12px" }}>
                  <Loader2 size={16} className="ds-spin" style={{ margin: "0 auto 4px" }} />
                   <div>{zh ? "正在读取提交历史..." : "Loading commit history..."}</div>
                </div>
              ) : commits.length === 0 ? (
                <EmptyState
                  compact
                  title={zh ? "暂无提交历史" : "No commits yet"}
                  description={zh ? "本地 Git 仓库历史为空。" : "Git history is empty."}
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {commits.slice(0, 5).map(c => (
                    <div
                      key={c.sha}
                      className="ds-list-row ds-list-row--static"
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                        <Badge variant="neutral" size="sm" mono>
                          {c.sha.substring(0, 7)}
                        </Badge>
                         <span title={c.message} style={{ fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.message}
                        </span>
                      </div>
                      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "1px", fontSize: "11px", color: "var(--muted)", flexShrink: 0 }}>
                        <span>{c.author.name}</span>
                        <time dateTime={c.authoredAt}>{new Date(c.authoredAt).toLocaleDateString(locale, { month: "short", day: "numeric" })}</time>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      ) : activeTab === "changes" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <SectionHeader
            title={zh ? "工作区变更" : "Workspace Changes"}
            subtitle={zh ? "审查工作区和未跟踪的变更文件" : "Review working tree and untracked file changes"}
          />
          <RepositoryChangesView
            loading={gitStatusLoading}
            data={gitStatusData}
          />
        </div>
      ) : activeTab === "history" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <SectionHeader
            title={zh ? "Git 提交历史" : "Git Commit History"}
            subtitle={zh ? "确定性提交日志与本地仓库最近变更记录" : "Deterministic commit log and recent repository changes"}
          />
          <RepositoryHistoryView data={commitsData} isLoading={commitsLoading} />
        </div>
      ) : activeTab === "pull-requests" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", height: "calc(100vh - 200px)" }}>
          <SectionHeader
            title={zh ? "拉取请求列表" : "Pull Requests"}
            subtitle={zh ? "关联的 GitHub 拉取请求及其审查记录" : "Linked GitHub Pull Requests and their review history"}
          />
          <RepositoryPullRequestsView
            isLoading={prsLoading}
            data={prsData}
            defaultFilter="all"
          />
        </div>
      ) : activeTab === "workflows" ? (
        <RepositoryWorkflowsView repositoryId={repositoryId} zh={zh} />
      ) : (
        <RepositoryReviewsView repositoryId={repositoryId} zh={zh} />
      )}

      <ReviewComposerDialog
        isOpen={isReviewDialogOpen}
        onClose={() => {
          setIsReviewDialogOpen(false);
          setReviewError(null);
        }}
        displayName={displayName}
        repositoryId={repositoryId}
        preparation={prep}
        pending={triggerReview.isPending}
        onSubmit={(request) => triggerReview.mutate(request)}
        zh={zh}
        onConfigureModel={() => navigate("/settings")}
        error={reviewError}
        onClearError={() => setReviewError(null)}
      />
    </div>
  );
};
