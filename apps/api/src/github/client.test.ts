import { describe, expect, it } from "vitest";
import {
  GitHubApiError,
  GitHubProviderPayloadError,
  OctokitPullRequestClient,
  type OctokitPullRequestListRequest,
  type OctokitPullRequestPaginator
} from "./client";

describe("OctokitPullRequestClient", () => {
  it("normalizes realistic pull request payloads without changing provider state", async () => {
    const paginator: OctokitPullRequestPaginator = {
      paginatePullRequests: async () => [{
        number: 42,
        title: "Keep provider state authoritative",
        state: "closed",
        user: { login: "octocat", id: 1, avatar_url: "https://avatars.githubusercontent.com/u/1" },
        base: { ref: "main", sha: "base-sha", repository: { id: 12 } },
        head: { ref: "feature/listing", sha: "head-sha", label: "octocat:feature/listing" },
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-02T00:00:00.000Z",
        merged_at: "2026-08-03T00:00:00.000Z",
        html_url: "https://github.com/octo/repository/pull/42",
        draft: false,
        requested_reviewers: []
      }]
    };
    const client = new OctokitPullRequestClient("unused-test-token", paginator);

    const pullRequests = await client.listPullRequests({ owner: "octo", repo: "repository" });

    expect(pullRequests).toEqual([{
      number: 42,
      title: "Keep provider state authoritative",
      state: "closed",
      author: "octocat",
      baseRef: "main",
      headRef: "feature/listing",
      baseSha: "base-sha",
      headSha: "head-sha",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      mergedAt: "2026-08-03T00:00:00.000Z",
      htmlUrl: "https://github.com/octo/repository/pull/42"
    }]);
  });

  it("retains a nullable provider merge timestamp", async () => {
    const paginator: OctokitPullRequestPaginator = {
      paginatePullRequests: async () => [{
        number: 43,
        title: "Unmerged pull request",
        state: "open",
        user: null,
        base: { ref: "main", sha: "base-sha" },
        head: { ref: "feature/unmerged", sha: "head-sha" },
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-02T00:00:00.000Z",
        merged_at: null,
        html_url: "https://github.com/octo/repository/pull/43"
      }]
    };
    const client = new OctokitPullRequestClient(undefined, paginator);

    const [pullRequest] = await client.listPullRequests({ owner: "octo", repo: "repository" });

    expect(pullRequest).toMatchObject({ author: null, state: "open", mergedAt: null });
  });

  it("paginates every pull request with the all state and a page size of 100", async () => {
    const requests: OctokitPullRequestListRequest[] = [];
    const paginator: OctokitPullRequestPaginator = {
      paginatePullRequests: async request => {
        requests.push(request);
        return [];
      }
    };
    const client = new OctokitPullRequestClient(undefined, paginator);

    await client.listPullRequests({ owner: "octo", repo: "repository" });

    expect(requests).toEqual([{ owner: "octo", repo: "repository", state: "all", per_page: 100 }]);
  });

  it("raises a provider payload error when a required pull request field is malformed", async () => {
    const paginator: OctokitPullRequestPaginator = {
      paginatePullRequests: async () => [{
        number: "not-a-number",
        title: "Malformed provider object",
        state: "open",
        user: null,
        base: { ref: "main", sha: "base-sha" },
        head: { ref: "feature/listing", sha: "head-sha" },
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-02T00:00:00.000Z",
        merged_at: null,
        html_url: "https://github.com/octo/repository/pull/42"
      }]
    };
    const client = new OctokitPullRequestClient(undefined, paginator);

    await expect(client.listPullRequests({ owner: "octo", repo: "repository" })).rejects.toBeInstanceOf(GitHubProviderPayloadError);
  });

  it("translates paginator request failures into GitHub API errors", async () => {
    const paginator: OctokitPullRequestPaginator = {
      paginatePullRequests: async () => {
        throw {
          response: {
            status: 429,
            headers: { "retry-after": "30", "x-ratelimit-remaining": "0" }
          }
        };
      }
    };
    const client = new OctokitPullRequestClient(undefined, paginator);

    await expect(client.listPullRequests({ owner: "octo", repo: "repository" })).rejects.toMatchObject(
      new GitHubApiError("GitHub request failed with status 429", 429, undefined, "30", "0")
    );
  });
});
