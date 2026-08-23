import React, { useState } from "react";
import type { RepositoryPullRequestsResponse, PullRequestSummary } from "@consistency/schema";
import { ExternalLink, AppLink } from "../design-system/Link";
import { useI18n } from "../i18n";
import { EmptyState } from "../design-system/EmptyState";
import { Badge } from "../design-system/Badge";
import { Button } from "../design-system/Button";

export interface RepositoryPullRequestsViewProps {
  isLoading: boolean;
  data: RepositoryPullRequestsResponse | undefined;
  defaultFilter?: FilterMode; // exposed for testing
}

export type FilterMode = "all" | "open" | "merged" | "closed";

export function pullRequestDisplayState(pr: PullRequestSummary): "open" | "merged" | "closed" {
  if (pr.state === "closed" && pr.mergedAt !== null) return "merged";
  return pr.state as "open" | "closed";
}

export function filterPullRequests(prs: PullRequestSummary[], mode: FilterMode): PullRequestSummary[] {
  return prs.filter((pr) => {
    if (mode === "all") return true;
    return mode === pullRequestDisplayState(pr);
  });
}

export function isSafeHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const zhCopy = {
  "Loading review workspace": "正在加载审查工作区",
  "Pull request history unavailable": "拉取请求历史不可用",
  "No pull requests": "暂无拉取请求",
  "All": "全部",
  "Open": "开放",
  "Merged": "已合并",
  "Closed": "已关闭",
  "No author": "无作者",
  "Created": "创建于",
  "Updated": "更新于",
  "Review": "审查",
  "Score": "评分",
  "Risk": "风险",
  "Reviewed at": "审查时间",
  "GitHub": "GitHub"
} as const;

type ZhKey = keyof typeof zhCopy;

export const RepositoryPullRequestsView: React.FC<RepositoryPullRequestsViewProps> = ({ isLoading, data, defaultFilter = "all" }) => {
  const { t, locale } = useI18n();
  const [filterMode, setFilterMode] = useState<FilterMode>(defaultFilter);

  const tl = (key: string) => {
    if (locale === "zh-CN" && key in zhCopy) {
      return zhCopy[key as ZhKey];
    }
    const globalT = t(key);
    return globalT !== key ? globalT : key;
  };

  if (isLoading) {
    return <div style={{ padding: "var(--space-md)", color: "var(--muted)" }}>{tl("Loading review workspace")}...</div>;
  }

  if (!data) {
    return <div style={{ padding: "var(--space-md)", color: "var(--muted)" }}>{tl("Pull request history unavailable")}</div>;
  }

  if (!data.available) {
    return (
      <div style={{ padding: "var(--space-md)" }}>
        <EmptyState
          title={tl("Pull request history unavailable")}
          description={data.reason}
          compact={true}
        />
      </div>
    );
  }

  if (data.pullRequests.length === 0) {
    return (
      <div style={{ padding: "var(--space-md)" }}>
        <EmptyState title={tl("No pull requests")} compact={true} />
      </div>
    );
  }

  const filteredPrs = filterPullRequests(data.pullRequests, filterMode);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ borderBottom: "1px solid var(--border)", padding: "var(--space-md)", display: "flex", gap: "var(--space-md)" }}>
        <Button variant="ghost" size="sm" active={filterMode === "all"} aria-pressed={filterMode === "all"} onClick={() => setFilterMode("all")}>{tl("All")}</Button>
        <Button variant="ghost" size="sm" active={filterMode === "open"} aria-pressed={filterMode === "open"} onClick={() => setFilterMode("open")}>{tl("Open")}</Button>
        <Button variant="ghost" size="sm" active={filterMode === "merged"} aria-pressed={filterMode === "merged"} onClick={() => setFilterMode("merged")}>{tl("Merged")}</Button>
        <Button variant="ghost" size="sm" active={filterMode === "closed"} aria-pressed={filterMode === "closed"} onClick={() => setFilterMode("closed")}>{tl("Closed")}</Button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "var(--space-md)", display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
        {filteredPrs.map((pr) => (
          <div key={`${pr.provider}-${pr.number}`} style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "12px", gap: "var(--space-sm)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <span style={{ color: "var(--muted)", fontSize: "14px", marginRight: "var(--space-sm)" }}>{tl("GitHub")} #{pr.number}</span>
                {isSafeHttpsUrl(pr.htmlUrl) ? (
                  <ExternalLink href={pr.htmlUrl} style={{ fontWeight: 500, color: "var(--foreground)" }}>
                    {pr.title}
                  </ExternalLink>
                ) : (
                  <span style={{ fontWeight: 500, color: "var(--foreground)" }}>{pr.title}</span>
                )}
              </div>
              <Badge variant={pullRequestDisplayState(pr) === "open" ? "success" : pullRequestDisplayState(pr) === "merged" ? "primary" : "neutral"}>
                {tl(pullRequestDisplayState(pr) === "open" ? "Open" : pullRequestDisplayState(pr) === "merged" ? "Merged" : "Closed")}
              </Badge>
            </div>
            
            <div style={{ fontSize: "14px", color: "var(--muted)", display: "flex", alignItems: "center", gap: "var(--space-sm)", flexWrap: "wrap" }}>
              <span>{pr.author ?? <span aria-label={tl("No author")} title={tl("No author")}>&mdash;</span>}</span>
              <span className="pr-metadata-item pr-metadata-branch" style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-sm)", whiteSpace: "nowrap" }}>
                <span className="pr-metadata-separator" aria-hidden="true">&bull;</span>
                <span>
                  <code style={{ background: "var(--surface-subtle)", padding: "2px 4px", borderRadius: "var(--radius-sm)", fontSize: "12px", border: "1px solid var(--border-subtle)" }}>{pr.baseRef} ({pr.baseSha.slice(0, 7)})</code>
                  <span aria-hidden="true">&larr;</span>
                  <code style={{ background: "var(--surface-subtle)", padding: "2px 4px", borderRadius: "var(--radius-sm)", fontSize: "12px", border: "1px solid var(--border-subtle)" }}>{pr.headRef} ({pr.headSha.slice(0, 7)})</code>
                </span>
              </span>
              <span className="pr-metadata-item" style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-sm)" }}>
                <span className="pr-metadata-separator" aria-hidden="true">&bull;</span>
                <span>{tl("Created")} {new Date(pr.createdAt).toLocaleDateString(locale)}</span>
              </span>
              {pr.updatedAt && pr.updatedAt !== pr.createdAt && (
                <span className="pr-metadata-item" style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-sm)" }}><span className="pr-metadata-separator" aria-hidden="true">&bull;</span><span>{tl("Updated")} {new Date(pr.updatedAt).toLocaleDateString(locale)}</span></span>
              )}
              {pullRequestDisplayState(pr) === "merged" && pr.mergedAt && (
                <span className="pr-metadata-item" style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-sm)" }}><span className="pr-metadata-separator" aria-hidden="true">&bull;</span><span>{tl("Merged")} {new Date(pr.mergedAt).toLocaleDateString(locale)}</span></span>
              )}
            </div>

            {pr.latestReview && (
              <AppLink
                to={`/runs/${encodeURIComponent(pr.latestReview.jobId)}/overview`}
                style={{ textDecoration: "none", color: "inherit", display: "block" }}
                aria-label={`${tl("Review")}: ${tl(pr.latestReview.status)}${pr.latestReview.score !== undefined ? `, ${tl("Score")}: ${pr.latestReview.score.toFixed(2)}` : ""}${pr.latestReview.riskLevel ? `, ${tl("Risk")}: ${tl(pr.latestReview.riskLevel)}` : ""}, ${tl("Reviewed at")}: ${new Date(pr.latestReview.createdAt).toLocaleDateString(locale)}`}
              >
                <div style={{ marginTop: "var(--space-sm)", paddingTop: "var(--space-sm)", borderTop: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: "var(--space-sm)", fontSize: "12px", color: "var(--muted)" }}>
                  <span>{`${tl("Review")}:`} </span>
                  <Badge size="sm" variant={
                    pr.latestReview.status === "succeeded" ? "success" : 
                    pr.latestReview.status === "failed" ? "danger" : 
                    pr.latestReview.status === "running" ? "warning" : 
                    "neutral"
                  }>
                    {tl(pr.latestReview.status)}
                  </Badge>
                  {pr.latestReview.score !== undefined && (
                    <span>{`${tl("Score")}: ${pr.latestReview.score.toFixed(2)}`}</span>
                  )}
                  {pr.latestReview.riskLevel && (
                    <span>{`${tl("Risk")}: ${tl(pr.latestReview.riskLevel)}`}</span>
                  )}
                  <span>{`${tl("Reviewed at")}: ${new Date(pr.latestReview.createdAt).toLocaleDateString(locale)}`}</span>
                </div>
              </AppLink>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
