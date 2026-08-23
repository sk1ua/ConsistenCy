import type { CreateReviewJobInput, ReviewJob, ReviewJobStore } from "../jobQueue";
import { GitHubApiError, OctokitPullRequestClient, splitRepositoryFullName, type PullRequestClient } from "../github/client";

export type PublicPrErrorCode =
  | "INVALID_PUBLIC_PR_URL"
  | "PUBLIC_GITHUB_NOT_FOUND"
  | "PUBLIC_GITHUB_RATE_LIMITED"
  | "PUBLIC_GITHUB_FORBIDDEN"
  | "PUBLIC_GITHUB_UNAVAILABLE"
  | "PUBLIC_GITHUB_SNAPSHOT_CHANGED";

export class PublicPrError extends Error {
  constructor(
    message: string,
    public readonly code: PublicPrErrorCode,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PublicPrError";
  }
}

export type PublicPrCoordinates = {
  repository: string;
  owner: string;
  repo: string;
  pullRequestNumber: number;
};

export function parsePublicPrUrl(value: string): PublicPrCoordinates {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicPrError("Enter a valid GitHub pull request URL", "INVALID_PUBLIC_PR_URL", 400);
  }

  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new PublicPrError("Only https://github.com/.../pull/... URLs are supported", "INVALID_PUBLIC_PR_URL", 400);
  }

  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) {
    throw new PublicPrError("URL must point to a GitHub pull request", "INVALID_PUBLIC_PR_URL", 400);
  }

  const repository = `${match[1]}/${match[2]}`;
  const { owner, repo } = splitRepositoryFullName(repository);
  const pullRequestNumber = Number(match[3]);
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new PublicPrError("Pull request number must be a positive integer", "INVALID_PUBLIC_PR_URL", 400);
  }

  return { repository, owner, repo, pullRequestNumber };
}

export async function enqueuePublicPrReview(options: {
  url: string;
  jobs: ReviewJobStore;
  publicReadToken?: string;
  llmProvider?: "deepseek" | "openai";
  llmModel?: string;
  clientFactory?: (token?: string) => Pick<PullRequestClient, "getPullRequest">;
}): Promise<{ coordinates: PublicPrCoordinates; job: ReviewJob }> {
  const coordinates = parsePublicPrUrl(options.url);
  const client = options.clientFactory?.(options.publicReadToken)
    ?? new OctokitPullRequestClient(options.publicReadToken);
  let pullRequest;
  try {
    pullRequest = await client.getPullRequest({
      owner: coordinates.owner,
      repo: coordinates.repo,
      pullRequestNumber: coordinates.pullRequestNumber
    });
  } catch (error) {
    throw mapGitHubError(error);
  }

  const input: CreateReviewJobInput = {
    kind: "pull_request",
    repository: coordinates.repository,
    pullRequestNumber: coordinates.pullRequestNumber,
    baseSha: pullRequest.baseSha,
    headSha: pullRequest.headSha,
    senderLogin: "webui",
    action: "public_url",
    accessMode: "public_read",
    publicationPolicy: "disabled",
    llmProvider: options.llmProvider,
    llmModel: options.llmModel
  };

  return { coordinates, job: options.jobs.enqueue(input) };
}

export function mapGitHubError(error: unknown): PublicPrError {
  if (!(error instanceof GitHubApiError)) {
    return new PublicPrError("GitHub public data is temporarily unavailable", "PUBLIC_GITHUB_UNAVAILABLE", 502);
  }

  const details = {
    ...(error.rateLimitReset ? { rateLimitReset: error.rateLimitReset } : {}),
    ...(error.retryAfter ? { retryAfter: error.retryAfter } : {})
  };
  const rateLimited = error.status === 429 || (error.status === 403 && error.rateLimitRemaining === "0");
  if (rateLimited) {
    return new PublicPrError("GitHub public API rate limit reached", "PUBLIC_GITHUB_RATE_LIMITED", 429, details);
  }
  if (error.status === 404) {
    return new PublicPrError("The public GitHub pull request was not found", "PUBLIC_GITHUB_NOT_FOUND", 404);
  }
  if (error.status === 401 || error.status === 403) {
    return new PublicPrError("GitHub denied access to this public pull request", "PUBLIC_GITHUB_FORBIDDEN", 403);
  }
  return new PublicPrError("GitHub public data is temporarily unavailable", "PUBLIC_GITHUB_UNAVAILABLE", 502);
}
