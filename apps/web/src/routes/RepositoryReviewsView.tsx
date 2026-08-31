import React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw, FileSearch } from "lucide-react";
import { riskBandForFindings, type ReviewJob } from "@consistency/schema";
import { api } from "../api/client";
import { workspaceQueryKeys } from "../query/client";
import { Button } from "../design-system/Button";
import { SectionHeader } from "../design-system/SectionHeader";
import { EmptyState } from "../design-system/EmptyState";

const STATUS_TONE: Record<string, string> = {
  queued: "var(--muted)",
  running: "var(--warning, #f59e0b)",
  awaiting_publish: "var(--warning, #f59e0b)",
  publishing: "var(--warning, #f59e0b)",
  succeeded: "var(--success, #22c55e)",
  failed: "var(--danger, #ef4444)",
  publish_failed: "var(--danger, #ef4444)",
  cancelled: "var(--muted)"
};

const STATUS_ZH: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  awaiting_publish: "待发布",
  publishing: "发布中",
  succeeded: "已完成",
  failed: "失败",
  publish_failed: "发布失败",
  cancelled: "已取消"
};

function isLive(status: string): boolean {
  return status === "queued" || status === "running" || status === "awaiting_publish" || status === "publishing";
}

export function canonicalRepositoryReviews(
  reviews: readonly ReviewJob[],
  repositoryId: string
): ReviewJob[] {
  return reviews.filter(review => review.repositoryId === repositoryId);
}

export function createRepositoryReviewsQueryOptions(
  repositoryId: string,
  fetchReviews = (id: string, signal: AbortSignal) => api.repositoryReviews(id, signal)
) {
  return {
    queryKey: workspaceQueryKeys.repositoryReviews(repositoryId),
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchReviews(repositoryId, signal),
    retry: false as const
  };
}

/**
 * Repository-local review history (CKPT3 Phase 4, read-mostly). Lists ONLY
 * canonically associated ReviewJobs (repository_id persisted at creation);
 * legacy unassociated jobs are never name-inferred into this view. Field
 * truthfulness: absent fields render "—", never fabricated.
 */
export function RepositoryReviewsView({
  repositoryId,
  zh
}: {
  repositoryId: string;
  zh: boolean;
}) {
  const reviewsQuery = useQuery(createRepositoryReviewsQueryOptions(repositoryId));

  const reviews = canonicalRepositoryReviews(reviewsQuery.data ?? [], repositoryId);
  const runningCount = reviews.filter(job => isLive(job.status)).length;
  const failedCount = reviews.filter(job => job.status === "failed" || job.status === "publish_failed").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <SectionHeader
        title={zh ? "审查历史" : "Reviews"}
        subtitle={
          zh
            ? "本仓库的审查任务历史（按注册身份关联）；风险分为分诊信号"
            : "This repository's review job history (canonically associated); risk scores are triage signals"
        }
        actions={
          <Button variant="ghost" size="sm" onClick={() => void reviewsQuery.refetch()}>
            <RefreshCw size={13} />
            {zh ? "刷新" : "Refresh"}
          </Button>
        }
      />

      {reviewsQuery.isLoading ? (
        <div style={{ display: "flex", gap: "8px", alignItems: "center", color: "var(--muted)" }}>
          <Loader2 size={14} className="animate-spin" />
          {zh ? "加载中…" : "Loading…"}
        </div>
      ) : reviewsQuery.isError ? (
        <div role="alert" style={{ padding: "16px", border: "1px solid var(--border)", borderRadius: "var(--ds-radius-md)", background: "var(--surface)" }}>
          <strong>{zh ? "审查历史不可用" : "Review history unavailable"}</strong>
          <div style={{ fontSize: "13px", color: "var(--muted)" }}>
            {zh ? "读取失败（区别于空状态）。请稍后重试。" : "Failed to load (distinct from empty). Try again later."}
          </div>
        </div>
      ) : reviews.length === 0 ? (
        <EmptyState
          title={zh ? "尚未审查过" : "No reviews yet"}
          description={
            zh
              ? "该仓库还没有关联的审查任务（空 ≠ 不可用）。可从仓库概览发起审查。"
              : "No canonically associated review jobs yet (empty, not unavailable). Start one from the repository overview."
          }
        />
      ) : (
        <>
          <div style={{ display: "flex", gap: "12px", fontSize: "13px", color: "var(--muted)" }}>
            <span>{zh ? `共 ${reviews.length} 条` : `${reviews.length} total`}</span>
            <span>{zh ? `运行中 ${runningCount}` : `${runningCount} running`}</span>
            <span>{zh ? `失败 ${failedCount}` : `${failedCount} failed`}</span>
          </div>
          <div role="list" style={{ display: "grid", gap: "8px" }}>
            {reviews.map(job => (
              <ReviewRow key={job.id} job={job} zh={zh} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ReviewRow({ job, zh }: { job: ReviewJob; zh: boolean }) {
  const report = job.report;
  const statusLabel = zh ? (STATUS_ZH[job.status] ?? job.status) : job.status;
  const source =
    job.pullRequestNumber !== undefined
      ? `PR #${job.pullRequestNumber}`
      : job.accessMode === "local_git"
        ? zh ? "工作区/本地" : "working tree / local"
        : zh ? "分支提交" : "branch commit";
  return (
    <Link
      to={`/runs/${encodeURIComponent(job.id)}/overview`}
      role="listitem"
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--ds-radius-sm)", background: "var(--surface)", textDecoration: "none", color: "inherit" }}
    >
      <span style={{ display: "flex", gap: "10px", alignItems: "center", minWidth: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: STATUS_TONE[job.status] ?? "var(--muted)" }} />
        <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <strong style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <FileSearch size={13} />
            {job.id.slice(0, 18)}…
            <span style={{ fontSize: 12, fontWeight: 400, color: "var(--muted)" }}>{source}</span>
          </strong>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            {new Date(job.createdAt).toLocaleString()}
            {job.llmProvider ? ` · ${job.llmProvider}${job.llmModel ? ` / ${job.llmModel}` : ""}` : ` · ${zh ? "模型：—" : "model: —"}`}
          </span>
        </span>
      </span>
      <span style={{ display: "flex", gap: "10px", alignItems: "center", flexShrink: 0 }}>
        {report ? (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            {zh ? "静态风险" : "static risk"}: {report.riskLevel} · {zh ? "发现风险" : "finding risk"}: {report.riskBand ?? riskBandForFindings(report.findings)} · {zh ? "分" : "score"}: {report.score}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{zh ? "报告：—" : "report: —"}</span>
        )}
        <span style={{ fontSize: 12, color: STATUS_TONE[job.status] ?? "var(--muted)" }}>{statusLabel}</span>
      </span>
    </Link>
  );
}
