import React from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { PullRequestSummary, RepositoryPullRequestsResponse } from "@consistency/schema";
import { I18nProvider } from "../i18n";
import {
  RepositoryPullRequestsView,
  filterPullRequests,
  isCanonicalGitHubPullUrl,
  pullRequestDisplayState
} from "./RepositoryPullRequestsView";

const date = "2026-08-22T00:00:00.000Z";
const basePr: PullRequestSummary = {
  provider: "github",
  number: 1,
  title: "Open PR",
  state: "open",
  draft: true,
  labels: [{ name: "needs review", color: "d73a4a" }],
  author: "alice",
  baseRef: "main",
  headRef: "feature",
  baseSha: "base123",
  headSha: "head123",
  createdAt: date,
  updatedAt: date,
  closedAt: null,
  mergedAt: null,
  htmlUrl: "https://github.com/org/repo/pull/1"
};

const prs: PullRequestSummary[] = [
  basePr,
  { ...basePr, number: 2, title: "Merged PR", state: "closed", draft: false, closedAt: date, mergedAt: date, htmlUrl: "https://github.com/org/repo/pull/2" },
  { ...basePr, number: 3, title: "Closed PR", state: "closed", draft: false, closedAt: date, mergedAt: null, htmlUrl: "https://github.com/org/repo/pull/3" }
];

const available = (pullRequests = prs, truncated = false): RepositoryPullRequestsResponse => ({
  repositoryId: "repo-1",
  repositoryFullName: "org/repo",
  available: true,
  page: { limit: 100, truncated },
  pullRequests
});

function render(data: RepositoryPullRequestsResponse | undefined, locale: "en-US" | "zh-CN" = "en-US", defaultFilter?: "all" | "open" | "merged" | "closed") {
  return renderToString(
    <I18nProvider initialLocale={locale}>
      <RepositoryPullRequestsView isLoading={false} data={data} defaultFilter={defaultFilter} />
    </I18nProvider>
  );
}

describe("RepositoryPullRequestsView", () => {
  it("derives merged state only from closed plus mergedAt and filters locally", () => {
    const contradictory = { ...basePr, number: 4, mergedAt: date } as PullRequestSummary;
    expect(pullRequestDisplayState(contradictory)).toBe("open");
    expect(filterPullRequests([...prs, contradictory], "open").map(pr => pr.number)).toEqual([1, 4]);
    expect(filterPullRequests(prs, "merged").map(pr => pr.number)).toEqual([2]);
    expect(filterPullRequests(prs, "closed").map(pr => pr.number)).toEqual([3]);
  });

  it("accepts only canonical github.com pull links with matching repository and number", () => {
    expect(isCanonicalGitHubPullUrl("https://github.com/org/repo/pull/42", 42, "ORG/REPO")).toBe(true);
    expect(isCanonicalGitHubPullUrl(
      "https://github.com/Mixed-Owner/repo.name_with-parts/pull/42",
      42,
      "mIXED-oWNER/REPO.NAME_WITH-PARTS"
    )).toBe(true);
    const owner39 = "a".repeat(39);
    const repo100 = `Repo.${"x".repeat(91)}_end`;
    expect(isCanonicalGitHubPullUrl(
      `https://github.com/${owner39}/${repo100}/pull/42`,
      42,
      `${owner39}/${repo100}`
    )).toBe(true);
    expect(isCanonicalGitHubPullUrl("https://github.com/org/repo/pull/42", 42)).toBe(false);
    expect(isCanonicalGitHubPullUrl("https://github.com//repo/pull/42", 42, "/repo")).toBe(false);
    expect(isCanonicalGitHubPullUrl("https://github.com/owner//pull/42", 42, "owner/")).toBe(false);
    expect(isCanonicalGitHubPullUrl("https://github.com/bad-/repo/pull/42", 42, "bad-/repo")).toBe(false);
    expect(isCanonicalGitHubPullUrl("https://github.com/owner/.../pull/42", 42, "owner/...")).toBe(false);
    expect(isCanonicalGitHubPullUrl(
      `https://github.com/${"a".repeat(40)}/repo/pull/42`,
      42,
      `${"a".repeat(40)}/repo`
    )).toBe(false);
    expect(isCanonicalGitHubPullUrl(
      `https://github.com/owner/${"r".repeat(101)}/pull/42`,
      42,
      `owner/${"r".repeat(101)}`
    )).toBe(false);
    for (const url of [
      "http://github.com/org/repo/pull/42",
      "https://example.com/org/repo/pull/42",
      "https://github.com/org/other/pull/42",
      "https://github.com/org/repo/pull/43",
      "https://user@github.com/org/repo/pull/42",
      "https://github.com:443/org/repo/pull/42",
      "https://github.com/org/repo/pull/42?x=1",
      "https://github.com/org/repo/pull/%34%32",
      "https://github.com/org/./repo/pull/42",
      "https://github.com/org/segment/../repo/pull/42",
      String.raw`https://github.com/org\repo/pull/42`,
      String.raw`https://github.com/org/repo\pull/42`
    ]) expect(isCanonicalGitHubPullUrl(url, 42, "org/repo")).toBe(false);
  });

  it("renders loading, all localized unavailable reason codes, and empty states", () => {
    const loading = renderToString(<I18nProvider initialLocale="zh-CN"><RepositoryPullRequestsView isLoading data={undefined} /></I18nProvider>);
    expect(loading).toContain("正在加载拉取请求历史");
    const cases = [
      ["not_github", "This repository provider is not GitHub.", "此仓库的提供方不是 GitHub。"],
      ["identity_unavailable", "GitHub repository identity is unavailable.", "无法确定 GitHub 仓库身份。"],
      ["not_found", "The GitHub repository was not found.", "未找到该 GitHub 仓库。"],
      ["access_denied", "GitHub access was denied.", "GitHub 访问被拒绝。"],
      ["rate_limited", "GitHub rate limit was reached.", "已达到 GitHub 速率限制。"],
      ["provider_unavailable", "GitHub pull request history is temporarily unavailable.", "GitHub 拉取请求历史暂时不可用。"],
      ["invalid_provider_data", "GitHub returned invalid pull request data.", "GitHub 返回了无效的拉取请求数据。"]
    ] as const;
    for (const [reasonCode, english, chinese] of cases) {
      const data: RepositoryPullRequestsResponse = {
        repositoryId: "repo-1",
        available: false,
        reasonCode,
        reason: "raw provider reason must not render",
        pullRequests: []
      };
      expect(render(data, "en-US")).toContain(english);
      expect(render(data, "en-US")).not.toContain(data.reason);
      expect(render(data, "zh-CN")).toContain(chinese);
      expect(render(data, "zh-CN")).not.toContain(data.reason);
    }
    const adversarialUnknown = {
      repositoryId: "repo-1",
      available: false,
      reasonCode: "future_provider_code",
      reason: "SECRET_TOKEN_XYZ C:/private/worktree /var/run/secrets/key",
      pullRequests: []
    } as unknown as RepositoryPullRequestsResponse;
    const unknownEnglish = render(adversarialUnknown, "en-US");
    expect(unknownEnglish).toContain("Pull request history could not be loaded.");
    expect(unknownEnglish).not.toContain("SECRET_TOKEN_XYZ");
    expect(unknownEnglish).not.toContain("private/worktree");
    const unknownChinese = render(adversarialUnknown, "zh-CN");
    expect(unknownChinese).toContain("无法加载拉取请求历史。");
    expect(unknownChinese).not.toContain("/var/run/secrets/key");
    expect(render(available([]), "zh-CN")).toContain("暂无拉取请求");
  });

  it("renders a filter-specific empty state instead of a blank list", () => {
    const html = render(available([basePr]), "en-US", "closed");
    expect(html).toContain("No pull requests for this filter");
    expect(html).toContain("Closed");
  });

  it("renders bounded notice, draft badge, labels, metadata wrapping hooks, and localized copy", () => {
    const en = render(available(prs, true));
    expect(en).toContain("Only the 100 most recent pull requests are shown. Older records are not loaded.");
    expect(en).toContain("Draft");
    expect(en).toContain("needs review");
    expect(en).toContain("repository-pr-labels");
    expect(en).toContain("repository-pr-metadata");
    const zh = render(available(prs, true), "zh-CN");
    expect(zh).toContain("仅显示最近 100 条拉取请求，旧记录未加载。");
    expect(zh).toContain("草稿");
    expect(zh).toContain("needs review");
  });

  it("renders canonical links and keeps mismatched or identity-less links as plain text", () => {
    const unsafe = { ...basePr, number: 7, title: "Unsafe PR", htmlUrl: "https://github.com/other/repo/pull/7" };
    const html = render(available([basePr, unsafe]));
    expect(html).toContain('href="https://github.com/org/repo/pull/1"');
    expect(html).not.toContain('href="https://github.com/other/repo/pull/7"');
    expect(html).toContain("Unsafe PR");

    const identityLess = { ...available([basePr]) } as Record<string, unknown>;
    delete identityLess.repositoryFullName;
    const identityLessHtml = render(identityLess as RepositoryPullRequestsResponse);
    expect(identityLessHtml).toContain("Open PR");
    expect(identityLessHtml).not.toContain('href="https://github.com/org/repo/pull/1"');
  });

  it("renders latest review via the existing run route", () => {
    const withReview: PullRequestSummary = {
      ...basePr,
      latestReview: { jobId: "job/123 %", status: "succeeded", score: 0.95, riskLevel: "high", createdAt: date }
    };
    const html = render(available([withReview]));
    expect(html).toContain('href="/runs/job%2F123%20%25/overview"');
    expect(html).toContain("Score: 0.95");
  });
});
