import { z } from "zod";
import { reviewJobSchema } from "./job";
import { notebookCardKindSchema, notebookSchema, notebookSourceSchema } from "./notebook";
import { reviewReportSchema, riskLevelSchema } from "./report";
import { workflowSpecSchema } from "./workflow";
import { vcsChangedFileSchema, vcsCommitSummarySchema } from "./vcs";

export const jobListResponseSchema = z.object({ jobs: z.array(reviewJobSchema) }).strict();
export const jobDetailResponseSchema = z.object({ job: reviewJobSchema }).strict();
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
  repoPath: z.string().trim().min(1).max(4_096),
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
  url: z.string().trim().min(1),
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

export const repositoryCommitsResponseSchema = z.object({
  repositoryId: z.string().trim().min(1),
  commits: z.array(vcsCommitSummarySchema)
}).strict();

export const pullRequestSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string().trim().min(1),
  state: z.enum(["open", "closed", "merged"]),
  author: z.string().trim().min(1),
  baseRef: z.string().trim().min(1),
  headRef: z.string().trim().min(1),
  baseSha: z.string().trim().min(1),
  headSha: z.string().trim().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  mergedAt: z.string().datetime().optional(),
  reviewStatus: z.enum(["succeeded", "running", "failed", "unreviewed"]).optional(),
  score: z.number().optional(),
  riskLevel: riskLevelSchema.optional(),
  jobId: z.string().optional()
}).strict();

export const repositoryPullRequestsResponseSchema = z.object({
  repositoryId: z.string().trim().min(1),
  available: z.boolean(),
  reason: z.string().optional(),
  pullRequests: z.array(pullRequestSummarySchema)
}).strict();

export type GitRemoteInfo = z.infer<typeof gitRemoteInfoSchema>;
export type RepositoryGitStatusResponse = z.infer<typeof repositoryGitStatusResponseSchema>;
export type RepositoryCommitsResponse = z.infer<typeof repositoryCommitsResponseSchema>;
export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;
export type RepositoryPullRequestsResponse = z.infer<typeof repositoryPullRequestsResponseSchema>;

export type JobListResponse = z.infer<typeof jobListResponseSchema>;
export type JobDetailResponse = z.infer<typeof jobDetailResponseSchema>;
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
