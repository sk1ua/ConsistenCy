import React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { RepositoryPullRequestsView, filterPullRequests, isSafeHttpsUrl } from "./RepositoryPullRequestsView";
import { I18nProvider } from "../i18n";
import { repositoryPullRequestsResponseSchema } from "@consistency/schema";
import type { RepositoryPullRequestsResponse, PullRequestSummary } from "@consistency/schema";

const mockBaseDate = "2026-08-22T00:00:00Z";

const mockPrs: PullRequestSummary[] = [
  {
    provider: "github",
    number: 1,
    title: "Open PR",
    state: "open",
    author: "user1",
    baseRef: "main",
    headRef: "feature-1",
    baseSha: "sha11111",
    headSha: "sha22222",
    createdAt: mockBaseDate,
    updatedAt: mockBaseDate,
    mergedAt: null,
    htmlUrl: "https://github.com/org/repo/pull/1"
  },
  {
    provider: "github",
    number: 2,
    title: "Merged PR",
    state: "closed",
    author: "user2",
    baseRef: "main",
    headRef: "feature-2",
    baseSha: "sha33333",
    headSha: "sha44444",
    createdAt: mockBaseDate,
    updatedAt: mockBaseDate,
    mergedAt: mockBaseDate,
    htmlUrl: "https://github.com/org/repo/pull/2"
  },
  {
    provider: "github",
    number: 3,
    title: "Closed PR",
    state: "closed",
    author: null,
    baseRef: "main",
    headRef: "feature-3",
    baseSha: "sha55555",
    headSha: "sha66666",
    createdAt: mockBaseDate,
    updatedAt: "2026-08-23T00:00:00Z",
    mergedAt: null,
    htmlUrl: "https://github.com/org/repo/pull/3",
    latestReview: {
      jobId: "job-1",
      status: "succeeded",
      createdAt: mockBaseDate,
      score: 0.95,
      riskLevel: "high"
    }
  },
  {
    provider: "github",
    number: 5,
    title: "Closed But Merged PR",
    state: "closed",
    author: "user5",
    baseRef: "main",
    headRef: "feature-5",
    baseSha: "sha99999",
    headSha: "sha00000",
    createdAt: mockBaseDate,
    updatedAt: mockBaseDate,
    mergedAt: mockBaseDate,
    htmlUrl: "https://github.com/org/repo/pull/5"
  }
];

const availableResponse = repositoryPullRequestsResponseSchema.parse({
  repositoryId: "repo-1",
  available: true,
  pullRequests: mockPrs
});

describe("RepositoryPullRequestsView", () => {
  describe("Helper Functions", () => {
    it("isSafeHttpsUrl correctly parses valid and invalid URLs", () => {
      expect(isSafeHttpsUrl("https://github.com")).toBe(true);
      expect(isSafeHttpsUrl("http://github.com")).toBe(false);
      expect(isSafeHttpsUrl("javascript:alert(1)")).toBe(false);
      expect(isSafeHttpsUrl("file:///etc/passwd")).toBe(false);
      expect(isSafeHttpsUrl("not-a-url")).toBe(false);
    });

    it("filterPullRequests correctly categorizes PRs by exact hardened criteria", () => {
      const openWithMergedAt: PullRequestSummary = {
        ...mockPrs[0],
        number: 10,
        state: "open",
        mergedAt: mockBaseDate
      } as PullRequestSummary;
      
      const closedWithNull: PullRequestSummary = {
        ...mockPrs[0],
        number: 11,
        state: "closed",
        mergedAt: null
      } as PullRequestSummary;

      const testPrs = [...mockPrs, openWithMergedAt, closedWithNull];
      
      const open = filterPullRequests(testPrs, "open");
      expect(open.map(p => p.number)).toEqual([1, 10]); // contradictory state:'open' with mergedAt must remain open

      const merged = filterPullRequests(testPrs, "merged");
      expect(merged.map(p => p.number)).toEqual([2, 5]); // only state:closed and mergedAt !== null

      const closed = filterPullRequests(testPrs, "closed");
      expect(closed.map(p => p.number)).toEqual([3, 11]); // closed and mergedAt == null
    });
  });

  describe("Component Rendering", () => {
    it("renders loading state with translated key", () => {
      const html = renderToString(
        <I18nProvider initialLocale="zh-CN">
          <RepositoryPullRequestsView isLoading={true} data={undefined} />
        </I18nProvider>
      );
      expect(html).toContain("正在加载审查工作区");
    });

    it("renders unavailable state with un-translated reason", () => {
      const providerReason = "Custom sanitized provider failure reason";
      const data: RepositoryPullRequestsResponse = { repositoryId: "repo-1", available: false, reason: providerReason, pullRequests: [] };
      
      const htmlEN = renderToString(
        <I18nProvider initialLocale="en-US">
          <RepositoryPullRequestsView isLoading={false} data={data} />
        </I18nProvider>
      );
      expect(htmlEN).toContain("Pull request history unavailable");
      expect(htmlEN).toContain(providerReason);

      const htmlZH = renderToString(
        <I18nProvider initialLocale="zh-CN">
          <RepositoryPullRequestsView isLoading={false} data={data} />
        </I18nProvider>
      );
      expect(htmlZH).toContain("拉取请求历史不可用");
      expect(htmlZH).toContain(providerReason);
    });

    it("renders empty state", () => {
      const data: RepositoryPullRequestsResponse = { repositoryId: "repo-1", available: true, pullRequests: [] };
      const html = renderToString(
        <I18nProvider initialLocale="zh-CN">
          <RepositoryPullRequestsView isLoading={false} data={data} />
        </I18nProvider>
      );
      expect(html).toContain("暂无拉取请求");
    });

    it("renders nullable author fallback, buttons, and UI elements in en-US", () => {
      const html = renderToString(
        <I18nProvider initialLocale="en-US">
          <RepositoryPullRequestsView isLoading={false} data={availableResponse} defaultFilter="closed" />
        </I18nProvider>
      );
      expect(html).toContain("No author");
      expect(html).toContain("Closed PR");
      expect(html).toContain("ds-button"); 
      expect(html).toContain("feature-3");
      expect(html).toContain("sha5555");
      expect(html).toContain("sha6666");
      expect(html).toContain("Review:");
      expect(html).toContain("succeeded");
      expect(html).toContain("Score:");
      expect(html).toContain("0.95");
      expect(html).toContain("Risk:");
      expect(html).toContain("high");
      expect(html).toContain("Reviewed at:");
      expect(html).toContain("GitHub");
      expect(html).toContain(new Date(mockBaseDate).toLocaleDateString("en-US"));
      expect(html).toContain('aria-pressed="false">All');
      expect(html).toContain('aria-pressed="false">Open');
      expect(html).toContain('aria-pressed="false">Merged');
      expect(html).toContain('aria-pressed="true">Closed');
      expect((html.match(/aria-pressed="true"/g) ?? [])).toHaveLength(1);
      expect(html).toContain('class="pr-metadata-item"');
      expect(html).toContain('class="pr-metadata-separator" aria-hidden="true"');
      expect(html).toContain('class="pr-metadata-item pr-metadata-branch"');
      expect(html).toMatch(/class="pr-metadata-item pr-metadata-branch"[^>]*>.*?class="pr-metadata-separator" aria-hidden="true".*?feature-3/s);
    });

    it("renders nullable author fallback in zh-CN and tests localized labels", () => {
      const html = renderToString(
        <I18nProvider initialLocale="zh-CN">
          <RepositoryPullRequestsView isLoading={false} data={availableResponse} defaultFilter="closed" />
        </I18nProvider>
      );
      expect(html).toContain("无作者");
      expect(html).toContain("已关闭");
      expect(html).toContain("全部");
      expect(html).toContain("开放");
      expect(html).toContain("已合并");
      expect(html).toContain("创建于");
      expect(html).toContain("更新于");
      expect(html).toContain("审查:");
      expect(html).toContain("评分:");
      expect(html).toContain("风险:");
      expect(html).toContain("高");
      expect(html).not.toContain("high");
      expect(html).not.toContain("Risk: high");
      expect(html).not.toContain("风险: high");
      expect(html).toContain("审查时间:");
      expect(html).toContain(new Date(mockBaseDate).toLocaleDateString("zh-CN"));
      expect(html).toContain("GitHub");
    });

    it("renders secure external link for safe HTTPS URLs and span for unsafe URLs", () => {
      const basePr: PullRequestSummary = {
        provider: "github",
        number: 0,
        title: "Base PR",
        state: "open",
        author: "user",
        baseRef: "main",
        headRef: "feature",
        baseSha: "sha-base",
        headSha: "sha-head",
        createdAt: mockBaseDate,
        updatedAt: mockBaseDate,
        mergedAt: null,
        htmlUrl: "https://github.com/org/repo/pull/0"
      };
      const data: RepositoryPullRequestsResponse = {
        repositoryId: "repo-1",
        available: true,
        pullRequests: [
          {
            ...basePr,
            number: 10,
            htmlUrl: "https://github.com/safe/pull/10",
            title: "Safe PR"
          },
          {
            ...basePr,
            number: 11,
            htmlUrl: "javascript:alert(1)",
            title: "Unsafe PR"
          }
        ]
      };
      const html = renderToString(
        <I18nProvider initialLocale="en-US">
          <RepositoryPullRequestsView isLoading={false} data={data} defaultFilter="all" />
        </I18nProvider>
      );
      expect(html).toContain('href="https://github.com/safe/pull/10"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain('class="ds-external-link');
      expect(html).toContain('Safe PR');

      expect(html).not.toContain('href="javascript:alert(1)"');
      expect(html).toContain('Unsafe PR');
      expect(html.match(/class="ds-external-link"/g)?.length).toBe(1);
    });

    it("keeps malformed and unsupported PR URLs non-navigable", () => {
      const basePr: PullRequestSummary = {
        provider: "github",
        number: 0,
        title: "Base PR",
        state: "open",
        author: "user",
        baseRef: "main",
        headRef: "feature",
        baseSha: "sha-base",
        headSha: "sha-head",
        createdAt: mockBaseDate,
        updatedAt: mockBaseDate,
        mergedAt: null,
        htmlUrl: "https://github.com/org/repo/pull/0"
      };
      const data: RepositoryPullRequestsResponse = {
        repositoryId: "repo-1",
        available: true,
        pullRequests: [
          { ...basePr, number: 12, title: "HTTP PR", htmlUrl: "http://github.com/org/repo/pull/12" },
          { ...basePr, number: 13, title: "File PR", htmlUrl: "file:///C:/passwords.txt" },
          { ...basePr, number: 14, title: "Malformed PR", htmlUrl: "not-a-url" }
        ]
      };

      const html = renderToString(
        <I18nProvider initialLocale="en-US">
          <RepositoryPullRequestsView isLoading={false} data={data} />
        </I18nProvider>
      );

      expect(html).not.toContain('href="http://github.com/org/repo/pull/12"');
      expect(html).not.toContain('href="file:///C:/passwords.txt"');
      expect(html).not.toContain('href="not-a-url"');
      expect(html).toContain("HTTP PR");
      expect(html).toContain("File PR");
      expect(html).toContain("Malformed PR");
    });

    it("renders AppLink for latestReview with properly encoded URL", () => {
      const prWithReview: PullRequestSummary = {
        ...mockPrs[0],
        number: 42,
        latestReview: {
          jobId: "job/123 %",
          status: "succeeded",
          createdAt: mockBaseDate,
          score: 1.0,
          riskLevel: "low"
        }
      } as PullRequestSummary;
      
      const data: RepositoryPullRequestsResponse = {
        repositoryId: "repo-1",
        available: true,
        pullRequests: [prWithReview]
      };

      const html = renderToString(
        <I18nProvider initialLocale="en-US">
          <RepositoryPullRequestsView isLoading={false} data={data} defaultFilter="all" />
        </I18nProvider>
      );
      
      expect(html).toContain('href="/runs/job%2F123%20%25/overview"');
      expect(html).toContain("Review:");
      expect(html).toContain("Score: 1.00");
    });

    it("does not render review section if absent", () => {
      const html = renderToString(
        <I18nProvider initialLocale="en-US">
          <RepositoryPullRequestsView isLoading={false} data={availableResponse} defaultFilter="open" />
        </I18nProvider>
      );
      
      expect(html).toContain("Open PR");
      expect(html).not.toContain("Review:");
      expect(html).not.toContain("Score:");
    });

    it("renders open state with non-null mergedAt correctly as Open and does not render Merged date", () => {
      const contradictoryPr: PullRequestSummary = {
        ...mockPrs[0], 
        title: "Contradictory PR",
        mergedAt: mockBaseDate
      } as PullRequestSummary;
      const data: RepositoryPullRequestsResponse = {
        repositoryId: "repo-1",
        available: true,
        pullRequests: [contradictoryPr]
      };
      
      const html = renderToString(
        <I18nProvider initialLocale="en-US">
          <RepositoryPullRequestsView isLoading={false} data={data} defaultFilter="all" />
        </I18nProvider>
      );
      
      expect(html).toContain("Contradictory PR");
      expect(html).toContain("ds-badge--success\">Open</span>");
      
      expect(html).not.toContain("<span>Merged");
    });
  });
});
