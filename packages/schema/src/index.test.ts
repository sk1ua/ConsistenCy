import { describe, expect, it } from "vitest";
import {
  agentRunSchema,
  errorResponseSchema,
  gitRemoteInfoSchema,
  localReviewRequestSchema,
  prReviewContextSchema,
  repositoryCommitsResponseSchema,
  repositoryPullRequestsResponseSchema,
  repositoryReviewsResponseSchema,
  reviewFindingSchema,
  reviewPlanSchema,
  reviewReportSchema,
  riskLevelForScore
} from "./index";

const sampleReport = {
  jobId: "job-sample-1",
  repositoryFullName: "sk1ua/ConsistenCy",
  pullRequestNumber: 34,
  baseSha: "8b3fabb",
  headSha: "2894e50",
  summary: "Sample review report.",
  score: 74,
  riskLevel: "medium" as const,
  agentRuns: [
    {
      id: "run-security-1",
      jobId: "job-sample-1",
      agentName: "Security",
      status: "succeeded" as const,
      startedAt: "2026-06-10T15:00:00.000Z",
      finishedAt: "2026-06-10T15:00:01.000Z",
      inputSummary: "Reviewed API changes.",
      findings: [
        {
          id: "finding-1",
          agent: "Security",
          title: "API auth check",
          severity: "medium" as const,
          confidence: "hypothesis" as const,
          file: "apps/api/src/http.ts",
          evidence: "No guard in excerpt.",
          reasoning: "Management routes need token.",
          recommendation: "Add bearer token.",
          uncertainty: "Proxy config not visible.",
          tags: ["api", "auth"]
        }
      ]
    }
  ],
  findings: [
    {
      id: "finding-1",
      agent: "Security",
      title: "API auth check",
      severity: "medium" as const,
      confidence: "hypothesis" as const,
      file: "apps/api/src/http.ts",
      evidence: "No guard in excerpt.",
      reasoning: "Management routes need token.",
      recommendation: "Add bearer token.",
      uncertainty: "Proxy config not visible.",
      tags: ["api", "auth"]
    }
  ],
  createdAt: "2026-06-10T15:00:02.000Z"
};

const findingBase = {
  id: "finding-1",
  agent: "Security",
  title: "Unsafe API exposure",
  severity: "high",
  file: "apps/api/src/http.ts",
  evidence: "The route is registered without an authorization guard.",
  reasoning: "Untrusted clients may invoke management operations.",
  recommendation: "Require a bearer token for management routes."
} as const;

describe("@consistency/schema", () => {
  it("enforces evidence requirements for confirmed findings", () => {
    const confirmed = reviewFindingSchema.parse({
      ...findingBase,
      confidence: "confirmed",
      startLine: 94,
      endLine: 100
    });
    expect(confirmed.confidence).toBe("confirmed");
    expect(() => reviewFindingSchema.parse({ ...findingBase, confidence: "confirmed" })).toThrow();
    expect(() => reviewFindingSchema.parse({
      ...findingBase,
      confidence: "confirmed",
      startLine: 100,
      endLine: 94
    })).toThrow();
  });

  it("requires explicit uncertainty for hypotheses", () => {
    const hypothesis = reviewFindingSchema.parse({
      ...findingBase,
      confidence: "hypothesis",
      uncertainty: "Deployment-level authentication was not visible."
    });
    expect(hypothesis.startLine).toBeUndefined();
    expect(() => reviewFindingSchema.parse({ ...findingBase, confidence: "hypothesis" })).toThrow();
  });

  it("parses plans, agent runs, reports, and API errors", () => {
    expect(reviewPlanSchema.parse({
      enabledAgents: ["Security", "Correctness"],
      skippedAgents: ["Style"],
      riskAreas: ["webhook"],
      reason: "The PR changes request handling."
    }).enabledAgents).toHaveLength(2);
    expect(agentRunSchema.parse(sampleReport.agentRuns[0]).status).toBe("succeeded");
    expect(reviewReportSchema.parse(sampleReport).score).toBe(74);
    expect(errorResponseSchema.parse({ error: { code: "NOT_FOUND", message: "Missing" } }).error.code).toBe("NOT_FOUND");
  });

  it("requires exclusive repository commit availability states", () => {
    const commit = {
      sha: "a".repeat(40),
      parentShas: [],
      author: { name: "Test Runner" },
      authoredAt: "2026-08-22T00:00:00.000Z",
      message: "initial commit"
    };

    expect(repositoryCommitsResponseSchema.parse({
      repositoryId: "repository-1",
      available: true,
      commits: [commit]
    }).available).toBe(true);
    expect(() => repositoryCommitsResponseSchema.parse({
      repositoryId: "repository-1",
      available: true,
      reason: "must not accompany available history",
      commits: []
    })).toThrow();
    expect(() => repositoryCommitsResponseSchema.parse({
      repositoryId: "repository-1",
      available: false,
      commits: []
    })).toThrow();
    expect(() => repositoryCommitsResponseSchema.parse({
      repositoryId: "repository-1",
      available: false,
      reason: "history unavailable",
      commits: [commit]
    })).toThrow();
  });

  it("strictly bounds repository reviews and requires exact opaque association", () => {
    const review = {
      id: "job-review-1",
      type: "PR_REVIEW" as const,
      status: "succeeded" as const,
      repositoryFullName: "shared/display-name",
      repositoryId: "repository-1",
      accessMode: "local_git" as const,
      baseSha: "base-123",
      headSha: "head-456",
      publicationPolicy: "disabled" as const,
      createdAt: "2026-08-24T00:00:00.000Z"
    };

    expect(repositoryReviewsResponseSchema.parse({
      repositoryId: "repository-1",
      reviews: [review]
    }).reviews).toHaveLength(1);
    expect(() => repositoryReviewsResponseSchema.parse({
      repositoryId: "repository-1",
      reviews: [{ ...review, repositoryId: "repository-2" }]
    })).toThrow();
    expect(() => repositoryReviewsResponseSchema.parse({
      repositoryId: "repository-1",
      reviews: [{ ...review, repositoryId: undefined }]
    })).toThrow();
    expect(() => repositoryReviewsResponseSchema.parse({
      repositoryId: "repository-1",
      reviews: [],
      unexpected: true
    })).toThrow();
    expect(() => repositoryReviewsResponseSchema.parse({
      repositoryId: "repository-1",
      reviews: Array.from({ length: 201 }, (_, index) => ({
        ...review,
        id: `job-review-${index + 1}`
      }))
    })).toThrow();
  });

  it("requires provider-owned pull request rows and exclusive availability states", () => {
    const pullRequest = {
      provider: "github",
      number: 42,
      title: "Provider title",
      state: "open",
      draft: false,
      labels: [],
      author: null,
      baseRef: "main",
      headRef: "feature/provider",
      baseSha: "base-123",
      headSha: "head-456",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      closedAt: null,
      mergedAt: null,
      htmlUrl: "https://github.com/octo/repository/pull/42"
    };

    expect(repositoryPullRequestsResponseSchema.parse({
      repositoryId: "repository-1",
      repositoryFullName: "octo/repository",
      available: true,
      page: { limit: 100, truncated: false },
      pullRequests: [pullRequest]
    }).available).toBe(true);
    expect(() => repositoryPullRequestsResponseSchema.parse({
      repositoryId: "repository-1",
      available: false,
      pullRequests: []
    })).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse({
      repositoryId: "repository-1",
      available: false,
      reasonCode: "provider_unavailable",
      reason: "provider unavailable",
      pullRequests: [pullRequest]
    })).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse({
      repositoryId: "repository-1",
      repositoryFullName: "octo/repository",
      available: true,
      page: { limit: 100, truncated: false },
      pullRequests: [{
        number: pullRequest.number,
        title: pullRequest.title,
        state: pullRequest.state,
        author: pullRequest.author,
        baseRef: pullRequest.baseRef,
        headRef: pullRequest.headRef,
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
        createdAt: pullRequest.createdAt,
        updatedAt: pullRequest.updatedAt,
        htmlUrl: pullRequest.htmlUrl
      }]
    })).toThrow();
  });

  it("accepts provider pull request lifecycle rows with explicit merge timestamps", () => {
    const pullRequest = {
      provider: "github",
      number: 42,
      title: "Provider title",
      draft: false,
      labels: [],
      author: null,
      baseRef: "main",
      headRef: "feature/provider",
      baseSha: "base-123",
      headSha: "head-456",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      closedAt: null,
      htmlUrl: "https://github.com/octo/repository/pull/42"
    };

    expect(repositoryPullRequestsResponseSchema.parse({
      repositoryId: "repository-1",
      repositoryFullName: "octo/repository",
      available: true,
      page: { limit: 100, truncated: false },
      pullRequests: [{ ...pullRequest, state: "open", mergedAt: null }]
    }).pullRequests[0]?.mergedAt).toBeNull();
    expect(repositoryPullRequestsResponseSchema.parse({
      repositoryId: "repository-1",
      repositoryFullName: "octo/repository",
      available: true,
      page: { limit: 100, truncated: false },
      pullRequests: [{ ...pullRequest, state: "closed", updatedAt: "2026-08-03T00:00:00.000Z", closedAt: "2026-08-03T00:00:00.000Z", mergedAt: null }]
    }).pullRequests[0]?.mergedAt).toBeNull();
    expect(repositoryPullRequestsResponseSchema.parse({
      repositoryId: "repository-1",
      repositoryFullName: "octo/repository",
      available: true,
      page: { limit: 100, truncated: false },
      pullRequests: [{ ...pullRequest, state: "closed", updatedAt: "2026-08-03T00:00:01.000Z", closedAt: "2026-08-03T00:00:01.000Z", mergedAt: "2026-08-03T00:00:00.000Z" }]
    }).pullRequests[0]?.mergedAt).toBe("2026-08-03T00:00:00.000Z");
  });

  it("rejects synthetic and incomplete provider pull request lifecycle rows", () => {
    const pullRequest = {
      provider: "github",
      number: 42,
      title: "Provider title",
      draft: false,
      labels: [],
      author: null,
      baseRef: "main",
      headRef: "feature/provider",
      baseSha: "base-123",
      headSha: "head-456",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      closedAt: null,
      htmlUrl: "https://github.com/octo/repository/pull/42"
    };

    expect(() => repositoryPullRequestsResponseSchema.parse({
      repositoryId: "repository-1",
      repositoryFullName: "octo/repository",
      available: true,
      page: { limit: 100, truncated: false },
      pullRequests: [{ ...pullRequest, state: "merged", mergedAt: "2026-08-03T00:00:00.000Z" }]
    })).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse({
      repositoryId: "repository-1",
      repositoryFullName: "octo/repository",
      available: true,
      page: { limit: 100, truncated: false },
      pullRequests: [{ ...pullRequest, state: "closed" }]
    })).toThrow();
  });

  it("bounds pull request rows, labels, provider strings, URLs, and unavailable metadata", () => {
    const row = {
      provider: "github" as const,
      number: 1,
      title: "Provider title",
      state: "open" as const,
      draft: true,
      labels: [{ name: "security", color: "d73a4a" }],
      author: "octocat",
      baseRef: "main",
      headRef: "feature/provider",
      baseSha: "base-123",
      headSha: "head-456",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      closedAt: null,
      mergedAt: null,
      htmlUrl: "https://github.com/octo/repository/pull/1"
    };
    const available = (pullRequests: unknown[]) => ({
      repositoryId: "repository-1",
      repositoryFullName: "octo/repository",
      available: true,
      page: { limit: 100, truncated: false },
      pullRequests
    });

    expect(repositoryPullRequestsResponseSchema.parse(available([])).pullRequests).toHaveLength(0);
    expect(repositoryPullRequestsResponseSchema.parse(available(Array.from({ length: 100 }, (_, index) => ({
      ...row,
      number: index + 1,
      htmlUrl: `https://github.com/octo/repository/pull/${index + 1}`
    })))).pullRequests).toHaveLength(100);
    expect(() => repositoryPullRequestsResponseSchema.parse(available(Array.from({ length: 101 }, () => row)))).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse(available([{ ...row, labels: Array.from({ length: 101 }, () => ({ name: "label", color: "fff" })) }]))).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse(available([{ ...row, title: ` ${row.title}` }]))).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse(available([{ ...row, title: "dirty\ntext" }]))).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse(available([{ ...row, title: "x".repeat(1_025) }]))).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse(available([{ ...row, htmlUrl: "https://user@github.com/octo/repository/pull/1" }]))).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse(available([{ ...row, htmlUrl: `${row.htmlUrl}?x=1` }]))).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse(available([{ ...row, htmlUrl: "https://github.com/octo/repository/pull/2" }]))).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse(available([{
      ...row,
      number: 9_007_199_254_740_992,
      htmlUrl: "https://github.com/octo/repository/pull/9007199254740992"
    }]))).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse(available([{
      ...row,
      number: 9_007_199_254_740_993,
      htmlUrl: "https://github.com/octo/repository/pull/9007199254740993"
    }]))).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse({ ...available([row]), repositoryFullName: "octo/other" })).toThrow();
    expect(repositoryPullRequestsResponseSchema.parse({ ...available([row]), repositoryFullName: "OCTO/REPOSITORY" }).available).toBe(true);

    const owner39 = "a".repeat(39);
    const repo100 = `Repo.${"x".repeat(91)}_end`;
    const boundaryRow = {
      ...row,
      htmlUrl: `https://github.com/${owner39}/${repo100}/pull/1`
    };
    expect(repositoryPullRequestsResponseSchema.parse({
      ...available([boundaryRow]),
      repositoryFullName: `${owner39}/${repo100}`
    }).available).toBe(true);
    expect(repositoryPullRequestsResponseSchema.parse({
      ...available([{ ...row, htmlUrl: "https://github.com/Mixed-Owner/repo.name_with-parts/pull/1" }]),
      repositoryFullName: "mIXED-oWNER/REPO.NAME_WITH-PARTS"
    }).available).toBe(true);
    for (const repositoryFullName of [
      "",
      "/repo",
      "owner/",
      "bad-/repo",
      "owner/...",
      `${"a".repeat(40)}/repo`,
      `owner/${"r".repeat(101)}`,
      "owner/repo\n",
      " owner/repo"
    ]) {
      expect(() => repositoryPullRequestsResponseSchema.parse({
        ...available([]),
        repositoryFullName
      })).toThrow();
    }
    for (const htmlUrl of [
      "https://github.com/bad-/repo/pull/1",
      "https://github.com/owner/.../pull/1",
      "https://github.com/owner/./repo/pull/1",
      "https://github.com/owner/segment/../repo/pull/1",
      String.raw`https://github.com/owner\repo/pull/1`,
      String.raw`https://github.com/owner/repo\pull/1`,
      `https://github.com/${"a".repeat(40)}/repo/pull/1`,
      `https://github.com/owner/${"r".repeat(101)}/pull/1`
    ]) {
      expect(() => repositoryPullRequestsResponseSchema.parse(available([{ ...row, htmlUrl }]))).toThrow();
    }

    for (const invalidLifecycle of [
      { ...row, state: "open", closedAt: "2026-08-03T00:00:00.000Z" },
      { ...row, state: "closed", closedAt: null },
      { ...row, updatedAt: "2026-07-31T00:00:00.000Z" },
      { ...row, state: "closed", closedAt: "2026-07-31T00:00:00.000Z" },
      { ...row, state: "closed", closedAt: "2026-08-03T00:00:00.000Z", mergedAt: "2026-07-31T00:00:00.000Z" },
      { ...row, state: "closed", closedAt: "2026-08-03T00:00:00.000Z", mergedAt: "2026-08-04T00:00:00.000Z" },
      { ...row, state: "closed", updatedAt: "2026-08-02T00:00:00.000Z", closedAt: "2026-08-03T00:00:00.000Z", mergedAt: null },
      { ...row, state: "closed", updatedAt: "2026-08-02T00:00:00.000Z", closedAt: "2026-08-04T00:00:00.000Z", mergedAt: "2026-08-03T00:00:00.000Z" }
    ]) expect(() => repositoryPullRequestsResponseSchema.parse(available([invalidLifecycle]))).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse({
      repositoryId: "repository-1",
      available: false,
      reasonCode: "access_denied",
      reason: "GitHub access denied",
      page: { limit: 100, truncated: false },
      pullRequests: []
    })).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse({
      ...available([]),
      reasonCode: "provider_unavailable",
      reason: "unexpected"
    })).toThrow();
    expect(() => repositoryPullRequestsResponseSchema.parse({
      repositoryId: "repository-1",
      repositoryFullName: "octo/repository",
      available: false,
      reasonCode: "provider_unavailable",
      reason: "GitHub unavailable",
      pullRequests: []
    })).toThrow();
    expect(repositoryPullRequestsResponseSchema.parse({
      repositoryId: "repository-1",
      available: false,
      reasonCode: "rate_limited",
      reason: "GitHub rate limit reached",
      pullRequests: []
    }).available).toBe(false);
  });

  it("accepts renderer-safe git remotes and rejects exposed URLs", () => {
    expect(gitRemoteInfoSchema.parse({ name: "origin" }).name).toBe("origin");
    expect(gitRemoteInfoSchema.parse({
      name: "upstream",
      githubFullName: "octo/repository"
    }).githubFullName).toBe("octo/repository");
    expect(() => gitRemoteInfoSchema.parse({
      name: "origin",
      url: "https://github.com/octo/repository.git"
    })).toThrow();
    expect(() => gitRemoteInfoSchema.parse({
      name: "origin",
      url: "https://token@github.com/octo/repository.git"
    })).toThrow();
  });

  it("requires a repository identifier for local reviews and rejects paths", () => {
    expect(localReviewRequestSchema.parse({ repositoryId: "repository-1" }).repositoryId).toBe("repository-1");
    expect(() => localReviewRequestSchema.parse({})).toThrow();
    expect(() => localReviewRequestSchema.parse({ repoPath: "C:/worktree" })).toThrow();
  });

  it("maps quality scores to risk levels", () => {
    expect(riskLevelForScore(39)).toBe("critical");
    expect(riskLevelForScore(40)).toBe("high");
    expect(riskLevelForScore(60)).toBe("medium");
    expect(riskLevelForScore(80)).toBe("low");
  });

  it("parses PR review contexts used by the TypeScript workflow", () => {
    expect(prReviewContextSchema.parse({
      jobId: "job-1",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 34,
      baseSha: "base123",
      headSha: "head456",
      changedFiles: [{
        path: "apps/api/src/http.ts",
        status: "modified",
        additions: 4,
        deletions: 1,
        changes: 5
      }],
      diff: "diff --git a/apps/api/src/http.ts b/apps/api/src/http.ts",
      fileContents: { "apps/api/src/http.ts": "export {};" },
      baseFileContents: { "apps/api/src/http.ts": "" },
      projectMetadata: { "package.json": "{}" },
      workspacePath: "C:/workspace/job-1"
    }).changedFiles).toHaveLength(1);
  });
});
