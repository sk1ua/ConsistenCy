import { z } from "zod";
import { reviewReportSchema } from "./report";

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_publish",
  "publishing",
  "succeeded",
  "failed",
  "publish_failed",
  "cancelled"
]);

export const publishOutboxStatusSchema = z.enum([
  "pending",
  "leased",
  "retrying",
  "published",
  "failed",
  "skipped"
]);

export const jobTypeSchema = z.literal("PR_REVIEW");
export const publicationPolicySchema = z.enum(["github_comment", "disabled"]);
export const reviewAccessModeSchema = z.enum(["github_app", "public_read", "local_git"]);

export const reviewJobSchema = z.object({
  id: z.string().trim().min(1),
  type: jobTypeSchema,
  status: jobStatusSchema,
  repositoryFullName: z.string().trim().min(1),
  /** Absent for local reviews, which have no pull request. */
  pullRequestNumber: z.number().int().positive().optional(),
  /** Absolute path to the checkout; set only for local reviews. */
  repoPath: z.string().trim().min(1).optional(),
  installationId: z.number().int().positive().optional(),
  accessMode: reviewAccessModeSchema.default("github_app"),
  baseSha: z.string().trim().min(1),
  headSha: z.string().trim().min(1),
  publicationPolicy: publicationPolicySchema.default("github_comment"),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  error: z.string().trim().min(1).optional(),
  report: reviewReportSchema.optional()
}).strict().superRefine((job, issues) => {
  if (job.accessMode === "local_git") {
    if (job.repoPath === undefined) {
      issues.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A local_git job requires repoPath",
        path: ["repoPath"]
      });
    }
    if (job.publicationPolicy !== "disabled") {
      issues.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A local_git job must not publish to GitHub",
        path: ["publicationPolicy"]
      });
    }
    return;
  }
  if (job.pullRequestNumber === undefined) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: `A ${job.accessMode} job requires pullRequestNumber`,
      path: ["pullRequestNumber"]
    });
  }
});

export const publishOutboxItemSchema = z.object({
  id: z.string().trim().min(1),
  jobId: z.string().trim().min(1),
  target: z.string().trim().min(1),
  status: publishOutboxStatusSchema,
  attemptCount: z.number().int().min(0),
  leaseOwner: z.string().nullable().optional(),
  leaseExpiresAt: z.string().nullable().optional(),
  leaseGeneration: z.number().int().nonnegative(),
  nextAttemptAt: z.string().nullable(),
  lastError: z.string().nullable().optional(),
  externalId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
}).strict();

export type JobStatus = z.infer<typeof jobStatusSchema>;
export type PublishOutboxStatus = z.infer<typeof publishOutboxStatusSchema>;
export type JobType = z.infer<typeof jobTypeSchema>;
export type PublicationPolicy = z.infer<typeof publicationPolicySchema>;
export type ReviewAccessMode = z.infer<typeof reviewAccessModeSchema>;
export type ReviewJob = z.infer<typeof reviewJobSchema>;
export type PublishOutboxItem = z.infer<typeof publishOutboxItemSchema>;
