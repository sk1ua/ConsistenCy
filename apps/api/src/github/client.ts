import { Octokit } from "@octokit/rest";
import {
  isCanonicalGitHubPullRequestUrl,
  parseGitHubRepositoryFullName,
  pullRequestLifecycleErrors,
  type ChangedFile
} from "@consistency/schema";
import { z } from "zod";

const strictProviderString = (maxLength: number) => z.string()
  .min(1)
  .max(maxLength)
  .refine(value => value === value.trim() && !/[\s\u0000-\u001f\u007f]/.test(value));

const rawRepositoryMetadataSchema = z.object({
  full_name: strictProviderString(300),
  name: strictProviderString(200),
  owner: z.object({ login: strictProviderString(100) }),
  default_branch: strictProviderString(255),
  private: z.boolean()
});

const providerText = (maxLength: number) => z.string()
  .min(1)
  .max(maxLength)
  .refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));

const rawPullRequestListItemSchema = z.object({
  number: z.number().int().positive().safe(),
  title: providerText(1_024),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  labels: z.array(z.object({
    name: providerText(100),
    color: providerText(100)
  })).max(100),
  user: z.object({ login: providerText(100) }).nullable(),
  base: z.object({ ref: providerText(255), sha: providerText(64) }),
  head: z.object({ ref: providerText(255), sha: providerText(64) }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  closed_at: z.string().datetime().nullable(),
  merged_at: z.string().datetime().nullable(),
  html_url: z.string().min(1).max(2_048)
}).superRefine((pullRequest, context) => {
  for (const message of pullRequestLifecycleErrors({
    state: pullRequest.state,
    createdAt: pullRequest.created_at,
    updatedAt: pullRequest.updated_at,
    closedAt: pullRequest.closed_at,
    mergedAt: pullRequest.merged_at
  })) {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  }
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

export type RepositoryMetadata = {
  readonly fullName: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly private: boolean;
};

export interface RepositoryMetadataClient {
  getRepository(input: RepositoryCoordinates): Promise<RepositoryMetadata>;
}

export type PullRequestSnapshot = {
  readonly baseSha: string;
  readonly headSha: string;
};

export type PullRequestListItem = {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly labels: readonly { readonly name: string; readonly color: string }[];
  readonly author: string | null;
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly mergedAt: string | null;
  readonly htmlUrl: string;
};

export type PullRequestListResult = {
  readonly items: readonly PullRequestListItem[];
  readonly truncated: boolean;
};

export type OctokitPullRequestListRequest = RepositoryCoordinates & {
  readonly state: "all";
  readonly sort: "created";
  readonly direction: "desc";
  readonly per_page: 100;
  readonly page: 1;
};

export type OctokitPullRequestLister = {
  readonly listPullRequests: (request: OctokitPullRequestListRequest) => Promise<{
    readonly data: unknown;
    readonly headers?: unknown;
  }>;
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

export type GitHubApiFailureKind = "rate_limited" | "not_found" | "access_denied" | "provider_unavailable";

function hasValidRetryAfter(value: string | undefined): boolean {
  if (value === undefined || value !== value.trim() || value === "") return false;
  if (/^\d+$/.test(value)) return true;
  if (!/^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === value;
}

export function classifyGitHubApiError(error: GitHubApiError): GitHubApiFailureKind {
  if (
    error.status === 429
    || (error.status === 403 && error.rateLimitRemaining === "0")
    || (error.status === 403 && hasValidRetryAfter(error.retryAfter))
  ) return "rate_limited";
  if (error.status === 404) return "not_found";
  if (error.status === 401 || error.status === 403) return "access_denied";
  return "provider_unavailable";
}

export function parseRepositoryMetadataPayload(payload: unknown): RepositoryMetadata {
  const parsed = rawRepositoryMetadataSchema.safeParse(payload);
  if (!parsed.success) throw new GitHubProviderPayloadError();
  const fullIdentity = parseGitHubRepositoryFullName(parsed.data.full_name);
  const componentIdentity = parseGitHubRepositoryFullName(
    `${parsed.data.owner.login}/${parsed.data.name}`
  );
  if (
    fullIdentity === null
    || componentIdentity === null
    || fullIdentity.fullName.toLowerCase() !== componentIdentity.fullName.toLowerCase()
  ) {
    throw new GitHubProviderPayloadError();
  }
  return {
    fullName: fullIdentity.fullName,
    name: componentIdentity.repo,
    defaultBranch: parsed.data.default_branch,
    private: parsed.data.private
  };
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function splitHeaderValues(value: string, delimiter: "," | ";"): string[] {
  const values: string[] = [];
  let start = 0;
  let quoted = false;
  let angleDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      let precedingBackslashes = 0;
      for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
        precedingBackslashes += 1;
      }
      if (precedingBackslashes % 2 === 0) quoted = !quoted;
    }
    if (!quoted && character === "<") angleDepth += 1;
    if (!quoted && character === ">" && angleDepth > 0) angleDepth -= 1;
    if (!quoted && angleDepth === 0 && character === delimiter) {
      values.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(value.slice(start).trim());
  return values.filter(Boolean);
}

export function hasNextLinkHeader(headers: unknown): boolean {
  const link = headerValue(headers, "link");
  if (link === undefined) return false;
  for (const linkValue of splitHeaderValues(link, ",")) {
    const parts = splitHeaderValues(linkValue, ";");
    if (!/^<[^<>]+>$/.test(parts[0] ?? "")) continue;
    for (const parameter of parts.slice(1)) {
      const match = /^([^=\s]+)\s*=\s*(.+)$/.exec(parameter);
      if (!match || match[1]?.toLowerCase() !== "rel") continue;
      const raw = match[2]?.trim() ?? "";
      const relation = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
      if (relation.split(/\s+/).some(token => token.toLowerCase() === "next")) return true;
    }
  }
  return false;
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
  listPullRequests(input: RepositoryCoordinates): Promise<PullRequestListResult>;
}

export function splitRepositoryFullName(repositoryFullName: string): { owner: string; repo: string } {
  const identity = parseGitHubRepositoryFullName(repositoryFullName);
  if (identity === null) throw new Error("repositoryFullName must use valid GitHub owner/repository coordinates");
  return { owner: identity.owner, repo: identity.repo };
}

export class OctokitPullRequestClient implements PullRequestClient, PullRequestListClient, RepositoryMetadataClient {
  private readonly octokit: Octokit;
  private readonly pullRequestLister: OctokitPullRequestLister;

  constructor(token?: string, pullRequestLister?: OctokitPullRequestLister) {
    this.octokit = new Octokit(token ? { auth: token } : {});
    this.pullRequestLister = pullRequestLister ?? {
      listPullRequests: request => this.octokit.rest.pulls.list(request)
    };
  }

  async getRepository(input: RepositoryCoordinates): Promise<RepositoryMetadata> {
    try {
      const response = await this.octokit.rest.repos.get({ owner: input.owner, repo: input.repo });
      return parseRepositoryMetadataPayload(response.data);
    } catch (error) {
      if (error instanceof GitHubProviderPayloadError) throw error;
      throw toGitHubApiError(error);
    }
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

  async listPullRequests(input: RepositoryCoordinates): Promise<PullRequestListResult> {
    let response: { readonly data: unknown; readonly headers?: unknown };
    try {
      response = await this.pullRequestLister.listPullRequests({
        owner: input.owner,
        repo: input.repo,
        state: "all",
        sort: "created",
        direction: "desc",
        per_page: 100,
        page: 1
      });
    } catch (error) {
      throw toGitHubApiError(error);
    }

    const parsed = z.array(rawPullRequestListItemSchema).max(100).safeParse(response.data);
    if (!parsed.success) throw new GitHubProviderPayloadError();
    const items = parsed.data.map(pullRequest => {
      if (!isCanonicalGitHubPullRequestUrl(
        pullRequest.html_url,
        pullRequest.number,
        `${input.owner}/${input.repo}`
      )) throw new GitHubProviderPayloadError();
      return {
        number: pullRequest.number,
        title: pullRequest.title,
        state: pullRequest.state,
        draft: pullRequest.draft,
        labels: pullRequest.labels.map(label => ({ name: label.name, color: label.color })),
        author: pullRequest.user?.login ?? null,
        baseRef: pullRequest.base.ref,
        headRef: pullRequest.head.ref,
        baseSha: pullRequest.base.sha,
        headSha: pullRequest.head.sha,
        createdAt: pullRequest.created_at,
        updatedAt: pullRequest.updated_at,
        closedAt: pullRequest.closed_at,
        mergedAt: pullRequest.merged_at,
        htmlUrl: pullRequest.html_url
      };
    });
    return {
      items,
      truncated: hasNextLinkHeader(response.headers)
    };
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
