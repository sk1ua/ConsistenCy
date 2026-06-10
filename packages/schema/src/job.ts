import { z } from "zod";
import { reviewReportSchema } from "./report";

export const jobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const jobTypeSchema = z.literal("PR_REVIEW");

export const reviewJobSchema = z.object({
  id: z.string().trim().min(1),
  type: jobTypeSchema,
  status: jobStatusSchema,
  repositoryFullName: z.string().trim().min(1),
  pullRequestNumber: z.number().int().positive(),
  installationId: z.number().int().positive().optional(),
  baseSha: z.string().trim().min(1),
  headSha: z.string().trim().min(1),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  error: z.string().trim().min(1).optional(),
  report: reviewReportSchema.optional()
}).strict();

export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobType = z.infer<typeof jobTypeSchema>;
export type ReviewJob = z.infer<typeof reviewJobSchema>;

