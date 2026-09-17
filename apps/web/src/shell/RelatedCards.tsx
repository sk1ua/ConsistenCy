import React from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type {
  Repository,
  ReviewJob,
  WorkflowRuntimeBinding
} from "@consistency/schema";
import {
  Activity,
  GitBranch,
  GitCommit,
  PlayCircle,
  Workflow
} from "lucide-react";
import { api } from "../api/client";
import { workspaceQueryKeys } from "../query/client";
import { Badge } from "../design-system/Badge";

export type RelatedCardsFocus = "status" | "review" | "workflow" | "evidence" | null;

export interface RelatedCardsProps {
  locale: "zh-CN" | "en-US";
  repository?: Repository;
  jobs: ReviewJob[];
  focus?: RelatedCardsFocus;
  statusCardRef?: React.RefObject<HTMLElement | null>;
}

function Card({
  title,
  children,
  highlighted,
  cardRef,
  icon,
  onActivate,
  activateLabel
}: {
  title: string;
  children: React.ReactNode;
  highlighted?: boolean;
  cardRef?: React.RefObject<HTMLElement | null>;
  icon?: React.ReactNode;
  onActivate?: () => void;
  activateLabel?: string;
}) {
  return (
    <section
      ref={cardRef as React.RefObject<HTMLElement | null>}
      className={`related-card${highlighted ? " related-card--focus" : ""}${onActivate ? " related-card--nav" : ""}`}
    >
      <header className="related-card__head">
        {icon}
        <span>{title}</span>
      </header>
      <div className="related-card__body">{children}</div>
      {onActivate && (
        <button
          type="button"
          className="related-card__text-btn related-card__jump"
          onClick={onActivate}
        >
          {activateLabel}
        </button>
      )}
    </section>
  );
}

export const RelatedCards: React.FC<RelatedCardsProps> = ({
  locale,
  repository,
  jobs,
  focus = null,
  statusCardRef
}) => {
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const repositoryId = repository?.id;

  const prepQuery = useQuery({
    queryKey: ["review-preparation", repositoryId ?? ""],
    queryFn: () => api.reviewPreparation(repositoryId!),
    enabled: Boolean(repositoryId),
    refetchInterval: 15_000,
    retry: false
  });
  const gitStatusQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryGitStatus(repositoryId ?? ""),
    queryFn: () => api.repositoryGitStatus(repositoryId!),
    enabled: Boolean(repositoryId),
    refetchInterval: 10_000,
    retry: false
  });
  const bindingsQuery = useQuery({
    queryKey: workspaceQueryKeys.workflowRuntimeBindings(repositoryId ?? ""),
    queryFn: () => api.workflowRuntimeBindings(repositoryId!),
    enabled: Boolean(repositoryId),
    retry: false
  });
  const preparation = prepQuery.data;
  const gitStatus = gitStatusQuery.data;

  const bindings: WorkflowRuntimeBinding[] = bindingsQuery.data ?? [];
  const enabledBindings = bindings.filter(b => b.enabled);
  const repoJobs = jobs
    .filter(j => j.repositoryId === repositoryId || j.repositoryFullName === repository?.displayName || j.repositoryFullName === repository?.remoteFullName)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const latestJob = repoJobs[0];
  const latestReport = latestJob?.report;

  const repoBase = repositoryId
    ? `/repositories/${encodeURIComponent(repositoryId)}`
    : null;

  if (!repository || !repoBase) {
    return (
      <aside className="related-cards-rail" aria-label={zh ? "相关信息" : "Related"}>
        <p className="related-card__muted" style={{ padding: "8px 4px", margin: 0 }}>
          {zh ? "选择左侧仓库。" : "Select a repository."}
        </p>
      </aside>
    );
  }

  return (
    <aside className="related-cards-rail" aria-label={zh ? "相关信息" : "Related"}>
      <div className="related-cards-rail__title">
        {zh ? "相关" : "Related"}
      </div>

      <Card
        title={zh ? "仓库情况" : "Repo status"}
        icon={<Activity size={12} />}
        highlighted={focus === "status"}
        cardRef={statusCardRef}
        onActivate={() => navigate(`${repoBase}/overview`)}
        activateLabel={zh ? "打开概览" : "Open overview"}
      >
        <div className="related-card__meta">
          <span className="related-card__name">{repository.displayName}</span>
          <div className="related-card__row">
            <GitBranch size={11} />
            <span>{gitStatus?.branch || repository.defaultBranch || "—"}</span>
          </div>
          {gitStatus?.headSha && (
            <div className="related-card__row">
              <GitCommit size={11} />
              <span className="mono">{gitStatus.headSha.substring(0, 7)}</span>
            </div>
          )}
          <div className="related-card__row">
            <span
              className="related-dot"
              style={{
                background: preparation?.canStartReview
                  ? "var(--success)"
                  : "var(--warning)"
              }}
            />
            <span>
              {preparation?.canStartReview
                ? (zh ? "可以开始审查" : "Ready to review")
                : (zh ? "审查待就绪" : "Not ready")}
            </span>
          </div>
          {gitStatus && (
            <div className="related-card__muted">
              {gitStatus.dirtyFileCount === 0
                ? (zh ? "工作区干净" : "Clean working tree")
                : (zh
                  ? `${gitStatus.dirtyFileCount} 个未提交变更`
                  : `${gitStatus.dirtyFileCount} uncommitted changes`)}
            </div>
          )}
        </div>
      </Card>

      <Card
        title={zh ? "最近审查" : "Recent review"}
        icon={<PlayCircle size={12} />}
        highlighted={focus === "review"}
        onActivate={() => navigate(`${repoBase}/reviews`)}
        activateLabel={zh ? "打开审查列表" : "Open reviews"}
      >
        {!latestJob ? (
          <p className="related-card__muted">
            {zh ? "尚无审查" : "No reviews yet"}
          </p>
        ) : (
          <button
            type="button"
            className="related-card__link"
            onClick={() => navigate(`/runs/${encodeURIComponent(latestJob.id)}/overview`)}
          >
            <Badge
              variant={
                latestJob.status === "succeeded"
                  ? "success"
                  : latestJob.status === "running"
                    ? "warning"
                    : latestJob.status === "failed"
                      ? "danger"
                      : "neutral"
              }
              size="sm"
            >
              {latestJob.status.toUpperCase()}
            </Badge>
            <span>
              {latestJob.pullRequestNumber
                ? `PR #${latestJob.pullRequestNumber}`
                : (zh ? "工作区审查" : "Working tree")}
            </span>
            {latestReport?.score !== undefined && (
              <span className="related-card__score">
                {zh ? `${latestReport.score} 分` : `${latestReport.score}`}
              </span>
            )}
          </button>
        )}
      </Card>

      <Card
        title={zh ? "工作流" : "Workflow"}
        icon={<Workflow size={12} />}
        highlighted={focus === "workflow"}
        onActivate={() => navigate(`${repoBase}/workflows`)}
        activateLabel={zh ? "打开工作流绑定" : "Open workflows"}
      >
        {bindingsQuery.isError ? (
          <p className="related-card__muted">
            {zh ? "绑定暂不可用" : "Bindings unavailable"}
          </p>
        ) : enabledBindings.length === 0 ? (
          <p className="related-card__muted">
            {zh ? "暂无启用绑定" : "No enabled bindings"}
          </p>
        ) : (
          <ul className="related-card__list">
            {enabledBindings.slice(0, 3).map(b => (
              <li key={b.definitionId}>
                <button
                  type="button"
                  className="related-card__link"
                  onClick={() => navigate(`${repoBase}/workflows`)}
                >
                  <span className="related-dot" style={{ background: "var(--success)" }} />
                  <span className="mono">{b.definitionId}</span>
                  <span className="related-card__muted">{b.triggerMode}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {latestReport && latestJob && (
        <Card
          title={zh ? "证据" : "Evidence"}
          icon={<Activity size={12} />}
          highlighted={focus === "evidence"}
          onActivate={() => navigate(`/runs/${encodeURIComponent(latestJob.id)}/evidence`)}
          activateLabel={zh ? "查看证据" : "Open evidence"}
        >
          <div className="related-card__meta">
            <div className="related-card__row">
              <span>{zh ? "风险" : "Risk"}</span>
              <Badge variant="neutral" size="sm">{latestReport.riskLevel}</Badge>
            </div>
            {typeof latestReport.score === "number" && (
              <div className="related-card__row">
                <span>{zh ? "评分" : "Score"}</span>
                <strong>{latestReport.score}</strong>
              </div>
            )}
            {Array.isArray(latestReport.findings) && (
              <div className="related-card__row">
                <span>{zh ? "发现" : "Findings"}</span>
                <strong>{latestReport.findings.length}</strong>
              </div>
            )}
          </div>
        </Card>
      )}
    </aside>
  );
};
