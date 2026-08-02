import { Octokit } from "@octokit/rest";
import type { ChangedFile } from "@consistency/schema";

export type PullRequestCoordinates = {
  owner: string;
  repo: string;
  pullRequestNumber: number;
};

export type PullRequestSnapshot = {
  baseSha: string;
  headSha: string;
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

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function toGitHubApiError(error: unknown): GitHubApiError {
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

export function splitRepositoryFullName(repositoryFullName: string): { owner: string; repo: string } {
  const parts = repositoryFullName.split("/");
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error("repositoryFullName must use the owner/repository format");
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

export class OctokitPullRequestClient implements PullRequestClient {
  private readonly octokit: Octokit;

  constructor(token?: string) {
    this.octokit = new Octokit(token ? { auth: token } : {});
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
