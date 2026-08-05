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

export const reviewSourceSchema = z.enum(["github_pr", "local_git"]);

export const prReviewContextSchema = z.object({
  jobId: nonEmpty,
  /** Defaults to github_pr so existing GitHub callers are unaffected. */
  source: reviewSourceSchema.default("github_pr"),
  /** `owner/repo` for GitHub; a display name for a local checkout. */
  repositoryFullName: nonEmpty,
  pullRequestNumber: z.number().int().positive().optional(),
  baseSha: nonEmpty,
  headSha: nonEmpty,
  changedFiles: z.array(changedFileSchema),
  diff: z.string(),
  fileContents: z.record(z.string()),
  baseFileContents: z.record(z.string()),
  projectMetadata: z.record(z.string()),
  workspacePath: nonEmpty
}).strict().superRefine((context, issues) => {
  if (context.source === "github_pr" && context.pullRequestNumber === undefined) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A github_pr context requires pullRequestNumber",
      path: ["pullRequestNumber"]
    });
  }
});

export type ChangedFile = z.infer<typeof changedFileSchema>;
export type ReviewSource = z.infer<typeof reviewSourceSchema>;
export type PRReviewContext = z.infer<typeof prReviewContextSchema>;
