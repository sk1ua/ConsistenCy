import { z } from "zod";
import { reviewJobSchema } from "./job";
import { notebookCardKindSchema, notebookSchema, notebookSourceSchema } from "./notebook";
import { reviewReportSchema, riskLevelSchema } from "./report";

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

export const publicPrRequestSchema = z.object({ url: z.string().trim().min(1).max(2_048) }).strict();
export const publicPrResponseSchema = z.object({
  jobId: z.string().trim().min(1),
  notebookId: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  pullRequestNumber: z.number().int().positive(),
  baseSha: z.string().trim().min(1),
  headSha: z.string().trim().min(1),
  publicationPolicy: z.literal("disabled"),
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

export type JobListResponse = z.infer<typeof jobListResponseSchema>;
export type JobDetailResponse = z.infer<typeof jobDetailResponseSchema>;
export type ReportResponse = z.infer<typeof reportResponseSchema>;
export type RecentReportsResponse = z.infer<typeof recentReportsResponseSchema>;
export type StatsResponse = z.infer<typeof statsResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type PublicPrRequest = z.infer<typeof publicPrRequestSchema>;
export type PublicPrResponse = z.infer<typeof publicPrResponseSchema>;
export type NotebookMessageRequest = z.infer<typeof notebookMessageRequestSchema>;
export type NotebookCardRequest = z.infer<typeof notebookCardRequestSchema>;
