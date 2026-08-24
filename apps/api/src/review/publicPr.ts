import { parseCanonicalGitHubPullRequestUrl } from "@consistency/schema";
import type { CreateReviewJobInput, ReviewJob, ReviewJobStore } from "../jobQueue";
import {
  classifyGitHubApiError,
  GitHubApiError,
  OctokitPullRequestClient,
  type PullRequestClient
} from "../github/client";
import type { AuditDomainStore } from "../audit/store";

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
  const parsed = parseCanonicalGitHubPullRequestUrl(value);
  if (parsed === null) {
    throw new PublicPrError(
      "Enter a canonical GitHub pull request URL",
      "INVALID_PUBLIC_PR_URL",
      400
    );
  }
  return {
    repository: parsed.fullName,
    owner: parsed.owner,
    repo: parsed.repo,
    pullRequestNumber: parsed.pullRequestNumber
  };
}

export async function enqueuePublicPrReview(options: {
  url: string;
  jobs: ReviewJobStore;
  publicReadToken?: string;
  llmProvider?: "deepseek" | "openai";
  llmModel?: string;
  repositoryStore?: Pick<AuditDomainStore, "findRepositoryByRemoteFullName">;
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

  const canonicalRepository = options.repositoryStore?.findRepositoryByRemoteFullName(coordinates.repository);
  const input: CreateReviewJobInput = {
    kind: "pull_request",
    repository: coordinates.repository,
    ...(canonicalRepository === undefined ? {} : { repositoryId: canonicalRepository.id }),
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
  switch (classifyGitHubApiError(error)) {
    case "rate_limited":
      return new PublicPrError("GitHub public API rate limit reached", "PUBLIC_GITHUB_RATE_LIMITED", 429, details);
    case "not_found":
      return new PublicPrError("The public GitHub pull request was not found", "PUBLIC_GITHUB_NOT_FOUND", 404);
    case "access_denied":
      return new PublicPrError("GitHub denied access to this public pull request", "PUBLIC_GITHUB_FORBIDDEN", 403);
    case "provider_unavailable":
      return new PublicPrError("GitHub public data is temporarily unavailable", "PUBLIC_GITHUB_UNAVAILABLE", 502);
  }
}
