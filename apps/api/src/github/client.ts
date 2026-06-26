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

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async getPullRequest(input: PullRequestCoordinates): Promise<PullRequestSnapshot> {
    const response = await this.octokit.rest.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullRequestNumber
    });
    return { baseSha: response.data.base.sha, headSha: response.data.head.sha };
  }

  async listChangedFiles(input: PullRequestCoordinates): Promise<ChangedFile[]> {
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
  }

  async getDiff(input: PullRequestCoordinates): Promise<string> {
    const response = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullRequestNumber,
      headers: { accept: "application/vnd.github.v3.diff" }
    });
    return typeof response.data === "string" ? response.data : String(response.data);
  }
}
