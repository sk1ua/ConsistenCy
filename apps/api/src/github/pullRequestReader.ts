import {
  parseGitHubRepositoryFullName,
  type PullRequestSummary,
  type RepositoryPullRequestsResponse,
  type RepositoryPullRequestsUnavailableReasonCode
} from "@consistency/schema";
import {
  classifyGitHubApiError,
  GitHubApiError,
  GitHubProviderPayloadError,
  OctokitPullRequestClient,
  type PullRequestListClient,
  type PullRequestListItem,
  type PullRequestListResult
} from "./client";
import type { ReviewJob, ReviewJobStore } from "../jobQueue";
import {
  resolveGitHubReadAccessCandidates,
  type GitHubInstallationAuthenticator
} from "./access";

export type GitHubRepositoryIdentity = {
  readonly owner: string;
  readonly repo: string;
  readonly normalizedFullName: string;
};

export type GitHubRemote = {
  readonly name: string;
  readonly githubFullName?: string;
};

export type { GitHubInstallationAuthenticator } from "./access";

export type PullRequestReaderFactory = (token?: string) => PullRequestListClient;

export type RepositoryPullRequestServiceOptions = {
  readonly authenticator?: GitHubInstallationAuthenticator;
  readonly publicReadToken?: string;
  readonly readerFactory?: PullRequestReaderFactory;
  readonly listRemotes: (localPath: string) => Promise<readonly GitHubRemote[]>;
  readonly jobs: Pick<ReviewJobStore, "listLatestPullRequestJobsForRepository">;
};

export type RepositoryPullRequestRequest = {
  readonly repositoryId: string;
  readonly registeredRemoteFullName?: string;
  readonly registeredSource?: "local_git" | "github" | "gitlab";
  readonly localPath?: string;
};

type GitHubIdentityResolution =
  | { readonly available: true; readonly identity: GitHubRepositoryIdentity }
  | {
      readonly available: false;
      readonly reasonCode: "not_github" | "identity_unavailable";
      readonly reason: string;
    };

type PullRequestReviewIndex = ReadonlyMap<number, ReviewJob>;

export function normalizeGitHubFullName(value: string): GitHubRepositoryIdentity | undefined {
  const identity = parseGitHubRepositoryFullName(value);
  if (identity === null) return undefined;
  return {
    owner: identity.owner,
    repo: identity.repo,
    normalizedFullName: identity.fullName.toLowerCase()
  };
}

function createProductionPullRequestReader(token?: string): PullRequestListClient {
  return new OctokitPullRequestClient(token);
}

function unavailable(
  repositoryId: string,
  reasonCode: RepositoryPullRequestsUnavailableReasonCode,
  reason: string
): RepositoryPullRequestsResponse {
  return { repositoryId, available: false, reasonCode, reason, pullRequests: [] };
}

function unavailableReason(error: unknown): {
  readonly reasonCode: RepositoryPullRequestsUnavailableReasonCode;
  readonly reason: string;
} {
  if (!(error instanceof GitHubApiError)) {
    return { reasonCode: "provider_unavailable", reason: "GitHub pull requests unavailable" };
  }
  switch (classifyGitHubApiError(error)) {
    case "rate_limited":
      return { reasonCode: "rate_limited", reason: "GitHub rate limit reached" };
    case "access_denied":
      return { reasonCode: "access_denied", reason: "GitHub access denied" };
    case "not_found":
      return { reasonCode: "not_found", reason: "GitHub repository unavailable" };
    case "provider_unavailable":
      return { reasonCode: "provider_unavailable", reason: "GitHub pull requests unavailable" };
  }
}

function indexLatestReviews(jobs: readonly ReviewJob[]): PullRequestReviewIndex {
  const reviews = new Map<number, ReviewJob>();
  for (const job of jobs) {
    if (job.kind !== "pull_request" || job.pullRequestNumber === undefined) continue;
    const newest = reviews.get(job.pullRequestNumber);
    if (newest === undefined || job.createdAt > newest.createdAt) reviews.set(job.pullRequestNumber, job);
  }
  return reviews;
}

function latestReviewFor(job: ReviewJob | undefined): PullRequestSummary["latestReview"] {
  if (job === undefined) return undefined;
  return {
    jobId: job.id,
    status: job.status,
    ...(job.result?.score === undefined ? {} : { score: job.result.score }),
    ...(job.result?.riskLevel === undefined ? {} : { riskLevel: job.result.riskLevel }),
    createdAt: job.createdAt
  };
}

function toPullRequestSummary(
  pullRequest: PullRequestListItem,
  latestReview: PullRequestSummary["latestReview"]
): PullRequestSummary {
  return {
    provider: "github",
    number: pullRequest.number,
    title: pullRequest.title,
    state: pullRequest.state,
    draft: pullRequest.draft,
    labels: pullRequest.labels.map(label => ({ name: label.name, color: label.color })),
    author: pullRequest.author,
    baseRef: pullRequest.baseRef,
    headRef: pullRequest.headRef,
    baseSha: pullRequest.baseSha,
    headSha: pullRequest.headSha,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    closedAt: pullRequest.closedAt,
    mergedAt: pullRequest.mergedAt,
    htmlUrl: pullRequest.htmlUrl,
    ...(latestReview === undefined ? {} : { latestReview })
  };
}

export class RepositoryPullRequestService {
  private readonly options: RepositoryPullRequestServiceOptions;

  constructor(options: RepositoryPullRequestServiceOptions) {
    this.options = options;
  }

  async list(request: RepositoryPullRequestRequest): Promise<RepositoryPullRequestsResponse> {
    const identityResult = await this.resolveIdentity(request);
    if (!identityResult.available) {
      return unavailable(request.repositoryId, identityResult.reasonCode, identityResult.reason);
    }
    const identity = identityResult.identity;
    const readerFactory = this.options.readerFactory ?? createProductionPullRequestReader;
    let finalError: unknown = new GitHubApiError("GitHub request failed");

    for (const candidate of await resolveGitHubReadAccessCandidates({
      owner: identity.owner,
      repo: identity.repo,
      authenticator: this.options.authenticator,
      publicReadToken: this.options.publicReadToken
    })) {
      let result: PullRequestListResult;
      try {
        result = await readerFactory(candidate.token).listPullRequests(identity);
      } catch (error) {
        if (error instanceof GitHubProviderPayloadError) {
          return unavailable(
            request.repositoryId,
            "invalid_provider_data",
            "GitHub returned invalid pull request data"
          );
        }
        finalError = error;
        continue;
      }
      if (result.items.length > 100) {
        return unavailable(
          request.repositoryId,
          "invalid_provider_data",
          "GitHub returned invalid pull request data"
        );
      }
      const pullRequestNumbers = result.items.map(pullRequest => pullRequest.number);
      const latestReviews = indexLatestReviews(
        pullRequestNumbers.length === 0
          ? []
          : this.options.jobs.listLatestPullRequestJobsForRepository(request.repositoryId, pullRequestNumbers)
      );
      return {
        repositoryId: request.repositoryId,
        repositoryFullName: `${identity.owner}/${identity.repo}`,
        available: true,
        page: { limit: 100, truncated: result.truncated },
        pullRequests: result.items.map(pullRequest =>
          toPullRequestSummary(pullRequest, latestReviewFor(latestReviews.get(pullRequest.number)))
        )
      };
    }
    const failure = unavailableReason(finalError);
    return unavailable(request.repositoryId, failure.reasonCode, failure.reason);
  }

  private async resolveIdentity(request: RepositoryPullRequestRequest): Promise<GitHubIdentityResolution> {
    if (request.registeredSource === "gitlab") {
      return {
        available: false,
        reasonCode: "not_github",
        reason: "repository provider is not GitHub"
      };
    }
    if (request.registeredRemoteFullName !== undefined) {
      const identity = normalizeGitHubFullName(request.registeredRemoteFullName);
      return identity === undefined
        ? {
            available: false,
            reasonCode: "identity_unavailable",
            reason: "GitHub repository remote unavailable"
          }
        : { available: true, identity };
    }
    if (request.localPath === undefined) {
      return {
        available: false,
        reasonCode: "identity_unavailable",
        reason: "GitHub repository remote unavailable"
      };
    }
    let remotes: readonly GitHubRemote[];
    try {
      remotes = await this.options.listRemotes(request.localPath);
    } catch {
      return {
        available: false,
        reasonCode: "identity_unavailable",
        reason: "GitHub repository remote unavailable"
      };
    }
    const origin = remotes.find(remote => remote.name === "origin" && remote.githubFullName !== undefined);
    const recognized = origin ?? remotes.find(remote => remote.githubFullName !== undefined);
    const identity = recognized?.githubFullName === undefined ? undefined : normalizeGitHubFullName(recognized.githubFullName);
    return identity === undefined
      ? {
          available: false,
          reasonCode: "identity_unavailable",
          reason: "GitHub repository remote unavailable"
        }
      : { available: true, identity };
  }

}
