import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubApiError,
  GitHubProviderPayloadError,
  OctokitPullRequestClient,
  parseRepositoryMetadataPayload,
  type OctokitPullRequestListRequest,
  type OctokitPullRequestLister
} from "./client";

const validPullRequest = {
  number: 42,
  title: "Keep provider state authoritative",
  state: "closed",
  draft: true,
  labels: [{ name: "needs review", color: "d73a4a" }],
  user: { login: "octocat" },
  base: { ref: "main", sha: "base-sha" },
  head: { ref: "feature/listing", sha: "head-sha" },
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-03T00:00:00.000Z",
  closed_at: "2026-08-03T00:00:00.000Z",
  merged_at: "2026-08-03T00:00:00.000Z",
  html_url: "https://github.com/octo/repository/pull/42"
};

function lister(data: unknown, headers?: unknown): OctokitPullRequestLister {
  return { listPullRequests: vi.fn(async () => ({ data, headers })) };
}

describe("OctokitPullRequestClient", () => {
  it("strictly validates unmodified provider repository identity fields", () => {
    const valid = {
      full_name: "acme-org/repo.name_with-parts",
      name: "repo.name_with-parts",
      owner: { login: "acme-org" },
      default_branch: "main",
      private: false
    };
    expect(parseRepositoryMetadataPayload(valid)).toMatchObject({ fullName: valid.full_name, name: valid.name });
    for (const payload of [
      { ...valid, full_name: " acme-org/repo" },
      { ...valid, name: "repo\tname" },
      { ...valid, owner: { login: "acme\norg" } }
    ]) expect(() => parseRepositoryMetadataPayload(payload)).toThrow(GitHubProviderPayloadError);
  });

  it("does not use Octokit pagination at the pull request list seam", () => {
    const source = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
    const listSeam = source.slice(source.indexOf("async listPullRequests"), source.indexOf("async listChangedFiles"));
    expect(listSeam).not.toContain("paginate");
    expect(listSeam).toContain("pullRequestLister.listPullRequests");
  });

  it("calls pulls.list exactly once with the fixed newest-first bound and reports Link next", async () => {
    const requests: OctokitPullRequestListRequest[] = [];
    const listPullRequests = vi.fn(async (request: OctokitPullRequestListRequest) => {
      requests.push(request);
      return {
        data: [validPullRequest],
        headers: { link: '<https://api.github.com/repositories/1/pulls?page=2>; rel="next", <https://api.github.com/repositories/1/pulls?page=4>; rel="last"' }
      };
    });
    const client = new OctokitPullRequestClient(undefined, { listPullRequests });

    const result = await client.listPullRequests({ owner: "octo", repo: "repository" });

    expect(listPullRequests).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([{
      owner: "octo",
      repo: "repository",
      state: "all",
      sort: "created",
      direction: "desc",
      per_page: 100,
      page: 1
    }]);
    expect(result).toEqual({
      truncated: true,
      items: [{
        number: 42,
        title: validPullRequest.title,
        state: "closed",
        draft: true,
        labels: [{ name: "needs review", color: "d73a4a" }],
        author: "octocat",
        baseRef: "main",
        headRef: "feature/listing",
        baseSha: "base-sha",
        headSha: "head-sha",
        createdAt: validPullRequest.created_at,
        updatedAt: validPullRequest.updated_at,
        closedAt: validPullRequest.closed_at,
        mergedAt: validPullRequest.merged_at,
        htmlUrl: validPullRequest.html_url
      }]
    });
  });

  it("accepts canonical owner/repository identity case-insensitively", async () => {
    const client = new OctokitPullRequestClient(undefined, lister([validPullRequest]));
    const result = await client.listPullRequests({ owner: "OCTO", repo: "Repository" });
    expect(result.items[0]?.htmlUrl).toBe(validPullRequest.html_url);

    const mixedCase = {
      ...validPullRequest,
      html_url: "https://github.com/Mixed-Owner/repo.name_with-parts/pull/42"
    };
    const mixedCaseClient = new OctokitPullRequestClient(undefined, lister([mixedCase]));
    await expect(mixedCaseClient.listPullRequests({
      owner: "mIXED-oWNER",
      repo: "REPO.NAME_WITH-PARTS"
    })).resolves.toMatchObject({ items: [{ htmlUrl: mixedCase.html_url }] });

    const owner39 = "a".repeat(39);
    const repo100 = `Repo.${"x".repeat(91)}_end`;
    const boundary = {
      ...validPullRequest,
      html_url: `https://github.com/${owner39}/${repo100}/pull/42`
    };
    const boundaryClient = new OctokitPullRequestClient(undefined, lister([boundary]));
    await expect(boundaryClient.listPullRequests({ owner: owner39, repo: repo100 }))
      .resolves.toMatchObject({ items: [{ htmlUrl: boundary.html_url }] });
  });

  it.each([
    ['<https://api.github.com/pulls?page=2>; type="application/json"; rel="next"', true],
    ['<https://api.github.com/pulls?page=2>; REL=next; type="application/json"', true],
    ['<https://api.github.com/pulls?page=2>; rel="prev next"', true],
    ['<https://api.github.com/pulls?page=2>; rel="NEXT"', true],
    ['<https://api.github.com/pulls?page=1>; rel="prev", <https://api.github.com/pulls?page=2>; title="older, rows"; rel=next', true],
    [String.raw`<https://api.github.com/pulls?page=1>; title="ends with \\"; rel=prev, <https://api.github.com/pulls?page=2>; rel=next`, true],
    [String.raw`<https://api.github.com/pulls?page=1>; title="escaped quote \" and comma, still title"; rel=prev, <https://api.github.com/pulls?page=2>; rel=next`, true],
    ['<https://api.github.com/pulls?page=1>; rel="prev"', false],
    ['malformed; rel="next"', false]
  ])("parses Link relations independent of parameter form", async (link, truncated) => {
    const client = new OctokitPullRequestClient(undefined, lister([], { link }));
    await expect(client.listPullRequests({ owner: "octo", repo: "repository" })).resolves.toEqual({ items: [], truncated });
  });

  it("returns truncated false without a next relation", async () => {
    const client = new OctokitPullRequestClient(undefined, lister([], { link: '<https://api.github.com/pulls?page=1>; rel="last"' }));
    await expect(client.listPullRequests({ owner: "octo", repo: "repository" })).resolves.toEqual({ items: [], truncated: false });
  });

  it.each([
    ["dirty title", { ...validPullRequest, title: " dirty" }],
    ["overlong title", { ...validPullRequest, title: "x".repeat(1_025) }],
    ["dirty label", { ...validPullRequest, labels: [{ name: "bad\nlabel", color: "fff" }] }],
    ["too many labels", { ...validPullRequest, labels: Array.from({ length: 101 }, (_, index) => ({ name: `l${index}`, color: "fff" })) }],
    ["missing draft", (({ draft: _draft, ...rest }) => rest)(validPullRequest)],
    ["contradictory lifecycle", { ...validPullRequest, state: "open", closed_at: validPullRequest.closed_at, merged_at: null }],
    ["closed without timestamp", { ...validPullRequest, closed_at: null, merged_at: null }],
    ["updated before creation", { ...validPullRequest, updated_at: "2026-07-31T00:00:00.000Z" }],
    ["closed before creation", { ...validPullRequest, closed_at: "2026-07-31T00:00:00.000Z", merged_at: null }],
    ["merged after closed", { ...validPullRequest, closed_at: "2026-08-03T00:00:00.000Z", merged_at: "2026-08-04T00:00:00.000Z" }],
    ["updated before closed", { ...validPullRequest, updated_at: "2026-08-02T00:00:00.000Z", closed_at: "2026-08-03T00:00:00.000Z", merged_at: null }],
    ["updated before merged", { ...validPullRequest, updated_at: "2026-08-02T00:00:00.000Z", closed_at: "2026-08-04T00:00:00.000Z", merged_at: "2026-08-03T00:00:00.000Z" }],
    ["wrong host", { ...validPullRequest, html_url: "https://example.com/octo/repository/pull/42" }],
    ["wrong repository", { ...validPullRequest, html_url: "https://github.com/octo/other/pull/42" }],
    ["trailing-hyphen owner", { ...validPullRequest, html_url: "https://github.com/bad-/repository/pull/42" }],
    ["all-dot repository", { ...validPullRequest, html_url: "https://github.com/octo/.../pull/42" }],
    ["overlong owner", { ...validPullRequest, html_url: `https://github.com/${"a".repeat(40)}/repository/pull/42` }],
    ["overlong repository", { ...validPullRequest, html_url: `https://github.com/octo/${"r".repeat(101)}/pull/42` }],
    ["wrong number", { ...validPullRequest, html_url: "https://github.com/octo/repository/pull/43" }],
    ["leading-zero number", { ...validPullRequest, html_url: "https://github.com/octo/repository/pull/042" }],
    ["unsafe integer matching rounded value", { ...validPullRequest, number: 9_007_199_254_740_992, html_url: "https://github.com/octo/repository/pull/9007199254740992" }],
    ["unsafe integer precision bypass", { ...validPullRequest, number: 9_007_199_254_740_993, html_url: "https://github.com/octo/repository/pull/9007199254740993" }],
    ["query ambiguity", { ...validPullRequest, html_url: `${validPullRequest.html_url}?token=value` }],
    ["percent ambiguity", { ...validPullRequest, html_url: "https://github.com/octo/repository/pull/%34%32" }],
    ["dot-segment normalization", { ...validPullRequest, html_url: "https://github.com/octo/./repository/pull/42" }],
    ["parent-segment normalization", { ...validPullRequest, html_url: "https://github.com/octo/segment/../repository/pull/42" }],
    ["backslash normalization", { ...validPullRequest, html_url: String.raw`https://github.com/octo\repository/pull/42` }],
    ["path backslash normalization", { ...validPullRequest, html_url: String.raw`https://github.com/octo/repository\pull/42` }]
  ])("fails closed for %s", async (_name, payload) => {
    const client = new OctokitPullRequestClient(undefined, lister([payload]));
    await expect(client.listPullRequests({ owner: "octo", repo: "repository" })).rejects.toBeInstanceOf(GitHubProviderPayloadError);
  });

  it.each([
    ["", "repository"],
    ["octo", ""],
    ["bad-", "repository"],
    ["octo", "..."],
    ["a".repeat(40), "repository"],
    ["octo", "r".repeat(101)]
  ])("fails closed when requested and returned identity share malformed coordinates %s/%s", async (owner, repo) => {
    const payload = {
      ...validPullRequest,
      html_url: `https://github.com/${owner}/${repo}/pull/42`
    };
    const client = new OctokitPullRequestClient(undefined, lister([payload]));
    await expect(client.listPullRequests({ owner, repo })).rejects.toBeInstanceOf(GitHubProviderPayloadError);
  });

  it("fails closed if a single response contains more than 100 rows", async () => {
    const client = new OctokitPullRequestClient(undefined, lister(Array.from({ length: 101 }, (_, index) => ({
      ...validPullRequest,
      number: index + 1,
      html_url: `https://github.com/octo/repository/pull/${index + 1}`
    }))));
    await expect(client.listPullRequests({ owner: "octo", repo: "repository" })).rejects.toBeInstanceOf(GitHubProviderPayloadError);
  });

  it("translates list request failures into sanitized GitHub API errors", async () => {
    const client = new OctokitPullRequestClient(undefined, {
      listPullRequests: async () => { throw { response: { status: 429, headers: { "retry-after": "30", "x-ratelimit-remaining": "0" } } }; }
    });
    await expect(client.listPullRequests({ owner: "octo", repo: "repository" })).rejects.toMatchObject(
      new GitHubApiError("GitHub request failed with status 429", 429, undefined, "30", "0")
    );
  });
});
