import { z } from "zod";
import { reviewJobSchema } from "./job";
import { reviewReportSchema, riskLevelSchema } from "./report";

export const jobListResponseSchema = z.object({ jobs: z.array(reviewJobSchema) }).strict();
export const jobDetailResponseSchema = z.object({ job: reviewJobSchema }).strict();
export const reportResponseSchema = z.object({ report: reviewReportSchema }).strict();
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

export type JobListResponse = z.infer<typeof jobListResponseSchema>;
export type JobDetailResponse = z.infer<typeof jobDetailResponseSchema>;
export type ReportResponse = z.infer<typeof reportResponseSchema>;
export type StatsResponse = z.infer<typeof statsResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

