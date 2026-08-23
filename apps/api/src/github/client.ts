import { Octokit } from "@octokit/rest";
import type { ChangedFile } from "@consistency/schema";
import { z } from "zod";

const rawPullRequestListItemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().trim().min(1),
  state: z.enum(["open", "closed"]),
  user: z.object({ login: z.string().trim().min(1) }).nullable(),
  base: z.object({ ref: z.string().trim().min(1), sha: z.string().trim().min(1) }),
  head: z.object({ ref: z.string().trim().min(1), sha: z.string().trim().min(1) }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  merged_at: z.string().datetime().nullable(),
  html_url: z.string().url().refine(value => value.startsWith("https://"))
});

export type PullRequestCoordinates = {
  readonly owner: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
};

export type RepositoryCoordinates = {
  readonly owner: string;
  readonly repo: string;
};

export type PullRequestSnapshot = {
  readonly baseSha: string;
  readonly headSha: string;
};

export type PullRequestListItem = {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly author: string | null;
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt: string | null;
  readonly htmlUrl: string;
};

export type OctokitPullRequestListRequest = RepositoryCoordinates & {
  readonly state: "all";
  readonly per_page: 100;
};

export type OctokitPullRequestPaginator = {
  readonly paginatePullRequests: (request: OctokitPullRequestListRequest) => Promise<readonly unknown[]>;
};

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly rateLimitReset?: string,
    public readonly retryAfter?: string,
    public readonly rateLimitRemaining?: string
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class GitHubProviderPayloadError extends Error {
  constructor() {
    super("GitHub returned invalid pull request data");
    this.name = "GitHubProviderPayloadError";
  }
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

export function toGitHubApiError(error: unknown): GitHubApiError {
  if (error instanceof GitHubApiError) return error;
  const value = error as {
    status?: unknown;
    response?: { status?: unknown; headers?: unknown };
  } | undefined;
  const status = typeof value?.status === "number"
    ? value.status
    : typeof value?.response?.status === "number"
      ? value.response.status
      : undefined;
  const headers = value?.response?.headers;
  return new GitHubApiError(
    status ? `GitHub request failed with status ${status}` : "GitHub request failed",
    Number.isFinite(status) && status ? status : undefined,
    headerValue(headers, "x-ratelimit-reset"),
    headerValue(headers, "retry-after"),
    headerValue(headers, "x-ratelimit-remaining")
  );
}

export interface PullRequestClient {
  getPullRequest(input: PullRequestCoordinates): Promise<PullRequestSnapshot>;
  listChangedFiles(input: PullRequestCoordinates): Promise<ChangedFile[]>;
  getDiff(input: PullRequestCoordinates): Promise<string>;
}

export interface PullRequestListClient {
  listPullRequests(input: RepositoryCoordinates): Promise<readonly PullRequestListItem[]>;
}

export function splitRepositoryFullName(repositoryFullName: string): { owner: string; repo: string } {
  const parts = repositoryFullName.split("/");
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error("repositoryFullName must use the owner/repository format");
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

export class OctokitPullRequestClient implements PullRequestClient, PullRequestListClient {
  private readonly octokit: Octokit;
  private readonly paginator: OctokitPullRequestPaginator;

  constructor(token?: string, paginator?: OctokitPullRequestPaginator) {
    this.octokit = new Octokit(token ? { auth: token } : {});
    this.paginator = paginator ?? {
      paginatePullRequests: request => this.octokit.paginate(this.octokit.rest.pulls.list, request)
    };
  }

  async getPullRequest(input: PullRequestCoordinates): Promise<PullRequestSnapshot> {
    try {
      const response = await this.octokit.rest.pulls.get({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullRequestNumber
      });
      return { baseSha: response.data.base.sha, headSha: response.data.head.sha };
    } catch (error) {
      throw toGitHubApiError(error);
    }
  }

  async listPullRequests(input: RepositoryCoordinates): Promise<readonly PullRequestListItem[]> {
    let payload: readonly unknown[];
    try {
      payload = await this.paginator.paginatePullRequests({
        owner: input.owner,
        repo: input.repo,
        state: "all",
        per_page: 100
      });
    } catch (error) {
      throw toGitHubApiError(error);
    }

    const parsed = z.array(rawPullRequestListItemSchema).safeParse(payload);
    if (!parsed.success) throw new GitHubProviderPayloadError();
    return parsed.data.map(pullRequest => ({
      number: pullRequest.number,
      title: pullRequest.title,
      state: pullRequest.state,
      author: pullRequest.user?.login ?? null,
      baseRef: pullRequest.base.ref,
      headRef: pullRequest.head.ref,
      baseSha: pullRequest.base.sha,
      headSha: pullRequest.head.sha,
      createdAt: pullRequest.created_at,
      updatedAt: pullRequest.updated_at,
      mergedAt: pullRequest.merged_at,
      htmlUrl: pullRequest.html_url
    }));
  }

  async listChangedFiles(input: PullRequestCoordinates): Promise<ChangedFile[]> {
    try {
      const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullRequestNumber,
        per_page: 100
      });
      return files.map(file => ({
        path: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: file.patch
      }));
    } catch (error) {
      throw toGitHubApiError(error);
    }
  }

  async getDiff(input: PullRequestCoordinates): Promise<string> {
    try {
      const response = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullRequestNumber,
        headers: { accept: "application/vnd.github.v3.diff" }
      });
      return typeof response.data === "string" ? response.data : String(response.data);
    } catch (error) {
      throw toGitHubApiError(error);
    }
  }
}
