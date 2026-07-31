import { z } from "zod";

const nonEmpty = z.string().trim().min(1);

export const changedFileSchema = z.object({
  path: nonEmpty,
  status: nonEmpty,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  patch: z.string().optional()
}).strict();

export const prReviewContextSchema = z.object({
  jobId: nonEmpty,
  repositoryFullName: nonEmpty,
  pullRequestNumber: z.number().int().positive(),
  baseSha: nonEmpty,
  headSha: nonEmpty,
  changedFiles: z.array(changedFileSchema),
  diff: z.string(),
  fileContents: z.record(z.string()),
  baseFileContents: z.record(z.string()),
  projectMetadata: z.record(z.string()),
  workspacePath: nonEmpty
}).strict();

export type ChangedFile = z.infer<typeof changedFileSchema>;
export type PRReviewContext = z.infer<typeof prReviewContextSchema>;
