import { describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "../jobQueue";
import { GitHubApiError } from "../github/client";
import { enqueuePublicPrReview, parsePublicPrUrl } from "./publicPr";

describe("public PR intake", () => {
  it.each([
    ["https://github.com/espnet/espnet/pull/6327", "espnet", "espnet", 6327],
    ["https://github.com/Mixed-Owner/repo.name_with-parts/pull/42", "Mixed-Owner", "repo.name_with-parts", 42]
  ] as const)("accepts canonical GitHub pull request URL %s", (url, owner, repo, pullRequestNumber) => {
    expect(parsePublicPrUrl(url)).toEqual({
      repository: `${owner}/${repo}`,
      owner,
      repo,
      pullRequestNumber
    });
  });

  it.each([
    "http://github.com/owner/repo/pull/1",
    "https://github.example.com/owner/repo/pull/1",
    "https://user:pass@github.com/owner/repo/pull/1",
    "https://github.com:443/owner/repo/pull/1",
    "https://github.com/owner/repo/pull/1?tab=files",
    "https://github.com/owner/repo/pull/1#diff",
    "https://github.com/owner/repo/pull/042",
    "https://github.com/owner/repo/pull/%34%32",
    "https://github.com/owner/./repo/pull/1",
    "https://github.com/owner/segment/../repo/pull/1",
    String.raw`https://github.com/owner\repo/pull/1`,
    String.raw`https://github.com/owner/repo\pull/1`,
    "https://github.com/bad-/repo/pull/1",
    "https://github.com/owner/.../pull/1",
    "https://github.com/owner/repo/issues/1",
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo/pull/0",
    "https://github.com/owner/repo/pull/1/extra",
    " https://github.com/owner/repo/pull/1",
    "https://github.com/owner/repo/pull/1\n",
    `https://github.com/owner/repo/pull/${Number.MAX_SAFE_INTEGER + 1}`
  ])("rejects non-canonical or ambiguous public PR URL %s", value => {
    expect(() => parsePublicPrUrl(value)).toThrow();
  });

  it("creates an anonymous analysis-only public-read job with immutable SHAs", async () => {
    const jobs = new InMemoryJobQueue();
    let seenToken: string | undefined;
    const result = await enqueuePublicPrReview({
      url: "https://github.com/espnet/espnet/pull/6327",
      jobs,
      clientFactory: token => {
        seenToken = token;
        return {
        getPullRequest: async () => ({ baseSha: "a".repeat(40), headSha: "b".repeat(40) }),
        listChangedFiles: async () => [],
        getDiff: async () => ""
        };
      }
    });

    expect(result.job).toMatchObject({
      repository: "espnet/espnet",
      pullRequestNumber: 6327,
      accessMode: "public_read",
      publicationPolicy: "disabled",
      status: "queued"
    });
    expect(result.job.baseSha).toBe("a".repeat(40));
    expect(result.job.headSha).toBe("b".repeat(40));
    expect(jobs.getPublishOutbox(result.job.id)).toHaveLength(0);
    expect(seenToken).toBeUndefined();
  });

  it("associates a public PR job with an exact case-insensitive canonical repository match", async () => {
    const jobs = new InMemoryJobQueue();
    const matched = await enqueuePublicPrReview({
      url: "https://github.com/ESPnet/ESPnet/pull/6327",
      jobs,
      repositoryStore: {
        findRepositoryByRemoteFullName: value => value.toLowerCase() === "espnet/espnet"
          ? {
              id: "repo_canonical",
              displayName: "espnet",
              source: "local_git",
              remoteFullName: "espnet/espnet",
              trustLevel: "untrusted_readonly",
              monitoringEnabled: true,
              createdAt: "2026-08-24T00:00:00.000Z",
              updatedAt: "2026-08-24T00:00:00.000Z"
            }
          : undefined
      },
      clientFactory: () => ({
        getPullRequest: async () => ({ baseSha: "a".repeat(40), headSha: "b".repeat(40) })
      })
    });
    expect(matched.job.repositoryId).toBe("repo_canonical");

    const unmatched = await enqueuePublicPrReview({
      url: "https://github.com/other/repository/pull/1",
      jobs,
      repositoryStore: { findRepositoryByRemoteFullName: () => undefined },
      clientFactory: () => ({
        getPullRequest: async () => ({ baseSha: "c".repeat(40), headSha: "d".repeat(40) })
      })
    });
    expect(unmatched.job.repositoryId).toBeUndefined();
  });

  it("passes the optional public read token to the GitHub client without changing the job policy", async () => {

    const jobs = new InMemoryJobQueue();
    let seenToken: string | undefined;
    const result = await enqueuePublicPrReview({
      url: "https://github.com/espnet/espnet/pull/6327",
      jobs,
      publicReadToken: "local-read-token",
      clientFactory: token => {
        seenToken = token;
        return {
          getPullRequest: async () => ({ baseSha: "a".repeat(40), headSha: "b".repeat(40) }),
          listChangedFiles: async () => [],
          getDiff: async () => ""
        };
      }
    });

    expect(seenToken).toBe("local-read-token");
    expect(result.job.accessMode).toBe("public_read");
    expect(result.job.publicationPolicy).toBe("disabled");
  });

  it("enforces publication disabled even if a public-read caller supplies a publish policy", () => {
    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request",
      deliveryId: "public-read-policy",
      repository: "espnet/espnet",
      pullRequestNumber: 6327,
      accessMode: "public_read",
      publicationPolicy: "github_comment",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40)
    });
    expect(job.publicationPolicy).toBe("disabled");
    expect(job.installationId).toBeUndefined();
  });

  it.each([
    [404, "PUBLIC_GITHUB_NOT_FOUND", 404],
    [401, "PUBLIC_GITHUB_FORBIDDEN", 403],
    [403, "PUBLIC_GITHUB_FORBIDDEN", 403],
    [429, "PUBLIC_GITHUB_RATE_LIMITED", 429]
  ] as const)("maps GitHub status %s to a safe public error", async (status, code, statusCode) => {
    await expect(enqueuePublicPrReview({
      url: "https://github.com/espnet/espnet/pull/6327",
      jobs: new InMemoryJobQueue(),
      clientFactory: () => ({
        getPullRequest: async () => { throw new GitHubApiError("private details", status); },
        listChangedFiles: async () => [],
        getDiff: async () => ""
      })
    })).rejects.toMatchObject({ code, statusCode });
  });

  it.each([
    ["30", "PUBLIC_GITHUB_RATE_LIMITED", 429],
    ["Sun, 06 Nov 1994 08:49:37 GMT", "PUBLIC_GITHUB_RATE_LIMITED", 429],
    ["12/31/2026", "PUBLIC_GITHUB_FORBIDDEN", 403],
    ["not-a-retry-value", "PUBLIC_GITHUB_FORBIDDEN", 403],
    ["Mon, 06 Nov 1994 08:49:37 GMT", "PUBLIC_GITHUB_FORBIDDEN", 403]
  ] as const)("classifies 403 Retry-After %s consistently", async (retryAfter, code, statusCode) => {
    await expect(enqueuePublicPrReview({
      url: "https://github.com/espnet/espnet/pull/6327",
      jobs: new InMemoryJobQueue(),
      clientFactory: () => ({
        getPullRequest: async () => { throw new GitHubApiError("private details", 403, undefined, retryAfter, "50"); }
      })
    })).rejects.toMatchObject({ code, statusCode });
  });

  it("preserves safe reset metadata for public API rate limiting", async () => {
    await expect(enqueuePublicPrReview({
      url: "https://github.com/espnet/espnet/pull/6327",
      jobs: new InMemoryJobQueue(),
      clientFactory: () => ({
        getPullRequest: async () => { throw new GitHubApiError("private details", 403, "1770000000", "30", "0"); },
        listChangedFiles: async () => [],
        getDiff: async () => ""
      })
    })).rejects.toMatchObject({
      code: "PUBLIC_GITHUB_RATE_LIMITED",
      statusCode: 429,
      details: { rateLimitReset: "1770000000", retryAfter: "30" }
    });
  });
});
