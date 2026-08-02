import { describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "../jobQueue";
import { GitHubApiError } from "../github/client";
import { enqueuePublicPrReview, parsePublicPrUrl } from "./publicPr";

describe("public PR intake", () => {
  it("accepts only canonical GitHub pull request URLs and ignores query metadata", () => {
    expect(parsePublicPrUrl("https://github.com/espnet/espnet/pull/6327?tab=files#diff")).toMatchObject({
      repository: "espnet/espnet",
      owner: "espnet",
      repo: "espnet",
      pullRequestNumber: 6327
    });
  });

  it("rejects arbitrary hosts, issue URLs, clone URLs, and invalid coordinates", () => {
    for (const value of [
      "http://github.com/owner/repo/pull/1",
      "https://github.example.com/owner/repo/pull/1",
      "https://github.com/owner/repo/issues/1",
      "https://github.com/owner/repo.git",
      "https://github.com/owner/repo/pull/0",
      "https://github.com/owner/repo/pull/1/extra"
    ]) {
      expect(() => parsePublicPrUrl(value)).toThrow();
    }
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
    [403, "PUBLIC_GITHUB_FORBIDDEN", 403]
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
