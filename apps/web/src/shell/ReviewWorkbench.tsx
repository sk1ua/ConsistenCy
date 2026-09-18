import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type {
  LocalReviewRequest,
  Repository,
  ReviewJob,
  ReviewReport
} from "@consistency/schema";
import {
  AlertTriangle,
  CheckCircle2,
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
import { isReviewStartDisabled, reviewStartDisabledReason, formatReviewMutationError, isSafeProductErrorMessage } from "../routes/reviewStart";
import { openSettingsDialog } from "../settingsDialogStore";

export interface ReviewWorkbenchProps {
  locale: "zh-CN" | "en-US";
  repository?: Repository;
  jobs: ReviewJob[];
  reports?: ReviewReport[];
  onStartReviewIntent?: (goal: string) => void;
}

const REPO_SURFACES = [
  { id: "overview", zh: "概览", en: "Overview" },
  { id: "changes", zh: "变更", en: "Changes" },
  { id: "history", zh: "历史", en: "History" },
  { id: "pull-requests", zh: "PR", en: "PRs" },
  { id: "reviews", zh: "审查", en: "Reviews" },
  { id: "workflows", zh: "工作流", en: "Workflows" }
] as const;

function isActiveJobStatus(status: ReviewJob["status"]): boolean {
  return status === "queued" || status === "running" || status === "awaiting_publish" || status === "publishing";
}

function isFailedJobStatus(status: ReviewJob["status"]): boolean {
  return status === "failed" || status === "publish_failed";
}

/** User-safe summary for a finished/failed job; never echoes secret-looking text. */
export function formatJobDispositionError(job: ReviewJob, zh: boolean): string {
  const raw = job.error?.trim();
  if (raw && isSafeProductErrorMessage(raw)) return raw;
  return zh ? "审查执行失败。打开运行页查看详情。" : "Review failed. Open the run page for details.";
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
  /** Job id started from this workbench; kept for disposition if user returns. */
  const [trackedJobId, setTrackedJobId] = useState<string | null>(null);

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
    staleTime: 5_000,
    refetchInterval: query => {
      const list = query.state.data as ReviewJob[] | undefined;
      const latest = list?.[0];
      if (latest && isActiveJobStatus(latest.status)) return 3_000;
      if (trackedJobId) {
        const tracked = list?.find(j => j.id === trackedJobId);
        if (tracked && isActiveJobStatus(tracked.status)) return 3_000;
      }
      return 15_000;
    }
  });

  const prep = prepQuery.data;
  const gitStatus = gitStatusQuery.data;

  const triggerReview = useMutation({
    mutationFn: (request: LocalReviewRequest) => api.triggerLocalReview(request),
    onSuccess: async result => {
      setIsReviewOpen(false);
      setReviewError(null);
      setTrackedJobId(result.jobId);
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
      // Align with RepositoryDetailPage: jump straight to the run overview.
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

  const dispositionJob = useMemo(() => {
    if (trackedJobId) {
      const tracked = repoJobs.find(j => j.id === trackedJobId);
      if (tracked) return tracked;
    }
    return repoJobs[0] ?? null;
  }, [repoJobs, trackedJobId]);

  useEffect(() => {
    if (!dispositionJob || !trackedJobId) return;
    if (dispositionJob.id !== trackedJobId) return;
    if (isActiveJobStatus(dispositionJob.status)) return;
    // Keep terminal tracked job visible for disposition; no-op otherwise.
  }, [dispositionJob, trackedJobId]);

  const latestReport =
    repoJobs[0]?.report ??
    reports.find(r => r.jobId === repoJobs[0]?.id);

  if (!repository) {
    return (
      <div className="ds-page review-workbench">
        <EmptyState
          icon={null}
          title={zh ? "连接仓库后开始审查" : "Connect a repository"}
          description={
            zh
              ? "从左侧连接仓库，即可发起证据审查。"
              : "Connect a repository on the left to start evidence review."
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
  const repoBase = `/repositories/${encodeURIComponent(repository.id)}`;
  const runOverviewPath = dispositionJob
    ? `/runs/${encodeURIComponent(dispositionJob.id)}/overview`
    : null;

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
          title={
            isReviewStartDisabled(prep)
              ? reviewStartDisabledReason(prep, zh)
              : (zh ? "开始审查" : "Start Review")
          }
          onClick={() => setIsReviewOpen(true)}
        >
          {zh ? "开始审查" : "Start Review"}
        </Button>
      </header>

      <nav className="review-workbench__surfaces" aria-label={zh ? "仓库视图" : "Repository surfaces"}>
        {REPO_SURFACES.map(surface => (
          <button
            key={surface.id}
            type="button"
            className="review-workbench__surface"
            onClick={() => navigate(`${repoBase}/${surface.id}`)}
          >
            {zh ? surface.zh : surface.en}
          </button>
        ))}
      </nav>

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
        {isReviewStartDisabled(prep) && (
          <span className="review-workbench__warn">· {reviewStartDisabledReason(prep, zh)}</span>
        )}
        {prep && prep.model.default.provider === "none" && (
          <Button variant="outline" size="sm" onClick={openSettingsDialog}>
            {zh ? "配置模型" : "Configure model"}
          </Button>
        )}
      </div>

      {dispositionJob && runOverviewPath && (
        <div
          className={
            isFailedJobStatus(dispositionJob.status)
              ? "review-workbench__disposition review-workbench__disposition--fail"
              : dispositionJob.status === "succeeded"
                ? "review-workbench__disposition review-workbench__disposition--ok"
                : isActiveJobStatus(dispositionJob.status)
                  ? "review-workbench__disposition review-workbench__disposition--live"
                  : "review-workbench__disposition"
          }
          data-testid="review-workbench-disposition"
          role={isFailedJobStatus(dispositionJob.status) ? "alert" : "status"}
        >
          <div className="review-workbench__disposition-main">
            {isFailedJobStatus(dispositionJob.status) ? (
              <AlertTriangle size={16} aria-hidden />
            ) : dispositionJob.status === "succeeded" ? (
              <CheckCircle2 size={16} aria-hidden />
            ) : isActiveJobStatus(dispositionJob.status) ? (
              <Loader2 size={16} className="ds-spin" aria-hidden />
            ) : (
              <PlayCircle size={16} aria-hidden />
            )}
            <div className="review-workbench__disposition-copy">
              <strong>
                {isFailedJobStatus(dispositionJob.status)
                  ? (zh ? "审查失败" : "Review failed")
                  : dispositionJob.status === "succeeded"
                    ? (zh ? "审查已完成" : "Review completed")
                    : isActiveJobStatus(dispositionJob.status)
                      ? (zh ? "审查进行中" : "Review in progress")
                      : (zh ? "最近审查" : "Latest review")}
              </strong>
              {isFailedJobStatus(dispositionJob.status) ? (
                <p className="review-workbench__disposition-error">
                  {formatJobDispositionError(dispositionJob, zh)}
                </p>
              ) : dispositionJob.status === "succeeded" ? (
                <p className="review-workbench__muted">
                  {zh
                    ? "打开运行概览查看发现、证据与结论。"
                    : "Open the run overview for findings, evidence, and conclusion."}
                </p>
              ) : isActiveJobStatus(dispositionJob.status) ? (
                <p className="review-workbench__muted">
                  {zh ? "智能体正在执行。可打开运行页查看进度。" : "Agents are running. Open the run page for progress."}
                </p>
              ) : null}
            </div>
          </div>
          <Button
            variant={dispositionJob.status === "succeeded" ? "primary" : "outline"}
            size="sm"
            onClick={() => navigate(runOverviewPath)}
          >
            {isFailedJobStatus(dispositionJob.status)
              ? (zh ? "查看失败详情" : "Open failed run")
              : dispositionJob.status === "succeeded"
                ? (zh ? "打开运行概览" : "Open run overview")
                : (zh ? "打开运行页" : "Open run")}
          </Button>
        </div>
      )}

      <div className="review-workbench__grid">
        <section className="review-workbench__panel">
          <h2>{zh ? "最近审查" : "Recent reviews"}</h2>
          {reviewsQuery.isLoading ? (
            <div className="review-workbench__loading">
              <Loader2 size={16} className="ds-spin" />
              <span>{zh ? "加载中…" : "Loading…"}</span>
            </div>
          ) : repoJobs.length === 0 ? (
            <EmptyState
              compact
              icon={null}
              title={zh ? "暂无审查" : "No reviews yet"}
              description={zh ? "用「开始审查」发起首次运行。" : "Start review to create the first run."}
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
                          : isActiveJobStatus(job.status)
                            ? "warning"
                            : isFailedJobStatus(job.status)
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
                    {isFailedJobStatus(job.status) ? (
                      <span className="review-workbench__muted" title={formatJobDispositionError(job, zh)}>
                        {formatJobDispositionError(job, zh)}
                      </span>
                    ) : report?.findings?.length ? (
                      <span className="review-workbench__muted" title={report.findings[0]?.title}>
                        {zh
                          ? `${report.findings.length} 项发现 · ${report.findings[0]?.title ?? ""}`
                          : `${report.findings.length} findings · ${report.findings[0]?.title ?? ""}`}
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
          <h2>{zh ? "变更" : "Changes"}</h2>
          {changedPreview.length === 0 && !latestReport ? (
            <EmptyState
              compact
              icon={null}
              title={zh ? "暂无变更" : "No changes"}
              description={
                zh
                  ? "工作区变更与证据摘要会出现在这里。"
                  : "Working-tree changes and evidence appear here."
              }
            />
          ) : (
            <div className="review-workbench__list">
              {changedPreview.map(item => (
                <button
                  key={`${item.kind}-${item.path}`}
                  type="button"
                  className="review-workbench__row"
                  onClick={() =>
                    navigate(`${repoBase}/changes`, { state: { highlightPath: item.path } })
                  }
                >
                  <Badge variant="neutral" size="sm">
                    {item.kind === "untracked" ? (zh ? "未跟踪" : "untracked") : (zh ? "变更" : "changed")}
                  </Badge>
                  <span className="mono review-workbench__row-title">{item.path}</span>
                </button>
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
                onClick={() => navigate(`${repoBase}/changes`)}
              >
                {zh ? "打开变更视图" : "Open changes view"}
              </button>
            </div>
          )}
        </section>
      </div>

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
