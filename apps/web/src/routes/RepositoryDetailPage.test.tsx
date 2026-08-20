import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReviewJob, Repository } from "@consistency/schema";
import { I18nProvider } from "../i18n";
import { RepositoryDetailPage } from "./RepositoryDetailPage";
import { parseGitHubRemote } from "@consistency/vcs-core";

import { Route, Routes } from "react-router-dom";

function renderWithProviders(
  ui: React.ReactNode,
  route = "/repositories/repo_test_1"
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="zh-CN">
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/repositories/:repositoryId/*" element={ui} />
            <Route path="/repositories/:repositoryId" element={ui} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
}

const mockJobs: ReviewJob[] = [
  {
    id: "job_test_pr_254",
    type: "PR_REVIEW",
    status: "succeeded",
    repositoryFullName: "sk1ua/ConsistenCy",
    pullRequestNumber: 254,
    accessMode: "github_app",
    baseSha: "base1234567",
    headSha: "head1234567",
    publicationPolicy: "github_comment",
    createdAt: "2026-08-18T00:00:00.000Z",
    startedAt: "2026-08-18T00:00:01.000Z",
    finishedAt: "2026-08-18T00:00:15.000Z",
    report: {
      jobId: "job_test_pr_254",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 254,
      baseSha: "base1234567",
      headSha: "head1234567",
      summary: "Demo review for acme/notifications PR #254",
      score: 68,
      riskLevel: "medium",
      agentRuns: [],
      findings: [],
      createdAt: "2026-08-18T00:00:15.000Z"
    }
  }
];

const mockRepositories: Repository[] = [
  {
    id: "repo_test_1",
    displayName: "ConsistenCy",
    source: "local_git",
    remoteFullName: "sk1ua/ConsistenCy",
    defaultBranch: "v3",
    trustLevel: "trusted_local",
    monitoringEnabled: true,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z"
  }
];

describe("Repository-Centric Harness (AC-UX-REPO-1..10)", () => {
  it("AC-UX-REPO-1: parseGitHubRemote normalizes various remote URL formats", () => {
    expect(parseGitHubRemote("https://github.com/sk1ua/ConsistenCy.git")).toEqual({
      owner: "sk1ua",
      repo: "ConsistenCy",
      fullName: "sk1ua/ConsistenCy"
    });
    expect(parseGitHubRemote("git@github.com:sk1ua/ConsistenCy.git")).toEqual({
      owner: "sk1ua",
      repo: "ConsistenCy",
      fullName: "sk1ua/ConsistenCy"
    });
    expect(parseGitHubRemote("ssh://git@github.com/openai/codex")).toEqual({
      owner: "openai",
      repo: "codex",
      fullName: "openai/codex"
    });
    expect(parseGitHubRemote("https://gitlab.com/owner/repo")).toBeNull();
  });

  it("AC-UX-REPO-2: Repository Workspace renders repository identity and review action", () => {
    const html = renderWithProviders(
      <RepositoryDetailPage
        jobs={mockJobs}
        repositories={mockRepositories}
        pulse={null}
      />,
      "/repositories/repo_test_1"
    );

    expect(html).toContain("ConsistenCy");
    expect(html).toContain("本地 Git");
    expect(html).toContain("审查代码");
  });

  it("AC-UX-REPO-3: Repository Overview renders sub-navigation tabs", () => {
    const html = renderWithProviders(
      <RepositoryDetailPage
        jobs={mockJobs}
        repositories={mockRepositories}
        pulse={null}
      />,
      "/repositories/repo_test_1"
    );

    expect(html).toContain("概览");
    expect(html).toContain("变更");
    expect(html).toContain("提交历史");
    expect(html).toContain("拉取请求");
    expect(html).toContain("审查");
  });

  it("AC-UX-REPO-4: Repository detail links to related review runs", () => {
    const html = renderWithProviders(
      <RepositoryDetailPage
        jobs={mockJobs}
        repositories={mockRepositories}
        pulse={null}
      />,
      "/repositories/repo_test_1"
    );

    expect(html).toContain("PR #254");
    expect(html).toContain("68"); // Review quality score
  });

  it("AC-UX-REPO-5: PR history view renders filter buttons", () => {
    const html = renderWithProviders(
      <RepositoryDetailPage
        jobs={mockJobs}
        repositories={mockRepositories}
        pulse={null}
      />,
      "/repositories/repo_test_1/pull-requests"
    );

    expect(html).toContain("拉取请求列表");
    expect(html).toContain("全部");
    expect(html).toContain("开启中");
    expect(html).toContain("已合并");
    expect(html).toContain("已关闭");
  });

  it("AC-UX-REPO-6: Git history view renders deterministic commit list heading", () => {
    const html = renderWithProviders(
      <RepositoryDetailPage
        jobs={mockJobs}
        repositories={mockRepositories}
        pulse={null}
      />,
      "/repositories/repo_test_1/history"
    );

    expect(html).toContain("Git 提交历史");
    expect(html).toContain("确定性提交日志");
  });
});
