import type { PullRequestSummary, RepositoryPullRequestsResponse } from "@consistency/schema";
import {
  GitHubApiError,
  GitHubProviderPayloadError,
  OctokitPullRequestClient,
  type PullRequestListClient,
  type PullRequestListItem
} from "./client";
import type { ReviewJob, ReviewJobStore } from "../jobQueue";

export type GitHubRepositoryIdentity = {
  readonly owner: string;
  readonly repo: string;
  readonly normalizedFullName: string;
};

export type GitHubRemote = {
  readonly name: string;
  readonly githubFullName?: string;
};

export type GitHubInstallationAuthenticator = {
  getRepositoryInstallationId(owner: string, repo: string): Promise<number>;
  getInstallationToken(installationId: number): Promise<{ readonly token: string }>;
};

export type PullRequestReaderFactory = (token?: string) => PullRequestListClient;

export type RepositoryPullRequestServiceOptions = {
  readonly authenticator?: GitHubInstallationAuthenticator;
  readonly publicReadToken?: string;
  readonly readerFactory?: PullRequestReaderFactory;
  readonly listRemotes: (localPath: string) => Promise<readonly GitHubRemote[]>;
  readonly jobs: Pick<ReviewJobStore, "list">;
};

export type RepositoryPullRequestRequest = {
  readonly repositoryId: string;
  readonly registeredRemoteFullName?: string;
  readonly registeredSource?: "local_git" | "github" | "gitlab";
  readonly localPath?: string;
};

type GitHubIdentityResolution =
  | { readonly available: true; readonly identity: GitHubRepositoryIdentity }
  | { readonly available: false; readonly reason: string };

type PullRequestAccessCandidate = {
  readonly token?: string;
};

type PullRequestReviewIndex = ReadonlyMap<number, ReviewJob>;

export function normalizeGitHubFullName(value: string): GitHubRepositoryIdentity | undefined {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value.trim());
  if (!match || !match[1] || !match[2]) return undefined;
  return {
    owner: match[1],
    repo: match[2],
    normalizedFullName: `${match[1].toLowerCase()}/${match[2].toLowerCase()}`
  };
}

function createProductionPullRequestReader(token?: string): PullRequestListClient {
  return new OctokitPullRequestClient(token);
}

function unavailable(repositoryId: string, reason: string): RepositoryPullRequestsResponse {
  return { repositoryId, available: false, reason, pullRequests: [] };
}

function unavailableReason(error: unknown): string {
  if (!(error instanceof GitHubApiError)) return "GitHub pull requests unavailable";
  if (error.status === 429 || (error.status === 403 && error.rateLimitRemaining === "0")) return "GitHub rate limit reached";
  if (error.status === 401 || error.status === 403) return "GitHub access denied";
  if (error.status === 404) return "GitHub repository unavailable";
  return "GitHub pull requests unavailable";
}

function indexLatestReviews(jobs: readonly ReviewJob[], identity: GitHubRepositoryIdentity): PullRequestReviewIndex {
  const reviews = new Map<number, ReviewJob>();
  for (const job of jobs) {
    if (job.kind !== "pull_request" || job.pullRequestNumber === undefined) continue;
    const repository = normalizeGitHubFullName(job.repository);
    if (repository?.normalizedFullName !== identity.normalizedFullName) continue;
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
    author: pullRequest.author,
    baseRef: pullRequest.baseRef,
    headRef: pullRequest.headRef,
    baseSha: pullRequest.baseSha,
    headSha: pullRequest.headSha,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
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
    if (!identityResult.available) return unavailable(request.repositoryId, identityResult.reason);
    const identity = identityResult.identity;
    const readerFactory = this.options.readerFactory ?? createProductionPullRequestReader;
    let finalError: unknown = new GitHubApiError("GitHub request failed");

    for (const candidate of await this.resolveAccessCandidates(identity)) {
      let pullRequests: readonly PullRequestListItem[];
      try {
        pullRequests = await readerFactory(candidate.token).listPullRequests(identity);
      } catch (error) {
        if (error instanceof GitHubProviderPayloadError) {
          return unavailable(request.repositoryId, "GitHub returned invalid pull request data");
        }
        finalError = error;
        continue;
      }
      const latestReviews = indexLatestReviews(this.options.jobs.list(), identity);
      return {
        repositoryId: request.repositoryId,
        available: true,
        pullRequests: pullRequests.map(pullRequest =>
          toPullRequestSummary(pullRequest, latestReviewFor(latestReviews.get(pullRequest.number)))
        )
      };
    }
    return unavailable(request.repositoryId, unavailableReason(finalError));
  }

  private async resolveIdentity(request: RepositoryPullRequestRequest): Promise<GitHubIdentityResolution> {
    if (request.registeredSource === "gitlab") {
      return { available: false, reason: "repository provider is not GitHub" };
    }
    if (request.registeredRemoteFullName !== undefined) {
      const identity = normalizeGitHubFullName(request.registeredRemoteFullName);
      return identity === undefined
        ? { available: false, reason: "GitHub repository remote unavailable" }
        : { available: true, identity };
    }
    if (request.localPath === undefined) return { available: false, reason: "GitHub repository remote unavailable" };
    let remotes: readonly GitHubRemote[];
    try {
      remotes = await this.options.listRemotes(request.localPath);
    } catch {
      return { available: false, reason: "GitHub repository remote unavailable" };
    }
    const origin = remotes.find(remote => remote.name === "origin" && remote.githubFullName !== undefined);
    const recognized = origin ?? remotes.find(remote => remote.githubFullName !== undefined);
    const identity = recognized?.githubFullName === undefined ? undefined : normalizeGitHubFullName(recognized.githubFullName);
    return identity === undefined
      ? { available: false, reason: "GitHub repository remote unavailable" }
      : { available: true, identity };
  }

  private async resolveAccessCandidates(identity: GitHubRepositoryIdentity): Promise<readonly PullRequestAccessCandidate[]> {
    const candidates: PullRequestAccessCandidate[] = [];
    const addCandidate = (candidate: PullRequestAccessCandidate): void => {
      if (!candidates.some(existing => existing.token === candidate.token)) candidates.push(candidate);
    };
    let appToken: string | undefined;
    if (this.options.authenticator !== undefined) {
      try {
        const installationId = await this.options.authenticator.getRepositoryInstallationId(identity.owner, identity.repo);
        const token = await this.options.authenticator.getInstallationToken(installationId);
        appToken = token.token;
      } catch {
        appToken = undefined;
      }
    }
    if (appToken !== undefined) addCandidate({ token: appToken });
    if (this.options.publicReadToken !== undefined) addCandidate({ token: this.options.publicReadToken });
    addCandidate({});
    return candidates;
  }
}
