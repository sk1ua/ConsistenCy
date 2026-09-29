import { describe, expect, it, vi } from "vitest";
import { GitHubApiError, GitHubProviderPayloadError, type PullRequestListClient, type PullRequestListItem } from "./client";
import { normalizeGitHubFullName, RepositoryPullRequestService } from "./pullRequestReader";
import type { ReviewJob } from "../jobQueue";

const providerPullRequests: readonly PullRequestListItem[] = [{
  number: 42,
  title: "Provider pull request",
  state: "closed",
  draft: true,
  labels: [{ name: "security", color: "d73a4a" }],
  author: "octocat",
  baseRef: "main",
  headRef: "feature/provider-summary",
  baseSha: "base-123",
  headSha: "head-456",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  closedAt: "2026-08-03T00:00:00.000Z",
  mergedAt: "2026-08-03T00:00:00.000Z",
  htmlUrl: "https://github.com/Octo/Repository/pull/42"
}];

function clientFor(items = providerPullRequests, truncated = false): PullRequestListClient {
  return { listPullRequests: async () => ({ items, truncated }) };
}

function job(input: Partial<ReviewJob> & Pick<ReviewJob, "id" | "createdAt">): ReviewJob {
  return {
    kind: "pull_request",
    status: "succeeded",
    repository: "legacy/display-name",
    accessMode: "public_read",
    publicationPolicy: "disabled",
    pullRequestNumber: 42,
    updatedAt: input.createdAt,
    ...input
  };
}

function jobStore(rows: ReviewJob[] = []) {
  return {
    listLatestPullRequestJobsForRepository: vi.fn((repositoryId: string, pullRequestNumbers: readonly number[]) => {
      const requested = new Set(pullRequestNumbers);
      const latest = new Map<number, ReviewJob>();
      for (const row of rows) {
        if (row.repositoryId !== repositoryId || row.kind !== "pull_request" || row.pullRequestNumber === undefined || !requested.has(row.pullRequestNumber)) continue;
        const current = latest.get(row.pullRequestNumber);
        if (current === undefined || row.createdAt > current.createdAt || (row.createdAt === current.createdAt && row.updatedAt > current.updatedAt)) {
          latest.set(row.pullRequestNumber, row);
        }
      }
      return Array.from(latest.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    })
  };
}

describe("RepositoryPullRequestService", () => {
  it("strictly normalizes GitHub identities", () => {
    expect(normalizeGitHubFullName("acme-org/repo.name")).toMatchObject({ normalizedFullName: "acme-org/repo.name" });
    expect(normalizeGitHubFullName(" acme/repo")).toBeUndefined();
    expect(normalizeGitHubFullName("acme/rep\u0000o")).toBeUndefined();
  });

  it("returns bounded metadata and canonically associates latest reviews by repositoryId and PR number", async () => {
    const rows = [
      job({ id: "older", repositoryId: "repository-1", createdAt: "2026-08-03T01:00:00.000Z" }),
      job({ id: "newest", repositoryId: "repository-1", createdAt: "2026-08-03T02:00:00.000Z", status: "failed" }),
      job({ id: "different-pr", repositoryId: "repository-1", pullRequestNumber: 99, createdAt: "2026-08-04T00:00:00.000Z" }),
      job({ id: "legacy", repositoryId: undefined, repository: "Octo/Repository", createdAt: "2026-08-05T00:00:00.000Z" })
    ];
    const jobs = jobStore(rows);
    const service = new RepositoryPullRequestService({
      jobs,
      listRemotes: async () => [],
      readerFactory: () => clientFor(providerPullRequests, true)
    });

    const response = await service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" });

    expect(response).toMatchObject({
      repositoryId: "repository-1",
      repositoryFullName: "Octo/Repository",
      available: true,
      page: { limit: 100, truncated: true },
      pullRequests: [{
        number: 42,
        draft: true,
        labels: [{ name: "security", color: "d73a4a" }],
        closedAt: "2026-08-03T00:00:00.000Z",
        latestReview: { jobId: "newest", status: "failed" }
      }]
    });
    expect(jobs.listLatestPullRequestJobsForRepository).toHaveBeenCalledWith("repository-1", [42]);
    expect(jobs.listLatestPullRequestJobsForRepository).toHaveBeenCalledTimes(1);
  });

  it("keeps an older PR latest review visible after more than 200 newer jobs for another PR", async () => {
    const rows = [
      job({ id: "pr-1-review", repositoryId: "repository-1", pullRequestNumber: 1, createdAt: "2026-08-01T00:00:00.000Z" }),
      ...Array.from({ length: 201 }, (_, index) => job({
        id: `pr-2-review-${index}`,
        repositoryId: "repository-1",
        pullRequestNumber: 2,
        createdAt: new Date(Date.parse("2026-08-02T00:00:00.000Z") + index * 1_000).toISOString()
      }))
    ];
    const jobs = jobStore(rows);
    const pullRequests = [1, 2].map(number => ({
      ...providerPullRequests[0]!,
      number,
      htmlUrl: `https://github.com/Octo/Repository/pull/${number}`
    }));
    const service = new RepositoryPullRequestService({ jobs, listRemotes: async () => [], readerFactory: () => clientFor(pullRequests) });

    const response = await service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" });

    expect(response.available && response.pullRequests.map(pullRequest => pullRequest.latestReview?.jobId))
      .toEqual(["pr-1-review", "pr-2-review-200"]);
    expect(jobs.listLatestPullRequestJobsForRepository).toHaveBeenCalledWith("repository-1", [1, 2]);
  });

  it("does not query latest reviews when the provider returns no pull requests", async () => {
    const jobs = jobStore();
    const service = new RepositoryPullRequestService({ jobs, listRemotes: async () => [], readerFactory: () => clientFor([]) });
    await expect(service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" }))
      .resolves.toMatchObject({ available: true, pullRequests: [] });
    expect(jobs.listLatestPullRequestJobsForRepository).not.toHaveBeenCalled();
  });

  it("provider rename does not affect canonical latest-review association", async () => {
    const jobs = jobStore([job({ id: "review", repositoryId: "repository-1", repository: "old/name", createdAt: "2026-08-03T00:00:00.000Z" })]);
    const service = new RepositoryPullRequestService({ jobs, listRemotes: async () => [], readerFactory: () => clientFor() });
    const response = await service.list({ repositoryId: "repository-1", registeredRemoteFullName: "New/Name" });
    expect(response.available && response.pullRequests[0]?.latestReview?.jobId).toBe("review");
  });

  it("keeps different repository IDs and legacy jobs unassociated when store lookup is canonical", async () => {
    const jobs = jobStore([]);
    const service = new RepositoryPullRequestService({ jobs, listRemotes: async () => [], readerFactory: () => clientFor() });
    const response = await service.list({ repositoryId: "repository-2", registeredRemoteFullName: "Octo/Repository" });
    expect(response.available && response.pullRequests[0]?.latestReview).toBeUndefined();
    expect(jobs.listLatestPullRequestJobsForRepository).toHaveBeenCalledWith("repository-2", [42]);
  });

  it("uses App then configured PAT then anonymous and sanitizes the final typed failure", async () => {
    const tokens: Array<string | undefined> = [];
    const service = new RepositoryPullRequestService({
      jobs: jobStore(),
      listRemotes: async () => [],
      publicReadToken: "configured-read-token",
      authenticator: {
        getRepositoryInstallationId: async () => 123,
        getInstallationToken: async () => ({ token: "app-installation-token" })
      },
      readerFactory: token => {
        tokens.push(token);
        return { listPullRequests: async () => { throw new GitHubApiError("sensitive provider detail", 403); } };
      }
    });
    const response = await service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" });
    expect(tokens).toEqual(["app-installation-token", "configured-read-token", undefined]);
    expect(response).toEqual({
      repositoryId: "repository-1",
      available: false,
      reasonCode: "access_denied",
      reason: "GitHub access denied",
      pullRequests: []
    });
  });

  it("does not retry malformed provider data with another credential", async () => {
    const tokens: Array<string | undefined> = [];
    const service = new RepositoryPullRequestService({
      jobs: jobStore(),
      listRemotes: async () => [],
      publicReadToken: "configured-read-token",
      authenticator: {
        getRepositoryInstallationId: async () => 123,
        getInstallationToken: async () => ({ token: "app-installation-token" })
      },
      readerFactory: token => {
        tokens.push(token);
        return { listPullRequests: async () => { throw new GitHubProviderPayloadError(); } };
      }
    });
    await expect(service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" })).resolves.toEqual({
      repositoryId: "repository-1",
      available: false,
      reasonCode: "invalid_provider_data",
      reason: "GitHub returned invalid pull request data",
      pullRequests: []
    });
    expect(tokens).toEqual(["app-installation-token"]);
  });

  it.each([
    [new GitHubApiError("missing", 404), "not_found"],
    [new GitHubApiError("limited", 429), "rate_limited"],
    [new GitHubApiError("limited", 403, undefined, undefined, "0"), "rate_limited"],
    [new GitHubApiError("limited", 403, undefined, "60", "50"), "rate_limited"],
    [new GitHubApiError("limited", 403, undefined, "Sun, 06 Nov 1994 08:49:37 GMT", "50"), "rate_limited"],
    [new GitHubApiError("denied", 403, undefined, "12/31/2026", "50"), "access_denied"],
    [new GitHubApiError("denied", 403, undefined, "2026-12-31T00:00:00Z", "50"), "access_denied"],
    [new GitHubApiError("denied", 403, undefined, "Sunday, 06-Nov-94 08:49:37 GMT", "50"), "access_denied"],
    [new GitHubApiError("denied", 403, undefined, "Sun Nov  6 08:49:37 1994", "50"), "access_denied"],
    [new GitHubApiError("denied", 403, undefined, "invalid", "50"), "access_denied"],
    [new GitHubApiError("denied", 403, undefined, "-1", "50"), "access_denied"],
    [new GitHubApiError("denied", 403, undefined, "1.5", "50"), "access_denied"],
    [new GitHubApiError("denied", 403, undefined, "Mon, 06 Nov 1994 08:49:37 GMT", "50"), "access_denied"],
    [new GitHubApiError("denied", 403, undefined, "Sun, 31 Feb 1994 08:49:37 GMT", "50"), "access_denied"],
    [new GitHubApiError("offline", 503), "provider_unavailable"]
  ])("maps provider failures to stable reason codes", async (error, reasonCode) => {
    const service = new RepositoryPullRequestService({
      jobs: jobStore(),
      listRemotes: async () => [],
      readerFactory: () => ({ listPullRequests: async () => { throw error; } })
    });
    const response = await service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" });
    expect(response).toMatchObject({ available: false, reasonCode, pullRequests: [] });
  });

  it("distinguishes unsupported providers from missing GitHub identity", async () => {
    const readerFactory = vi.fn(() => clientFor());
    const service = new RepositoryPullRequestService({ jobs: jobStore(), listRemotes: async () => [], readerFactory });
    await expect(service.list({ repositoryId: "r1", registeredSource: "gitlab" })).resolves.toMatchObject({ available: false, reasonCode: "not_github" });
    await expect(service.list({ repositoryId: "r2", registeredSource: "local_git" })).resolves.toMatchObject({ available: false, reasonCode: "identity_unavailable" });
    expect(readerFactory).not.toHaveBeenCalled();
  });

  it("fails closed if a custom reader violates the 100-row service bound", async () => {
    const items = Array.from({ length: 101 }, (_, index) => ({
      ...providerPullRequests[0]!, number: index + 1, htmlUrl: `https://github.com/Octo/Repository/pull/${index + 1}`
    }));
    const service = new RepositoryPullRequestService({ jobs: jobStore(), listRemotes: async () => [], readerFactory: () => clientFor(items) });
    await expect(service.list({ repositoryId: "r1", registeredRemoteFullName: "Octo/Repository" })).resolves.toMatchObject({
      available: false,
      reasonCode: "invalid_provider_data"
    });
  });
});
