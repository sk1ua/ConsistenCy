import React, { useState } from "react";
import {
  isCanonicalGitHubPullRequestUrl as validateCanonicalGitHubPullRequestUrl,
  type RepositoryPullRequestsResponse,
  type PullRequestSummary
} from "@consistency/schema";
import { ExternalLink, AppLink } from "../design-system/Link";
import { useI18n } from "../i18n";
import { EmptyState } from "../design-system/EmptyState";
import { Badge } from "../design-system/Badge";
import { Button } from "../design-system/Button";
import "./repository-pull-requests.css";

export interface RepositoryPullRequestsViewProps {
  isLoading: boolean;
  data: RepositoryPullRequestsResponse | undefined;
  defaultFilter?: FilterMode;
}

export type FilterMode = "all" | "open" | "merged" | "closed";

export function pullRequestDisplayState(pr: PullRequestSummary): "open" | "merged" | "closed" {
  if (pr.state === "closed" && pr.mergedAt !== null) return "merged";
  return pr.state as "open" | "closed";
}

export function filterPullRequests(prs: PullRequestSummary[], mode: FilterMode): PullRequestSummary[] {
  return prs.filter(pr => mode === "all" || mode === pullRequestDisplayState(pr));
}

export function isCanonicalGitHubPullUrl(
  value: string,
  pullRequestNumber?: number,
  repositoryFullName?: string
): boolean {
  if (pullRequestNumber === undefined || repositoryFullName === undefined) return false;
  return validateCanonicalGitHubPullRequestUrl(value, pullRequestNumber, repositoryFullName);
}

export function isSafeHttpsUrl(value: string): boolean {
  return isCanonicalGitHubPullUrl(value);
}

const zhCopy = {
  "Loading pull request history": "正在加载拉取请求历史",
  "Pull request history unavailable": "拉取请求历史不可用",
  "No pull requests": "暂无拉取请求",
  "No pull requests for this filter": "此筛选条件下暂无拉取请求",
  "All": "全部",
  "Open": "开放",
  "Merged": "已合并",
  "Closed": "已关闭",
  "Draft": "草稿",
  "No author": "无作者",
  "Created": "创建于",
  "Updated": "更新于",
  "Closed at": "关闭于",
  "Review": "审查",
  "Score": "评分",
  "Risk": "风险",
  "Reviewed at": "审查时间",
  "GitHub": "GitHub",
  "Labels": "标签",
  "Pull request filters": "拉取请求筛选",
  "This repository provider is not GitHub.": "此仓库的提供方不是 GitHub。",
  "GitHub repository identity is unavailable.": "无法确定 GitHub 仓库身份。",
  "The GitHub repository was not found.": "未找到该 GitHub 仓库。",
  "GitHub access was denied.": "GitHub 访问被拒绝。",
  "GitHub rate limit was reached.": "已达到 GitHub 速率限制。",
  "GitHub pull request history is temporarily unavailable.": "GitHub 拉取请求历史暂时不可用。",
  "GitHub returned invalid pull request data.": "GitHub 返回了无效的拉取请求数据。",
  "Pull request history could not be loaded.": "无法加载拉取请求历史。",
  "Only the 100 most recent pull requests are shown. Older records are not loaded.": "仅显示最近 100 条拉取请求，旧记录未加载。"
} as const;

type ZhKey = keyof typeof zhCopy;

const unavailableReasonKeys = {
  not_github: "This repository provider is not GitHub.",
  identity_unavailable: "GitHub repository identity is unavailable.",
  not_found: "The GitHub repository was not found.",
  access_denied: "GitHub access was denied.",
  rate_limited: "GitHub rate limit was reached.",
  provider_unavailable: "GitHub pull request history is temporarily unavailable.",
  invalid_provider_data: "GitHub returned invalid pull request data."
} as const;

export const RepositoryPullRequestsView: React.FC<RepositoryPullRequestsViewProps> = ({
  isLoading,
  data,
  defaultFilter = "all"
}) => {
  const { t, locale } = useI18n();
  const [filterMode, setFilterMode] = useState<FilterMode>(defaultFilter);
  const tl = (key: string) => {
    if (locale === "zh-CN" && key in zhCopy) return zhCopy[key as ZhKey];
    const globalT = t(key);
    return globalT !== key ? globalT : key;
  };

  if (isLoading) {
    return <div className="repository-pr-status">{tl("Loading pull request history")}...</div>;
  }
  if (!data) {
    return <div className="repository-pr-status">{tl("Pull request history unavailable")}</div>;
  }
  if (!data.available) {
    return (
      <div className="repository-pr-status">
        <EmptyState
          title={tl("Pull request history unavailable")}
          description={tl(
            unavailableReasonKeys[data.reasonCode as keyof typeof unavailableReasonKeys]
              ?? "Pull request history could not be loaded."
          )}
          compact
        />
      </div>
    );
  }
  if (data.pullRequests.length === 0) {
    return (
      <div className="repository-pr-status">
        <EmptyState title={tl("No pull requests")} compact />
      </div>
    );
  }

  const filteredPrs = filterPullRequests(data.pullRequests, filterMode);
  const filterLabel = tl(filterMode === "all" ? "All" : filterMode === "open" ? "Open" : filterMode === "merged" ? "Merged" : "Closed");

  return (
    <div className="repository-pr-history">
      {data.page.truncated && (
        <div className="repository-pr-bounded-notice" role="status">
          {tl("Only the 100 most recent pull requests are shown. Older records are not loaded.")}
        </div>
      )}
      <div className="repository-pr-filters" aria-label={tl("Pull request filters")}>
        {(["all", "open", "merged", "closed"] as const).map(mode => (
          <Button
            key={mode}
            variant="ghost"
            size="sm"
            active={filterMode === mode}
            aria-pressed={filterMode === mode}
            onClick={() => setFilterMode(mode)}
          >
            {tl(mode === "all" ? "All" : mode === "open" ? "Open" : mode === "merged" ? "Merged" : "Closed")}
          </Button>
        ))}
      </div>
      <div className="repository-pr-list">
        {filteredPrs.length === 0 ? (
          <EmptyState
            title={tl("No pull requests for this filter")}
            description={filterLabel}
            compact
          />
        ) : filteredPrs.map(pr => {
          const displayState = pullRequestDisplayState(pr);
          const linkIsSafe = isCanonicalGitHubPullUrl(pr.htmlUrl, pr.number, data.repositoryFullName);
          return (
            <article key={`${pr.provider}-${pr.number}`} className="repository-pr-row">
              <div className="repository-pr-heading">
                <div className="repository-pr-title-wrap">
                  <span className="repository-pr-number">{tl("GitHub")} #{pr.number}</span>
                  {linkIsSafe ? (
                    <ExternalLink href={pr.htmlUrl} className="repository-pr-title">{pr.title}</ExternalLink>
                  ) : (
                    <span className="repository-pr-title">{pr.title}</span>
                  )}
                </div>
                <div className="repository-pr-badges">
                  {pr.draft && <Badge variant="neutral">{tl("Draft")}</Badge>}
                  <Badge variant={displayState === "open" ? "success" : displayState === "merged" ? "primary" : "neutral"}>
                    {tl(displayState === "open" ? "Open" : displayState === "merged" ? "Merged" : "Closed")}
                  </Badge>
                </div>
              </div>

              {pr.labels.length > 0 && (
                <div className="repository-pr-labels" aria-label={tl("Labels")}>
                  {pr.labels.map((label, index) => (
                    <span key={`${label.name}-${index}`} className="repository-pr-label">{label.name}</span>
                  ))}
                </div>
              )}

              <div className="repository-pr-metadata">
                <span>{pr.author ?? <span aria-label={tl("No author")} title={tl("No author")}>&mdash;</span>}</span>
                <span className="pr-metadata-item pr-metadata-branch">
                  <span className="pr-metadata-separator" aria-hidden="true">&bull;</span>
                  <span className="repository-pr-refs">
                    <code>{pr.baseRef} ({pr.baseSha.slice(0, 7)})</code>
                    <span aria-hidden="true">&larr;</span>
                    <code>{pr.headRef} ({pr.headSha.slice(0, 7)})</code>
                  </span>
                </span>
                <span className="pr-metadata-item"><span className="pr-metadata-separator" aria-hidden="true">&bull;</span>{tl("Created")} {new Date(pr.createdAt).toLocaleDateString(locale)}</span>
                {pr.updatedAt !== pr.createdAt && <span className="pr-metadata-item"><span className="pr-metadata-separator" aria-hidden="true">&bull;</span>{tl("Updated")} {new Date(pr.updatedAt).toLocaleDateString(locale)}</span>}
                {displayState === "merged" && pr.mergedAt && <span className="pr-metadata-item"><span className="pr-metadata-separator" aria-hidden="true">&bull;</span>{tl("Merged")} {new Date(pr.mergedAt).toLocaleDateString(locale)}</span>}
                {displayState === "closed" && pr.closedAt && <span className="pr-metadata-item"><span className="pr-metadata-separator" aria-hidden="true">&bull;</span>{tl("Closed at")} {new Date(pr.closedAt).toLocaleDateString(locale)}</span>}
              </div>

              {pr.latestReview && (
                <AppLink
                  to={`/runs/${encodeURIComponent(pr.latestReview.jobId)}/overview`}
                  className="repository-pr-review-link"
                  aria-label={`${tl("Review")}: ${tl(pr.latestReview.status)}${pr.latestReview.score !== undefined ? `, ${tl("Score")}: ${pr.latestReview.score.toFixed(2)}` : ""}${pr.latestReview.riskLevel ? `, ${tl("Risk")}: ${tl(pr.latestReview.riskLevel)}` : ""}, ${tl("Reviewed at")}: ${new Date(pr.latestReview.createdAt).toLocaleDateString(locale)}`}
                >
                  <span>{tl("Review")}:</span>
                  <Badge size="sm" variant={pr.latestReview.status === "succeeded" ? "success" : pr.latestReview.status === "failed" ? "danger" : pr.latestReview.status === "running" ? "warning" : "neutral"}>{tl(pr.latestReview.status)}</Badge>
                  {pr.latestReview.score !== undefined && <span>{tl("Score")}: {pr.latestReview.score.toFixed(2)}</span>}
                  {pr.latestReview.riskLevel && <span>{tl("Risk")}: {tl(pr.latestReview.riskLevel)}</span>}
                  <span>{tl("Reviewed at")}: {new Date(pr.latestReview.createdAt).toLocaleDateString(locale)}</span>
                </AppLink>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
};
