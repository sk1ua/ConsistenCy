import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type {
  LocalReviewRequest,
  Repository,
  ReviewJob,
  ReviewReport
} from "@consistency/schema";
import {
  FolderGit2,
  GitBranch,
  GitCommit,
  Loader2,
  PlayCircle
} from "lucide-react";
import { api } from "../api/client";
import { workspaceQueryKeys } from "../query/client";
import { Button } from "../design-system/Button";
import { Badge } from "../design-system/Badge";
import { EmptyState } from "../design-system/EmptyState";
import { ReviewComposerDialog } from "../routes/ReviewComposerDialog";
import { isReviewStartDisabled, formatReviewMutationError } from "../routes/reviewStart";
import { openSettingsDialog } from "../settingsDialogStore";

export interface ReviewWorkbenchProps {
  locale: "zh-CN" | "en-US";
  repository?: Repository;
  jobs: ReviewJob[];
  reports?: ReviewReport[];
  onStartReviewIntent?: (goal: string) => void;
}

export const ReviewWorkbench: React.FC<ReviewWorkbenchProps> = ({
  locale,
  repository,
  jobs,
  reports = []
}) => {
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [goalDraft, setGoalDraft] = useState("");

  const repositoryId = repository?.id ?? "";

  const prepQuery = useQuery({
    queryKey: ["review-preparation", repositoryId],
    queryFn: () => api.reviewPreparation(repositoryId),
    enabled: Boolean(repositoryId),
    refetchInterval: 15_000
  });
  const gitStatusQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryGitStatus(repositoryId),
    queryFn: () => api.repositoryGitStatus(repositoryId),
    enabled: Boolean(repositoryId),
    refetchInterval: 10_000
  });
  const reviewsQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryReviews(repositoryId),
    queryFn: () => api.repositoryReviews(repositoryId),
    enabled: Boolean(repositoryId),
    staleTime: 30_000
  });

  const prep = prepQuery.data;
  const gitStatus = gitStatusQuery.data;

  const triggerReview = useMutation({
    mutationFn: (request: LocalReviewRequest) => api.triggerLocalReview(request),
    onSuccess: async result => {
      setIsReviewOpen(false);
      setReviewError(null);
      setGoalDraft("");
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
      navigate(`/runs/${encodeURIComponent(result.jobId)}/overview`);
    },
    onError: (error: unknown) => {
      setReviewError(formatReviewMutationError(zh, error));
    }
  });

  const repoJobs = useMemo(() => {
    const fromApi = reviewsQuery.data ?? [];
    if (fromApi.length > 0) return fromApi;
    return jobs
      .filter(
        j =>
          j.repositoryId === repositoryId ||
          j.repositoryFullName === repository?.displayName ||
          j.repositoryFullName === repository?.remoteFullName
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [jobs, repository, repositoryId, reviewsQuery.data]);

  const latestReport =
    repoJobs[0]?.report ??
    reports.find(r => r.jobId === repoJobs[0]?.id);

  if (!repository) {
    return (
      <div className="ds-page review-workbench">
        <EmptyState
          icon={null}
          title={zh ? "连接仓库以开始审查" : "Connect a repository to start reviewing"}
          description={
            zh
              ? "ConsistenCy 是证据审查工作台，不是聊天产品。从左侧连接本地或远程仓库。"
              : "ConsistenCy is an evidence review workbench, not a chat product. Connect a repo from the left."
          }
        />
      </div>
    );
  }

  const dirtyCount = gitStatus?.dirtyFileCount ?? 0;
  const changedPreview = [
    ...(gitStatus?.changedFiles ?? []).slice(0, 6).map(f => ({ path: f.path, kind: "changed" as const })),
    ...(gitStatus?.untrackedFiles ?? []).slice(0, 4).map(path => ({ path, kind: "untracked" as const }))
  ];

  return (
    <div className="ds-page review-workbench">
      <header className="review-workbench__header">
        <div className="review-workbench__identity">
          <div className="review-workbench__icon">
            <FolderGit2 size={18} />
          </div>
          <div>
            <h1 className="review-workbench__title">{repository.displayName}</h1>
            <div className="review-workbench__sub">
              <span>
                <GitBranch size={11} /> {gitStatus?.branch || repository.defaultBranch || "—"}
              </span>
              {gitStatus?.headSha && (
                <span className="mono">
                  <GitCommit size={11} /> {gitStatus.headSha.substring(0, 7)}
                </span>
              )}
              <span>
                {dirtyCount === 0
                  ? (zh ? "工作区干净" : "Clean working tree")
                  : (zh ? `${dirtyCount} 个未提交变更` : `${dirtyCount} uncommitted changes`)}
              </span>
            </div>
          </div>
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<PlayCircle size={14} />}
          disabled={isReviewStartDisabled(prep)}
          onClick={() => setIsReviewOpen(true)}
        >
          {zh ? "开始审查" : "Start review"}
        </Button>
      </header>

      <div className="review-workbench__readiness">
        <span
          className="related-dot"
          style={{
            background: prep?.canStartReview ? "var(--success)" : "var(--warning)"
          }}
        />
        <strong>
          {prep?.canStartReview
            ? (zh ? "可以开始审查" : "Ready to review")
            : (zh ? "审查待就绪" : "Review pending")}
        </strong>
        <span className="review-workbench__muted">
          {prep
            ? prep.sources.workingTree.available
              ? (zh
                ? `${prep.sources.workingTree.changedFileCount} 个工作区变更`
                : `${prep.sources.workingTree.changedFileCount} working-tree changes`)
              : prep.sources.branch.available
                ? `${prep.sources.branch.head} → ${prep.sources.branch.base}`
                : (zh ? "当前没有可审查的变更" : "No reviewable changes")
            : (zh ? "正在读取准备状态…" : "Loading preparation…")}
        </span>
        {prep && !prep.canStartReview && prep.blockingReasons[0] && (
          <span className="review-workbench__warn">· {prep.blockingReasons[0]}</span>
        )}
        {prep && prep.model.default.provider === "none" && (
          <Button variant="outline" size="sm" onClick={openSettingsDialog}>
            {zh ? "配置模型" : "Configure model"}
          </Button>
        )}
      </div>

      <div className="review-workbench__grid">
        <section className="review-workbench__panel">
          <h2>{zh ? "最近审查 / 发现" : "Recent reviews / findings"}</h2>
          {reviewsQuery.isLoading ? (
            <div className="review-workbench__loading">
              <Loader2 size={16} className="ds-spin" />
              <span>{zh ? "加载中…" : "Loading…"}</span>
            </div>
          ) : repoJobs.length === 0 ? (
            <EmptyState
              compact
              icon={null}
              title={zh ? "暂无审查记录" : "No reviews yet"}
              description={zh ? "点击「开始审查」发起首次审查。" : "Use Start review for the first run."}
            />
          ) : (
            <div className="review-workbench__list">
              {repoJobs.slice(0, 6).map(job => {
                const report = job.report ?? reports.find(r => r.jobId === job.id);
                return (
                  <button
                    key={job.id}
                    type="button"
                    className="review-workbench__row"
                    onClick={() => navigate(`/runs/${encodeURIComponent(job.id)}/overview`)}
                  >
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
                    <span className="review-workbench__row-title">
                      {job.pullRequestNumber
                        ? `PR #${job.pullRequestNumber}`
                        : (zh ? "工作区审查" : "Working tree")}
                    </span>
                    {report?.findings?.length ? (
                      <span className="review-workbench__muted">
                        {zh ? `${report.findings.length} 项发现` : `${report.findings.length} findings`}
                      </span>
                    ) : null}
                    {report?.score !== undefined && (
                      <strong>{zh ? `${report.score} 分` : report.score}</strong>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="review-workbench__panel">
          <h2>{zh ? "变更 / 证据钩子" : "Diff / evidence hooks"}</h2>
          {changedPreview.length === 0 && !latestReport ? (
            <EmptyState
              compact
              icon={null}
              title={zh ? "暂无变更摘要" : "No diff summary yet"}
              description={
                zh
                  ? "工作区变更与最近审查证据会显示在这里。"
                  : "Working-tree changes and latest evidence hooks land here."
              }
            />
          ) : (
            <div className="review-workbench__list">
              {changedPreview.map(item => (
                <div key={`${item.kind}-${item.path}`} className="review-workbench__row review-workbench__row--static">
                  <Badge variant="neutral" size="sm">
                    {item.kind === "untracked" ? (zh ? "未跟踪" : "untracked") : (zh ? "变更" : "changed")}
                  </Badge>
                  <span className="mono review-workbench__row-title">{item.path}</span>
                </div>
              ))}
              {latestReport && (
                <button
                  type="button"
                  className="review-workbench__row"
                  onClick={() =>
                    repoJobs[0] &&
                    navigate(`/runs/${encodeURIComponent(repoJobs[0].id)}/evidence`)
                  }
                >
                  <Badge variant="neutral" size="sm">{zh ? "证据" : "Evidence"}</Badge>
                  <span className="review-workbench__row-title">
                    {zh ? "最近审查证据摘要" : "Latest evidence summary"}
                  </span>
                  <span className="review-workbench__muted">{latestReport.riskLevel}</span>
                </button>
              )}
              <button
                type="button"
                className="review-workbench__text-btn"
                onClick={() =>
                  navigate(`/repositories/${encodeURIComponent(repository.id)}/changes`)
                }
              >
                {zh ? "打开变更视图" : "Open changes view"}
              </button>
            </div>
          )}
        </section>
      </div>

      <footer className="review-workbench__composer">
        <label className="review-workbench__composer-label" htmlFor="review-goal">
          {zh ? "描述审查目标（编排，非对话）" : "Describe review goal (orchestration, not chat)"}
        </label>
        <div className="review-workbench__composer-row">
          <input
            id="review-goal"
            className="ds-input ds-input--sm"
            value={goalDraft}
            onChange={e => setGoalDraft(e.target.value)}
            placeholder={
              zh
                ? "例如：审查 auth 相关变更的安全风险…"
                : "e.g. Review security risk in auth-related changes…"
            }
            onKeyDown={e => {
              if (e.key === "Enter" && !isReviewStartDisabled(prep)) {
                e.preventDefault();
                setIsReviewOpen(true);
              }
            }}
          />
          <Button
            variant="primary"
            size="sm"
            icon={<PlayCircle size={14} />}
            disabled={isReviewStartDisabled(prep)}
            onClick={() => setIsReviewOpen(true)}
          >
            {zh ? "开始审查" : "Start review"}
          </Button>
        </div>
      </footer>

      <ReviewComposerDialog
        isOpen={isReviewOpen}
        onClose={() => {
          setIsReviewOpen(false);
          setReviewError(null);
        }}
        displayName={repository.displayName}
        repositoryId={repository.id}
        preparation={prep}
        pending={triggerReview.isPending}
        onSubmit={request => triggerReview.mutate(request)}
        zh={zh}
        onConfigureModel={openSettingsDialog}
        error={reviewError}
        onClearError={() => setReviewError(null)}
      />
    </div>
  );
};
