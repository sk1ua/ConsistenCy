import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReviewJob, Repository, ReviewPreparationResponse } from "@consistency/schema";
import { repositoryGitStatusResponseSchema, repositoryCommitsResponseSchema, repositoryPullRequestsResponseSchema } from "@consistency/schema";
import { I18nProvider, type Locale } from "../i18n";
import { api } from "../api/client";
import { createRepositoryPullRequestsQueryOptions, formatReviewMutationError, isReviewStartDisabled, RepositoryDetailPage } from "./RepositoryDetailPage";
import { buildLocalReviewRequest, calculateDialogTransition, createReviewSubmissionGate, getReviewComposerValidationMessage, ReviewComposerDialog } from "./ReviewComposerDialog";
import { parseGitHubRemote } from "@consistency/vcs-core";

import { Route, Routes } from "react-router-dom";

function renderWithProviders(
  ui: React.ReactNode,
  route = "/repositories/repo_test_1",
  queryClientArg?: QueryClient | ((qc: QueryClient) => void),
  locale: Locale = "zh-CN"
) {
  let qc: QueryClient;
  if (queryClientArg && typeof queryClientArg === 'object') {
    qc = queryClientArg as QueryClient;
  } else {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    if (typeof queryClientArg === 'function') queryClientArg(qc);
  }
  const reviewsKey = ["workspace", "repositories", "repo_test_1", "reviews"] as const;
  if (qc.getQueryState(reviewsKey) === undefined) qc.setQueryData(reviewsKey, []);
  return renderToString(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale={locale}>
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

const preparation = (canStartReview: boolean): ReviewPreparationResponse => ({
  repository: {
    id: "repo_test_1",
    displayName: "ConsistenCy",
    sourceKind: "local_git",
    trust: "trusted_local"
  },
  sources: {
    workingTree: { available: true, changedFileCount: 1 },
    branch: { available: true, base: "main", head: "v3" }
  },
  model: {
    default: { provider: "deepseek", model: "deepseek-v4-flash" },
    providers: {
      deepseek: { configured: true, defaultModel: "deepseek-v4-flash" },
      openai: { configured: false, defaultModel: "gpt-4.1-mini" }
    },
    pendingRestart: null
  },
  canStartReview,
  blockingReasons: canStartReview ? [] : ["LLM provider is not configured"]
});

describe("Repository-Centric Harness (AC-UX-REPO-1..10)", () => {
  it("uses only server-owned preparation state to enable review execution", () => {
    expect(isReviewStartDisabled()).toBe(true);
    expect(isReviewStartDisabled(preparation(false))).toBe(true);
    expect(isReviewStartDisabled(preparation(true))).toBe(false);
  });

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

  it.each([
    {
      repositoryId: "repo_test_2",
      reviews: []
    },
    {
      repositoryId: "repo_test_1",
      reviews: [],
      unexpected: "provider detail"
    },
    {
      repositoryId: "repo_test_1",
      reviews: [{ ...mockJobs[0], repositoryId: undefined }]
    }
  ])("fails closed for malformed repository review client responses", async payload => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    })));
    try {
      await expect(api.repositoryReviews("repo_test_1")).rejects.toMatchObject({
        code: "REPOSITORY_REVIEWS_RESPONSE_INVALID",
        message: "Repository review history response is unavailable"
      });
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("AC-UX-REPO-3: Repository Overview renders sub-navigation tabs and changes view", () => {
    const html = renderWithProviders(
      <RepositoryDetailPage
        jobs={mockJobs}
        repositories={mockRepositories}
        pulse={null}
      />,
      "/repositories/repo_test_1/changes",
      (qc) => {
        qc.setQueryData(["repository-git-status", "repo_test_1"], repositoryGitStatusResponseSchema.parse({
          repositoryId: "repo_test_1",
          available: true,
          branch: "main",
          headSha: "abcdef1",
          dirtyFileCount: 5,
          untrackedFileCount: 3,
          changedFiles: [
            { path: "src/main.ts", status: "modified", additions: 5, deletions: 2, binary: false, hunks: [] }
          ],
          untrackedFiles: ["new_file.txt"],
          remotes: []
        }));
      }
    );

    expect(html).toContain("工作区变更");
    expect(html).toContain("src/main.ts");
    expect(html).toContain("变更");
    expect(html).toMatch(/<span[^>]*>变更<\/span><span[^>]*>8<\/span>/); // structural check for badge sum
    expect(html).toContain("提交历史");
    expect(html).toContain("拉取请求");
    expect(html).toContain("审查");
    expect(html).toContain("工作流");
  });

  it("AC-UX-REPO-4: Repository detail links to related review runs", () => {
    const html = renderWithProviders(
      <RepositoryDetailPage
        jobs={mockJobs}
        repositories={mockRepositories}
        pulse={null}
      />,
      "/repositories/repo_test_1",
      queryClient => queryClient.setQueryData(
        ["workspace", "repositories", "repo_test_1", "reviews"],
        [{ ...mockJobs[0]!, repositoryId: "repo_test_1" }]
      )
    );

    expect(html).toContain("PR #254");
    expect(html).toContain("68");
  });

  it("uses only exact opaque repository review association across overview, count, and Reviews tab", () => {
    const exact = {
      ...mockJobs[0]!,
      id: "job-exact-repository",
      repositoryId: "repo_test_1",
      pullRequestNumber: 101
    };
    const sameNameOtherId = {
      ...mockJobs[0]!,
      id: "job-other-repository",
      repositoryId: "repo_test_2",
      pullRequestNumber: 202
    };
    const legacy = {
      ...mockJobs[0]!,
      id: "job-legacy-no-id",
      repositoryId: undefined,
      pullRequestNumber: 303
    };
    const repositories = [
      mockRepositories[0]!,
      { ...mockRepositories[0]!, id: "repo_test_2" }
    ];
    const seedReviews = (queryClient: QueryClient) => {
      queryClient.setQueryData(["workspace", "repositories", "repo_test_1", "reviews"], [exact]);
    };

    const overview = renderWithProviders(
      <RepositoryDetailPage
        jobs={[exact, sameNameOtherId, legacy]}
        repositories={repositories}
        pulse={null}
      />,
      "/repositories/repo_test_1",
      seedReviews
    );
    expect(overview).toContain("PR #101");
    expect(overview).not.toContain("PR #202");
    expect(overview).not.toContain("PR #303");
    expect(overview).toMatch(/<span[^>]*>审查<\/span><span[^>]*>1<\/span>/);

    const reviews = renderWithProviders(
      <RepositoryDetailPage
        jobs={[exact, sameNameOtherId, legacy]}
        repositories={repositories}
        pulse={null}
      />,
      "/repositories/repo_test_1/reviews",
      seedReviews
    );
    expect(reviews).toContain("共 1 条");
    expect(reviews).toContain("PR #101");
    expect(reviews).not.toContain("PR #202");
    expect(reviews).not.toContain("PR #303");
  });

  it("AC-UX-REPO-8: overview uses compact single-language section headings", () => {
    const html = renderWithProviders(
      <RepositoryDetailPage
        jobs={[]}
        repositories={mockRepositories}
        pulse={null}
      />,
      "/repositories/repo_test_1"
    );

    expect(html).toContain("最近审查");
    expect(html).toContain("最近提交");
    expect(html).not.toContain("最近审查记录 (Recent Reviews)");
    expect(html).not.toContain("最近代码提交 (Recent Commits)");
    expect(html).toContain("repo-overview-empty");
  });

  it("AC-UX-REPO-9: composer uses the global default without an invalid provider/model pair", () => {
    const prep = preparation(true);
    const html = renderToString(
      <ReviewComposerDialog
        isOpen
        onClose={() => undefined}
        displayName="ConsistenCy"
        repositoryId="repo_test_1"
        preparation={prep}
        pending={false}
        onSubmit={() => undefined}
        zh
        onConfigureModel={() => undefined}
      />
    );

    expect(html).toContain("DeepSeek");
    expect(html).toContain("deepseek-v4-flash");
    expect(html).not.toContain("none ·");
    expect(html).toContain("使用全局默认");
  });

  it("AC-UX-REPO-10: custom model payload contains only the per-review override", () => {
    const prep = preparation(true);
    expect(buildLocalReviewRequest("repo_test_1", "branch", prep, false, "deepseek", "deepseek-reviewer")).toEqual({
      repositoryId: "repo_test_1",
      baseRef: "main",
      headRef: "v3",
      model: { provider: "deepseek", model: "deepseek-reviewer" }
    });
    expect(buildLocalReviewRequest("repo_test_1", "working-tree", prep, true, "deepseek", "")).toEqual({
      repositoryId: "repo_test_1"
    });
    expect(buildLocalReviewRequest("repo_test_1", "branch", prep, true, "openai", " ignored ")).toEqual({
      repositoryId: "repo_test_1",
      baseRef: "main",
      headRef: "v3"
    });
    expect(buildLocalReviewRequest("repo_test_1", "working-tree", prep, false, "deepseek", "  deepseek-reviewer  ")).toEqual({
      repositoryId: "repo_test_1",
      model: { provider: "deepseek", model: "deepseek-reviewer" }
    });
  });

  it("AC-UX-REPO-10: submission gate rejects immediate duplicates and reopens after failure", () => {
    const gate = createReviewSubmissionGate();
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
    gate.reset();
    expect(gate.tryAcquire()).toBe(true);
  });

  it("AC-UX-REPO-11: no-LLM composer blocks execution and offers model configuration", () => {
    const prep = {
      ...preparation(false),
      model: {
        default: { provider: "none" as const, model: "deepseek-v4-flash" },
        providers: {
          deepseek: { configured: false, defaultModel: "deepseek-v4-flash" },
          openai: { configured: false, defaultModel: "gpt-4.1-mini" }
        },
        pendingRestart: null
      }
    };
    const html = renderToString(
      <ReviewComposerDialog
        isOpen
        onClose={() => undefined}
        displayName="ConsistenCy"
        repositoryId="repo_test_1"
        preparation={prep}
        pending={false}
        onSubmit={() => undefined}
        zh
        onConfigureModel={() => undefined}
      />
    );

    expect(html).toContain("尚未配置大语言模型");
    expect(html).toContain("配置模型");
    expect(html).not.toContain("none · deepseek-v4-flash");
  });

  it("AC-UX-REPO-12: readiness strip is not a second review command", () => {
    const html = renderWithProviders(
      <RepositoryDetailPage jobs={[]} repositories={mockRepositories} pulse={null} />,
      "/repositories/repo_test_1"
    );
    const primaryButtons = html.match(/ds-button ds-button--primary/g) ?? [];
    expect(primaryButtons).toHaveLength(1);
  });

  it("AC-UX-REPO-5: PR history view renders filter buttons", () => {
    const html = renderWithProviders(
      <RepositoryDetailPage
        jobs={mockJobs}
        repositories={mockRepositories}
        pulse={null}
      />,
      "/repositories/repo_test_1/pull-requests",
      (qc) => {
        qc.setQueryData(["workspace", "repositories", "repo_test_1", "pull-requests"], repositoryPullRequestsResponseSchema.parse({
          repositoryId: "repo_test_1",
          repositoryFullName: "sk1ua/ConsistenCy",
          available: true,
          page: { limit: 100, truncated: false },
          pullRequests: [
            {
              provider: "github",
              number: 1,
              title: "Demo PR",
              state: "open",
              draft: false,
              labels: [],
              author: "alice",
              createdAt: "2026-08-18T00:00:00.000Z",
              updatedAt: "2026-08-18T01:00:00.000Z",
              htmlUrl: "https://github.com/sk1ua/ConsistenCy/pull/1",
              baseRef: "main",
              headRef: "feature",
              baseSha: "1111111",
              headSha: "2222222",
              closedAt: null,
              mergedAt: null
            }
          ]
        }));
      }
    );

    expect(html).toContain("拉取请求列表");
    expect(html).toContain("全部");
    expect(html).toContain("开放");
    expect(html).toContain("已合并");
    expect(html).toContain("已关闭");
    expect(html).toContain("Demo PR");
  });

  it("AC-UX-REPO-14: PR history view renders unavailable and empty states", () => {
    const emptyHtml = renderWithProviders(
      <RepositoryDetailPage jobs={mockJobs} repositories={mockRepositories} pulse={null} />,
      "/repositories/repo_test_1/pull-requests",
      (qc) => qc.setQueryData(["workspace", "repositories", "repo_test_1", "pull-requests"], repositoryPullRequestsResponseSchema.parse({ repositoryId: "repo_test_1", repositoryFullName: "sk1ua/ConsistenCy", available: true, page: { limit: 100, truncated: false }, pullRequests: [] }))
    );
    expect(emptyHtml).toContain("暂无拉取请求");

    const unavailableHtml = renderWithProviders(
      <RepositoryDetailPage jobs={mockJobs} repositories={mockRepositories} pulse={null} />,
      "/repositories/repo_test_1/pull-requests",
      (qc) => qc.setQueryData(["workspace", "repositories", "repo_test_1", "pull-requests"], repositoryPullRequestsResponseSchema.parse({ repositoryId: "repo_test_1", available: false, reasonCode: "access_denied", reason: "GitHub access denied", pullRequests: [] }))
    );
    expect(unavailableHtml).toContain("拉取请求历史不可用");
    expect(unavailableHtml).toContain("GitHub 访问被拒绝。");
    expect(unavailableHtml).not.toContain("GitHub access denied");
  });

  it("AC-UX-REPO-15: Changes, History, and PR views handle actual rejected queries", async () => {
    const tabs = [
      {
        id: "changes",
        queryKey: ["repository-git-status", "repo_test_1"],
        zhFallback: "由于网络或服务异常，无法加载仓库状态",
        enFallback: "Failed to load repository status due to network or service error",
        zhLoading: "加载中",
        enLoading: "Loading"
      },
      {
        id: "history",
        queryKey: ["repository-commits", "repo_test_1"],
        zhFallback: "由于网络或服务异常，无法加载提交历史",
        enFallback: "Failed to load commit history due to network or service error",
        zhLoading: "正在加载提交历史",
        enLoading: "Loading Git history"
      },
      {
        id: "pull-requests",
        queryKey: ["workspace", "repositories", "repo_test_1", "pull-requests"],
        zhFallback: "GitHub 拉取请求历史暂时不可用。",
        enFallback: "GitHub pull request history is temporarily unavailable.",
        zhLoading: "正在加载拉取请求历史",
        enLoading: "Loading pull request history"
      }
    ];

    for (const tab of tabs) {
      for (const locale of ["zh-CN", "en-US"]) {
        const qc = new QueryClient({
          defaultOptions: {
            queries: {
              retry: false,
              gcTime: Infinity
            }
          }
        });
        const sentinelError = new Error(`SECRET_TOKEN_XYZ_123 /var/run/secrets/xyz ${tab.id}`);

        await qc.fetchQuery({
          queryKey: tab.queryKey,
          queryFn: () => Promise.reject(sentinelError)
        }).catch(() => {});

        const html = renderWithProviders(
          <RepositoryDetailPage jobs={mockJobs} repositories={mockRepositories} pulse={null} />,
          `/repositories/repo_test_1/${tab.id}`,
          qc,
          locale as Locale
        );

        expect(html).toContain(locale === "zh-CN" ? tab.zhFallback : tab.enFallback);
        expect(html).not.toContain("SECRET_TOKEN_XYZ_123");
        expect(html).not.toContain(locale === "zh-CN" ? tab.zhLoading : tab.enLoading);
      }
    }
  });

  it("AC-UX-REPO-6: Git history view renders deterministic commit list heading", () => {
    const html = renderWithProviders(
      <RepositoryDetailPage
        jobs={mockJobs}
        repositories={mockRepositories}
        pulse={null}
      />,
      "/repositories/repo_test_1/history",
      (qc) => {
        qc.setQueryData(["repository-commits", "repo_test_1"], repositoryCommitsResponseSchema.parse({
          repositoryId: "repo_test_1",
          available: true,
          commits: [
            {
              sha: "abcdef123456",
              parentShas: ["0000000"],
              message: "Initial commit",
              author: { name: "alice", email: "alice@example.com" },
              authoredAt: "2026-08-18T00:00:00.000Z"
            }
          ]
        }));
      }
    );

    expect(html).toContain("Git 提交历史");
    expect(html).toContain("确定性提交日志");
    expect(html).toContain("Initial commit");
  });

  it("AC-UX-REPO-7: never renders Mock 模型 in review modal or detail view", () => {
    const html = renderWithProviders(
      <RepositoryDetailPage
        jobs={mockJobs}
        repositories={mockRepositories}
        pulse={null}
        health={{
          ok: true,
          service: "consistency-api",
          database: { ok: true },
          worker: { running: true, activeJobs: 0, concurrency: 1 },
          llmConfigured: true,
          llmProvider: "deepseek",
          llmModel: "deepseek-v4-flash",
          llmCapabilities: {
            deepseek: { configured: true, defaultModel: "deepseek-v4-flash" },
            openai: { configured: false, defaultModel: "gpt-4.1-mini" }
          },
          configuration: {
            githubAppConfigured: false,
            webhookSecretConfigured: false,
            publicReadTokenConfigured: false,
            storage: { kind: "file", configured: true },
            workerConcurrency: 1
          }
        }}
      />,
      "/repositories/repo_test_1"
    );

    expect(html).not.toContain("Mock 模型");
    expect(html).not.toContain("Mock model");
    expect(html).not.toContain("演示样例数据");
  });

  it("AC-UX-REPO-13: no-LLM composer shows pendingRestart if configuration was saved but active provider is none", () => {
    const prep = {
      ...preparation(false),
      model: {
        default: { provider: "none" as const, model: "deepseek-v4-flash" },
        providers: {
          deepseek: { configured: false, defaultModel: "deepseek-v4-flash" },
          openai: { configured: false, defaultModel: "gpt-4.1-mini" }
        },
        pendingRestart: { provider: "deepseek" as const, model: "deepseek-test", credentialConfigured: true }
      },
      blockingReasons: ["LLM 提供商配置已保存，重启 API 后生效。"]
    };
    const html = renderToString(
      <ReviewComposerDialog
        isOpen
        onClose={() => undefined}
        displayName="ConsistenCy"
        repositoryId="repo_test_1"
        preparation={prep}
        pending={false}
        onSubmit={() => undefined}
        zh
        onConfigureModel={() => undefined}
      />
    );

    expect(html).not.toContain("尚未配置大语言模型");
    expect(html).toContain("DeepSeek");
    expect(html).toContain("deepseek-test");
    expect(html).toContain("配置已保存");
    expect(html).not.toContain("LLM 提供商配置已保存，重启 API 后生效。");
    const inlineGuidanceCount = (html.match(/需重启后端服务后生效/g) ?? []).length;
    expect(inlineGuidanceCount).toBe(1);
  });

  it("AC-UX-REPO-16: custom model validation is visible for empty and unavailable choices", () => {
    const prep = preparation(true);
    expect(getReviewComposerValidationMessage({ preparation: prep, provider: "deepseek", model: "   ", useGlobalDefault: false, zh: false })).toBe("Enter a model name.");
    expect(getReviewComposerValidationMessage({ preparation: prep, provider: "openai", model: "gpt-4.1-mini", useGlobalDefault: false, zh: false })).toBe("That provider is not configured.");
    expect(getReviewComposerValidationMessage({ preparation: prep, provider: "deepseek", model: "   ", useGlobalDefault: false, zh: true })).toBe("请输入模型名称。");
  });

  it("AC-UX-REPO-18: composer custom controls use shared input primitives", () => {
    const source = readFileSync(new URL("./ReviewComposerDialog.tsx", import.meta.url), "utf8");
    expect(source).toContain('import { Input } from "../design-system/Input";');
    expect(source).toContain('className="ds-input ds-select"');
    expect(source).toContain("<Input");
  });

  it("AC-UX-REPO-17: review launch failures use only localized generic feedback", () => {
    const secretFailure = new Error("SECRET_TOKEN_XYZ /var/run/secrets/provider");
    expect(formatReviewMutationError(true, secretFailure)).toBe("请求失败，请稍后重试。");
    expect(formatReviewMutationError(false, secretFailure)).toBe("Request failed. Please try again later.");
  });

  it("AC-UX-REPO-19: composer disables dismissal and action buttons while pending", () => {
    const prep = preparation(true);
    const htmlPending = renderToString(
      <ReviewComposerDialog
        isOpen
        onClose={() => undefined}
        displayName="ConsistenCy"
        repositoryId="repo_test_1"
        preparation={prep}
        pending={true}
        onSubmit={() => undefined}
        zh={false}
        onConfigureModel={() => undefined}
      />
    );

    expect(htmlPending).toMatch(/<button[^>]*aria-label="Close"[^>]*disabled/);
    expect(htmlPending).toMatch(/<button[^>]*disabled[^>]*>Cancel<\/button>/);
    expect(htmlPending).toMatch(/<input[^>]*type="radio"[^>]*disabled[^>]*>/);

    const prepNoLlm = {
      ...prep,
      model: { ...prep.model, default: { provider: "none" as const, model: "deepseek-v4-flash" } }
    };
    const htmlNoLlmPending = renderToString(
      <ReviewComposerDialog
        isOpen
        onClose={() => undefined}
        displayName="ConsistenCy"
        repositoryId="repo_test_1"
        preparation={prepNoLlm}
        pending={true}
        onSubmit={() => undefined}
        zh={false}
        onConfigureModel={() => undefined}
      />
    );

    expect(htmlNoLlmPending).toMatch(/<button[^>]*disabled[^>]*>Configure model<\/button>/);

    const sourceDialog = readFileSync(new URL("../design-system/Dialog.tsx", import.meta.url), "utf8");
    expect(sourceDialog).toContain("dismissible = true");
    expect(sourceDialog).toContain("e.key === \"Escape\" && dismissible");
    expect(sourceDialog).toContain("e.target === e.currentTarget && dismissible");
    expect(sourceDialog).toContain("disabled={!dismissible}");

    const sourceComposer = readFileSync(new URL("./ReviewComposerDialog.tsx", import.meta.url), "utf8");
    expect(sourceComposer).toContain("dismissible={!pending}");
    expect(sourceComposer).toContain("if (pending) return;");
  });

  it("AC-UX-REPO-21: header Start Review button reflects review preparation readiness", () => {
    // 1. Absent/Loading
    const htmlAbsent = renderWithProviders(
      <RepositoryDetailPage jobs={mockJobs} repositories={mockRepositories} pulse={null} />,
      "/repositories/repo_test_1",
      undefined,
      "en-US"
    );
    expect(htmlAbsent).toMatch(/<button[^>]*disabled=""[^>]*>.*?Start Review<\/button>/);

    // 2. Cannot start
    const htmlFalse = renderWithProviders(
      <RepositoryDetailPage jobs={mockJobs} repositories={mockRepositories} pulse={null} />,
      "/repositories/repo_test_1",
      (qc) => qc.setQueryData(["review-preparation", "repo_test_1"], preparation(false)),
      "en-US"
    );
    expect(htmlFalse).toMatch(/<button[^>]*disabled=""[^>]*>.*?Start Review<\/button>/);

    // 3. Can start
    const htmlTrue = renderWithProviders(
      <RepositoryDetailPage jobs={mockJobs} repositories={mockRepositories} pulse={null} />,
      "/repositories/repo_test_1",
      (qc) => qc.setQueryData(["review-preparation", "repo_test_1"], preparation(true)),
      "en-US"
    );
    expect(htmlTrue).not.toMatch(/<button[^>]*disabled=""[^>]*>.*?Start Review<\/button>/);
  });

  it("AC-UX-REPO-20: calculates dialog initialization edges purely", () => {
    expect(calculateDialogTransition(false, true)).toEqual({ shouldInitialize: true, nextWasOpen: true });
    expect(calculateDialogTransition(true, true)).toEqual({ shouldInitialize: false, nextWasOpen: true });
    expect(calculateDialogTransition(true, false)).toEqual({ shouldInitialize: false, nextWasOpen: false });
    expect(calculateDialogTransition(false, true)).toEqual({ shouldInitialize: true, nextWasOpen: true });
  });

  it("requests PR history only for the active tab with cancellation and no polling", async () => {
    const fetchPullRequests = vi.fn(async () => ({
      repositoryId: "repo_test_1",
      repositoryFullName: "sk1ua/ConsistenCy",
      available: true as const,
      page: { limit: 100 as const, truncated: false },
      pullRequests: []
    }));
    const inactive = createRepositoryPullRequestsQueryOptions("repo_test_1", "overview", fetchPullRequests);
    const active = createRepositoryPullRequestsQueryOptions("repo_test_1", "pull-requests", fetchPullRequests);
    expect(inactive.enabled).toBe(false);
    expect(active.enabled).toBe(true);
    expect(active.queryKey).toEqual(["workspace", "repositories", "repo_test_1", "pull-requests"]);
    expect(active).not.toHaveProperty("refetchInterval");
    const controller = new AbortController();
    await active.queryFn({ signal: controller.signal });
    expect(fetchPullRequests).toHaveBeenCalledWith("repo_test_1", controller.signal);
  });

  it("AC-UX-REPO-22: strictly requires exact repository ID and rejects display/remote aliases", () => {
    const htmlId = renderWithProviders(
      <RepositoryDetailPage jobs={mockJobs} repositories={mockRepositories} pulse={null} />,
      "/repositories/repo_test_1",
      undefined,
      "en-US"
    );
    expect(htmlId).toContain("ConsistenCy");

    const htmlAlias1 = renderWithProviders(
      <RepositoryDetailPage jobs={mockJobs} repositories={mockRepositories} pulse={null} />,
      "/repositories/ConsistenCy",
      undefined,
      "en-US"
    );
    expect(htmlAlias1).not.toContain("Local Git");
    expect(htmlAlias1).toContain("Repository unavailable");

    const htmlAlias2 = renderWithProviders(
      <RepositoryDetailPage jobs={mockJobs} repositories={mockRepositories} pulse={null} />,
      "/repositories/sk1ua%2FConsistenCy",
      undefined,
      "en-US"
    );
    expect(htmlAlias2).not.toContain("Local Git");
    expect(htmlAlias2).toContain("Repository unavailable");
  });

});
