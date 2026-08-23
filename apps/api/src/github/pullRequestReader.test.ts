import { describe, expect, it, vi } from "vitest";
import {
  GitHubApiError,
  GitHubProviderPayloadError,
  type PullRequestListClient,
  type PullRequestListItem
} from "./client";
import { RepositoryPullRequestService } from "./pullRequestReader";
import type { ReviewJob } from "../jobQueue";

const providerPullRequests: readonly PullRequestListItem[] = [
  {
    number: 42,
    title: "Merged provider pull request",
    state: "closed",
    author: "octocat",
    baseRef: "main",
    headRef: "feature/provider-summary",
    baseSha: "base-123",
    headSha: "head-456",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    mergedAt: "2026-08-03T00:00:00.000Z",
    htmlUrl: "https://github.com/Octo/Repository/pull/42"
  },
  {
    number: 43,
    title: "Open provider pull request",
    state: "open",
    author: null,
    baseRef: "main",
    headRef: "feature/unmerged",
    baseSha: "base-789",
    headSha: "head-012",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    mergedAt: null,
    htmlUrl: "https://github.com/Octo/Repository/pull/43"
  }
];

function pullRequestJob(input: {
  readonly id: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly createdAt: string;
  readonly status: ReviewJob["status"];
}): ReviewJob {
  return {
    id: input.id,
    kind: "pull_request",
    status: input.status,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    accessMode: "github_app",
    publicationPolicy: "github_comment",
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}

function clientFor(pullRequests: readonly PullRequestListItem[]): PullRequestListClient {
  return { listPullRequests: async () => pullRequests };
}

describe("RepositoryPullRequestService", () => {
  it("accepts normalized client items, preserves provider state, and indexes the newest exact reviews once", async () => {
    const jobs = vi.fn(() => [
      pullRequestJob({ id: "older", repository: "octo/repository", pullRequestNumber: 42, createdAt: "2026-08-03T01:00:00.000Z", status: "succeeded" }),
      pullRequestJob({ id: "newest", repository: "OCTO/REPOSITORY", pullRequestNumber: 42, createdAt: "2026-08-03T02:00:00.000Z", status: "failed" }),
      pullRequestJob({ id: "second-pr", repository: "octo/repository", pullRequestNumber: 43, createdAt: "2026-08-05T01:00:00.000Z", status: "succeeded" }),
      pullRequestJob({ id: "different-pr", repository: "octo/repository", pullRequestNumber: 44, createdAt: "2026-08-06T00:00:00.000Z", status: "succeeded" }),
      pullRequestJob({ id: "different-repository", repository: "octo/other", pullRequestNumber: 42, createdAt: "2026-08-06T00:00:00.000Z", status: "succeeded" })
    ]);
    const service = new RepositoryPullRequestService({
      jobs: { list: jobs },
      listRemotes: vi.fn(async () => []),
      readerFactory: () => clientFor(providerPullRequests)
    });

    const response = await service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" });

    expect(response).toEqual({
      repositoryId: "repository-1",
      available: true,
      pullRequests: [
        {
          provider: "github",
          number: 42,
          title: "Merged provider pull request",
          state: "closed",
          author: "octocat",
          baseRef: "main",
          headRef: "feature/provider-summary",
          baseSha: "base-123",
          headSha: "head-456",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
          mergedAt: "2026-08-03T00:00:00.000Z",
          htmlUrl: "https://github.com/Octo/Repository/pull/42",
          latestReview: {
            jobId: "newest",
            status: "failed",
            createdAt: "2026-08-03T02:00:00.000Z"
          }
        },
        {
          provider: "github",
          number: 43,
          title: "Open provider pull request",
          state: "open",
          author: null,
          baseRef: "main",
          headRef: "feature/unmerged",
          baseSha: "base-789",
          headSha: "head-012",
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
          mergedAt: null,
          htmlUrl: "https://github.com/Octo/Repository/pull/43",
          latestReview: {
            jobId: "second-pr",
            status: "succeeded",
            createdAt: "2026-08-05T01:00:00.000Z"
          }
        }
      ]
    });
    expect(jobs).toHaveBeenCalledTimes(1);
  });

  it("falls back from an unavailable app installation to the configured read token", async () => {
    const tokens: Array<string | undefined> = [];
    const service = new RepositoryPullRequestService({
      jobs: { list: () => [] },
      listRemotes: async () => [],
      publicReadToken: "configured-read-token",
      authenticator: {
        getRepositoryInstallationId: async () => { throw new GitHubApiError("app installation missing", 404); },
        getInstallationToken: async () => ({ token: "installation-token" })
      },
      readerFactory: token => {
        tokens.push(token);
        return clientFor(providerPullRequests);
      }
    });

    const response = await service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" });

    expect(response.available).toBe(true);
    expect(tokens).toEqual(["configured-read-token"]);
  });

  it("continues from an app reader access failure to a successful read-token reader", async () => {
    const tokens: Array<string | undefined> = [];
    const service = new RepositoryPullRequestService({
      jobs: { list: () => [] },
      listRemotes: async () => [],
      publicReadToken: "configured-read-token",
      authenticator: {
        getRepositoryInstallationId: async () => 123,
        getInstallationToken: async () => ({ token: "app-installation-token" })
      },
      readerFactory: token => {
        tokens.push(token);
        return {
          listPullRequests: async () => {
            if (token === "app-installation-token") throw new GitHubApiError("app-token-private", 403);
            return providerPullRequests;
          }
        };
      }
    });

    const response = await service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" });

    expect(response.available).toBe(true);
    expect(tokens).toEqual(["app-installation-token", "configured-read-token"]);
  });

  it("continues from a read-token access failure to anonymous access", async () => {
    const tokens: Array<string | undefined> = [];
    const service = new RepositoryPullRequestService({
      jobs: { list: () => [] },
      listRemotes: async () => [],
      publicReadToken: "configured-read-token",
      readerFactory: token => {
        tokens.push(token);
        return {
          listPullRequests: async () => {
            if (token === "configured-read-token") throw new GitHubApiError("read-token-private", 401);
            return providerPullRequests;
          }
        };
      }
    });

    const response = await service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" });

    expect(response.available).toBe(true);
    expect(tokens).toEqual(["configured-read-token", undefined]);
  });

  it("tries app, read-token, and anonymous access once before returning the final sanitized failure", async () => {
    const tokens: Array<string | undefined> = [];
    const service = new RepositoryPullRequestService({
      jobs: { list: () => [] },
      listRemotes: async () => [],
      publicReadToken: "configured-read-token",
      authenticator: {
        getRepositoryInstallationId: async () => 123,
        getInstallationToken: async () => ({ token: "app-installation-token" })
      },
      readerFactory: token => {
        tokens.push(token);
        return {
          listPullRequests: async () => { throw new GitHubApiError(`credential=${token ?? "anonymous"}`, 403); }
        };
      }
    });

    const response = await service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" });

    expect(response).toEqual({
      repositoryId: "repository-1",
      available: false,
      reason: "GitHub access denied",
      pullRequests: []
    });
    expect(tokens).toEqual(["app-installation-token", "configured-read-token", undefined]);
  });

  it("deduplicates identical app and configured read credentials before anonymous fallback", async () => {
    const tokens: Array<string | undefined> = [];
    const service = new RepositoryPullRequestService({
      jobs: { list: () => [] },
      listRemotes: async () => [],
      publicReadToken: "shared-token",
      authenticator: {
        getRepositoryInstallationId: async () => 123,
        getInstallationToken: async () => ({ token: "shared-token" })
      },
      readerFactory: token => {
        tokens.push(token);
        return {
          listPullRequests: async () => {
            if (token === "shared-token") throw new GitHubApiError("shared-token-denied", 403);
            return providerPullRequests;
          }
        };
      }
    });

    const response = await service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" });

    expect(response.available).toBe(true);
    expect(tokens).toEqual(["shared-token", undefined]);
  });

  it("does not retry a typed provider payload error with another credential", async () => {
    const tokens: Array<string | undefined> = [];
    const service = new RepositoryPullRequestService({
      jobs: { list: () => [] },
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

    const response = await service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" });

    expect(response).toEqual({
      repositoryId: "repository-1",
      available: false,
      reason: "GitHub returned invalid pull request data",
      pullRequests: []
    });
    expect(tokens).toEqual(["app-installation-token"]);
  });

  it("resolves a local identity from origin before another recognized GitHub remote", async () => {
    const identities: string[] = [];
    const service = new RepositoryPullRequestService({
      jobs: { list: () => [] },
      listRemotes: async () => [
        { name: "upstream", githubFullName: "other/repository" },
        { name: "origin", githubFullName: "Octo/Repository" }
      ],
      readerFactory: () => ({
        listPullRequests: async identity => {
          identities.push(`${identity.owner.toLowerCase()}/${identity.repo.toLowerCase()}`);
          return providerPullRequests;
        }
      })
    });

    const response = await service.list({ repositoryId: "repository-1", localPath: "safe-local-reference" });

    expect(response.available).toBe(true);
    expect(identities).toEqual(["octo/repository"]);
  });

  it("reports an explicitly unsupported registered provider without querying GitHub", async () => {
    const reader = vi.fn(() => clientFor(providerPullRequests));
    const service = new RepositoryPullRequestService({
      jobs: { list: () => [] },
      listRemotes: async () => [],
      readerFactory: reader
    });

    const response = await service.list({
      repositoryId: "repository-1",
      registeredSource: "gitlab",
      registeredRemoteFullName: "group/repository"
    });

    expect(response).toEqual({
      repositoryId: "repository-1",
      available: false,
      reason: "repository provider is not GitHub",
      pullRequests: []
    });
    expect(reader).not.toHaveBeenCalled();
  });

  it("returns a sanitized unavailable response for denied provider access", async () => {
    const service = new RepositoryPullRequestService({
      jobs: { list: () => [] },
      listRemotes: async () => [],
      readerFactory: () => ({
        listPullRequests: async () => { throw new GitHubApiError("token=private-value", 403); }
      })
    });

    const response = await service.list({ repositoryId: "repository-1", registeredRemoteFullName: "Octo/Repository" });

    expect(response).toEqual({
      repositoryId: "repository-1",
      available: false,
      reason: "GitHub access denied",
      pullRequests: []
    });
  });
});
