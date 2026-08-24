import { z } from "zod";
import { reviewJobSchema } from "./job";
import { notebookCardKindSchema, notebookSchema, notebookSourceSchema } from "./notebook";
import { reviewReportSchema, riskLevelSchema } from "./report";
import { workflowSpecSchema } from "./workflow";
import { vcsChangedFileSchema, vcsCommitSummarySchema } from "./vcs";

export const jobListResponseSchema = z.object({ jobs: z.array(reviewJobSchema) }).strict();
export const jobDetailResponseSchema = z.object({ job: reviewJobSchema }).strict();
export const REPOSITORY_REVIEWS_MAX_LIMIT = 200;
export const repositoryReviewsResponseSchema = z.object({
  repositoryId: z.string().trim().min(1).max(255),
  reviews: z.array(reviewJobSchema).max(REPOSITORY_REVIEWS_MAX_LIMIT)
}).strict().superRefine((response, context) => {
  response.reviews.forEach((review, index) => {
    if (review.repositoryId !== response.repositoryId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviews", index, "repositoryId"],
        message: "repository review must match the canonical opaque repository identifier"
      });
    }
  });
});
export const reportResponseSchema = z.object({ report: reviewReportSchema }).strict();
export const recentReportsResponseSchema = z.object({ reports: z.array(reviewReportSchema) }).strict();
export const statsResponseSchema = z.object({
  totalJobs: z.number().int().nonnegative(),
  succeededJobs: z.number().int().nonnegative(),
  failedJobs: z.number().int().nonnegative(),
  runningJobs: z.number().int().nonnegative(),
  averageDuration: z.number().nonnegative(),
  riskDistribution: z.record(riskLevelSchema, z.number().int().nonnegative()),
  topRepositories: z.array(z.object({
    repositoryFullName: z.string().trim().min(1),
    jobCount: z.number().int().positive()
  }).strict())
}).strict();
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    details: z.record(z.unknown()).optional()
  }).strict()
}).strict();

export const reviewModelOverrideSchema = z.object({
  provider: z.enum(["deepseek", "openai"]).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(100).optional()
}).strict();

export type ReviewModelOverride = z.infer<typeof reviewModelOverrideSchema>;

export const publicPrRequestSchema = z.object({
  url: z.string().trim().min(1).max(2_048),
  model: reviewModelOverrideSchema.optional(),
  llm: reviewModelOverrideSchema.optional()
}).strict();

export const localReviewRequestSchema = z.object({
  repositoryId: z.string().trim().min(1).max(255),
  baseRef: z.string().trim().min(1).max(255).optional(),
  headRef: z.string().trim().min(1).max(255).optional(),
  model: reviewModelOverrideSchema.optional(),
  llm: reviewModelOverrideSchema.optional()
}).strict();

export const localReviewResponseSchema = z.object({
  jobId: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  baseSha: z.string().trim().min(1),
  headSha: z.string().trim().min(1),
  publicationPolicy: z.literal("disabled"),
  llmProvider: z.enum(["deepseek", "openai"]).optional(),
  llmModel: z.string().trim().min(1).optional(),
  status: z.literal("queued")
}).strict();
export const publicPrResponseSchema = z.object({
  jobId: z.string().trim().min(1),
  notebookId: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  pullRequestNumber: z.number().int().positive(),
  baseSha: z.string().trim().min(1),
  headSha: z.string().trim().min(1),
  publicationPolicy: z.literal("disabled"),
  llmProvider: z.enum(["deepseek", "openai"]).optional(),
  llmModel: z.string().trim().min(1).optional(),
  status: z.literal("queued")
}).strict();

export const notebookResponseSchema = z.object({ notebook: notebookSchema }).strict();
export const notebookSourcesResponseSchema = z.object({ sources: z.array(notebookSourceSchema) }).strict();
export const notebookMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  sourceJobIds: z.array(z.string().trim().min(1)).max(20).optional()
}).strict();
export const notebookCardRequestSchema = z.object({
  kind: notebookCardKindSchema,
  sourceJobIds: z.array(z.string().trim().min(1)).min(1).max(20)
}).strict();

export const workflowSourceSchema = z.enum(["builtin", "draft"]);
export const workflowSummarySchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  source: workflowSourceSchema,
  nodeCount: z.number().int().nonnegative(),
  verifierCount: z.number().int().nonnegative()
}).strict();
export const workflowListResponseSchema = z.object({
  workflows: z.array(workflowSummarySchema)
}).strict();
export const workflowResponseSchema = z.object({
  workflow: workflowSpecSchema,
  source: workflowSourceSchema
}).strict();
/** PUT body for saving a workflow draft; the route name must equal `name`. */
export const saveWorkflowRequestSchema = workflowSpecSchema;

export const jobDiffResponseSchema = z.object({
  jobId: z.string().trim().min(1),
  files: z.array(vcsChangedFileSchema),
  /** False when the checkout is gone and no diff can be computed. */
  available: z.boolean()
}).strict();

export const gitRemoteInfoSchema = z.object({
  name: z.string().trim().min(1),
  githubFullName: z.string().optional()
}).strict();

export const repositoryGitStatusResponseSchema = z.object({
  repositoryId: z.string().trim().min(1),
  available: z.boolean().optional(),
  reason: z.string().optional(),
  branch: z.string().nullable().optional(),
  headSha: z.string().nullable().optional(),
  dirtyFileCount: z.number().int().nonnegative(),
  untrackedFileCount: z.number().int().nonnegative(),
  changedFiles: z.array(vcsChangedFileSchema),
  untrackedFiles: z.array(z.string()),
  remotes: z.array(gitRemoteInfoSchema),
  primaryRemote: gitRemoteInfoSchema.optional()
}).strict();

const repositoryCommitsAvailableResponseSchema = z.object({
  repositoryId: z.string().trim().min(1),
  available: z.literal(true),
  commits: z.array(vcsCommitSummarySchema)
}).strict();

const repositoryCommitsUnavailableResponseSchema = z.object({
  repositoryId: z.string().trim().min(1),
  available: z.literal(false),
  reason: z.string().trim().min(1),
  commits: z.array(vcsCommitSummarySchema).length(0)
}).strict();

export const repositoryCommitsResponseSchema = z.discriminatedUnion("available", [
  repositoryCommitsAvailableResponseSchema,
  repositoryCommitsUnavailableResponseSchema
]);

const providerTextSchema = (maxLength: number) => z.string()
  .min(1)
  .max(maxLength)
  .refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), {
    message: "provider text must be clean and unmodified"
  });

export type GitHubRepositoryIdentity = {
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
};

export function parseGitHubRepositoryFullName(value: string): GitHubRepositoryIdentity | null {
  if (value !== value.trim() || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!;
  if (owner.length < 1 || owner.length > 39) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) return null;
  if (repo.length < 1 || repo.length > 100) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(repo) || /^\.+$/.test(repo)) return null;
  return { owner, repo, fullName: `${owner}/${repo}` };
}

export function parseCanonicalGitHubRepositoryUrl(value: string): GitHubRepositoryIdentity | null {
  if (
    value !== value.trim()
    || value.includes("%")
    || value.includes("\\")
    || /[\s\u0000-\u001f\u007f]/.test(value)
    || !value.startsWith("https://github.com/")
  ) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.hostname !== "github.com"
      || url.username !== ""
      || url.password !== ""
      || url.port !== ""
      || url.search !== ""
      || url.hash !== ""
    ) return null;
    const match = /^\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!match) return null;
    const identity = parseGitHubRepositoryFullName(`${match[1]}/${match[2]}`);
    if (identity === null) return null;
    return value === `https://github.com/${identity.fullName}` ? identity : null;
  } catch {
    return null;
  }
}

export type CanonicalGitHubPullRequestUrl = GitHubRepositoryIdentity & {
  readonly pullRequestNumber: number;
};

export function parseCanonicalGitHubPullRequestUrl(value: string): CanonicalGitHubPullRequestUrl | null {
  if (
    value !== value.trim()
    || value.includes("%")
    || value.includes("\\")
    || /[\s\u0000-\u001f\u007f]/.test(value)
    || !value.startsWith("https://github.com/")
  ) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.hostname !== "github.com"
      || url.username !== ""
      || url.password !== ""
      || url.port !== ""
      || url.search !== ""
      || url.hash !== ""
    ) return null;
    const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/.exec(url.pathname);
    if (!match) return null;
    const identity = parseGitHubRepositoryFullName(`${match[1]}/${match[2]}`);
    if (identity === null) return null;
    const pullRequestNumber = Number(match[3]);
    if (
      !Number.isSafeInteger(pullRequestNumber)
      || pullRequestNumber <= 0
      || match[3] !== String(pullRequestNumber)
    ) return null;
    const canonical = `https://github.com/${identity.fullName}/pull/${pullRequestNumber}`;
    return value === canonical ? { ...identity, pullRequestNumber } : null;
  } catch {
    return null;
  }
}

export function isCanonicalGitHubPullRequestUrl(
  value: string,
  pullRequestNumber?: number,
  repositoryFullName?: string
): boolean {
  const parsed = parseCanonicalGitHubPullRequestUrl(value);
  if (parsed === null) return false;
  if (pullRequestNumber !== undefined && parsed.pullRequestNumber !== pullRequestNumber) return false;
  if (repositoryFullName === undefined) return true;
  const expectedIdentity = parseGitHubRepositoryFullName(repositoryFullName);
  return expectedIdentity !== null
    && parsed.fullName.toLowerCase() === expectedIdentity.fullName.toLowerCase();
}

export function pullRequestLifecycleErrors(input: {
  readonly state: "open" | "closed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly mergedAt: string | null;
}): string[] {
  const errors: string[] = [];
  const createdAt = Date.parse(input.createdAt);
  const updatedAt = Date.parse(input.updatedAt);
  const closedAt = input.closedAt === null ? undefined : Date.parse(input.closedAt);
  const mergedAt = input.mergedAt === null ? undefined : Date.parse(input.mergedAt);
  if (input.state === "open" && (closedAt !== undefined || mergedAt !== undefined)) {
    errors.push("open pull request must not have closed or merged timestamps");
  }
  if (input.state === "closed" && closedAt === undefined) {
    errors.push("closed pull request must have a closed timestamp");
  }
  if (updatedAt < createdAt || (closedAt !== undefined && closedAt < createdAt) || (mergedAt !== undefined && mergedAt < createdAt)) {
    errors.push("pull request lifecycle timestamps must not predate creation");
  }
  if (mergedAt !== undefined && (closedAt === undefined || mergedAt > closedAt)) {
    errors.push("merged timestamp must not follow the closed timestamp");
  }
  if ((closedAt !== undefined && updatedAt < closedAt) || (mergedAt !== undefined && updatedAt < mergedAt)) {
    errors.push("pull request update timestamp must not predate closure or merge");
  }
  return errors;
}

const safePullRequestUrlSchema = z.string().url().max(2_048).refine(
  value => isCanonicalGitHubPullRequestUrl(value),
  { message: "pull request URL must be a canonical github.com pull URL" }
);

const githubRepositoryFullNameSchema = providerTextSchema(140).refine(
  value => parseGitHubRepositoryFullName(value) !== null,
  { message: "repository identity must use canonical GitHub owner/repository coordinates" }
);

export const pullRequestSummarySchema = z.object({
  provider: z.literal("github"),
  number: z.number().int().positive().safe(),
  title: providerTextSchema(1_024),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  labels: z.array(z.object({
    name: providerTextSchema(100),
    color: providerTextSchema(100)
  }).strict()).max(100),
  author: providerTextSchema(100).nullable(),
  baseRef: providerTextSchema(255),
  headRef: providerTextSchema(255),
  baseSha: providerTextSchema(64),
  headSha: providerTextSchema(64),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  mergedAt: z.string().datetime().nullable(),
  htmlUrl: safePullRequestUrlSchema,
  latestReview: z.object({
    jobId: z.string().trim().min(1),
    status: z.enum(["queued", "running", "awaiting_publish", "publishing", "succeeded", "failed", "publish_failed", "cancelled"]),
    score: z.number().optional(),
    riskLevel: riskLevelSchema.optional(),
    createdAt: z.string().datetime()
  }).strict().optional()
}).strict().superRefine((pullRequest, context) => {
  if (!isCanonicalGitHubPullRequestUrl(pullRequest.htmlUrl, pullRequest.number)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["htmlUrl"], message: "pull request URL number mismatch" });
  }
  for (const message of pullRequestLifecycleErrors(pullRequest)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  }
});

export const repositoryPullRequestsUnavailableReasonCodeSchema = z.enum([
  "not_github",
  "identity_unavailable",
  "not_found",
  "access_denied",
  "rate_limited",
  "provider_unavailable",
  "invalid_provider_data"
]);

const repositoryPullRequestsAvailableResponseSchema = z.object({
  repositoryId: z.string().trim().min(1),
  repositoryFullName: githubRepositoryFullNameSchema,
  available: z.literal(true),
  page: z.object({
    limit: z.literal(100),
    truncated: z.boolean()
  }).strict(),
  pullRequests: z.array(pullRequestSummarySchema).max(100)
}).strict();

const repositoryPullRequestsUnavailableResponseSchema = z.object({
  repositoryId: z.string().trim().min(1),
  available: z.literal(false),
  reasonCode: repositoryPullRequestsUnavailableReasonCodeSchema,
  reason: providerTextSchema(255),
  pullRequests: z.array(pullRequestSummarySchema).length(0)
}).strict();

export const repositoryPullRequestsResponseSchema = z.discriminatedUnion("available", [
  repositoryPullRequestsAvailableResponseSchema,
  repositoryPullRequestsUnavailableResponseSchema
]).superRefine((response, context) => {
  if (!response.available) return;
  response.pullRequests.forEach((pullRequest, index) => {
    if (!isCanonicalGitHubPullRequestUrl(pullRequest.htmlUrl, pullRequest.number, response.repositoryFullName)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pullRequests", index, "htmlUrl"],
        message: "pull request URL repository identity mismatch"
      });
    }
  });
});

export const reviewPreparationSourceWorkingTreeSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  changedFileCount: z.number().int().nonnegative()
}).strict();

export const reviewPreparationSourceBranchSchema = z.object({
  available: z.boolean(),
  base: z.string().optional(),
  head: z.string().optional(),
  reason: z.string().optional()
}).strict();

export const reviewPreparationSourcePullRequestSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  pullRequestCount: z.number().int().nonnegative().optional()
}).strict();

export const reviewPreparationModelProviderSchema = z.object({
  configured: z.boolean(),
  defaultModel: z.string().optional()
}).strict();

export const reviewPreparationModelSchema = z.object({
  default: z.object({
    provider: z.enum(["deepseek", "openai", "none"]),
    model: z.string()
  }).strict(),
  providers: z.object({
    deepseek: reviewPreparationModelProviderSchema,
    openai: reviewPreparationModelProviderSchema
  }).strict(),
  pendingRestart: z.object({
    provider: z.enum(["deepseek", "openai"]),
    model: z.string().trim().min(1),
    credentialConfigured: z.boolean()
  }).strict().nullable()
}).strict();

export const reviewPreparationRepositorySchema = z.object({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  sourceKind: z.enum(["local_git", "github", "gitlab"]),
  trust: z.enum(["trusted_local", "untrusted_readonly"])
}).strict();

export const reviewPreparationResponseSchema = z.object({
  repository: reviewPreparationRepositorySchema,
  sources: z.object({
    workingTree: reviewPreparationSourceWorkingTreeSchema,
    branch: reviewPreparationSourceBranchSchema,
    pullRequest: reviewPreparationSourcePullRequestSchema.optional()
  }).strict(),
  model: reviewPreparationModelSchema,
  canStartReview: z.boolean(),
  blockingReasons: z.array(z.string())
}).strict();

export type GitRemoteInfo = z.infer<typeof gitRemoteInfoSchema>;
export type RepositoryGitStatusResponse = z.infer<typeof repositoryGitStatusResponseSchema>;
export type RepositoryCommitsResponse = z.infer<typeof repositoryCommitsResponseSchema>;
export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;
export type RepositoryPullRequestsUnavailableReasonCode = z.infer<typeof repositoryPullRequestsUnavailableReasonCodeSchema>;
export type RepositoryPullRequestsResponse = z.infer<typeof repositoryPullRequestsResponseSchema>;
export type ReviewPreparationResponse = z.infer<typeof reviewPreparationResponseSchema>;

export type JobListResponse = z.infer<typeof jobListResponseSchema>;
export type JobDetailResponse = z.infer<typeof jobDetailResponseSchema>;
export type RepositoryReviewsResponse = z.infer<typeof repositoryReviewsResponseSchema>;
export type ReportResponse = z.infer<typeof reportResponseSchema>;
export type RecentReportsResponse = z.infer<typeof recentReportsResponseSchema>;
export type StatsResponse = z.infer<typeof statsResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type PublicPrRequest = z.infer<typeof publicPrRequestSchema>;
export type PublicPrResponse = z.infer<typeof publicPrResponseSchema>;
export type LocalReviewRequest = z.infer<typeof localReviewRequestSchema>;
export type LocalReviewResponse = z.infer<typeof localReviewResponseSchema>;
export type NotebookMessageRequest = z.infer<typeof notebookMessageRequestSchema>;
export type NotebookCardRequest = z.infer<typeof notebookCardRequestSchema>;
export type WorkflowSource = z.infer<typeof workflowSourceSchema>;
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;
export type WorkflowListResponse = z.infer<typeof workflowListResponseSchema>;
export type WorkflowResponse = z.infer<typeof workflowResponseSchema>;
export type JobDiffResponse = z.infer<typeof jobDiffResponseSchema>;
