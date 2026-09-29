import { z } from "zod";
import { vcsChangedFileSchema } from "./vcs";

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

/**
 * Review-time capture of a working-tree review's change surface (audit P1-01).
 * Working-tree reviews have no head commit to pin, so the exact `VcsChangedFile`
 * set the review analyzed is persisted at context-capture time; every later
 * diff/evidence view resolves from this record instead of re-reading the live
 * checkout, keeping report, diff, and evidence references stable across
 * working-tree drift and API restarts.
 */
export const reviewSnapshotSchema = z.object({
  jobId: nonEmpty,
  /** HEAD at context-capture time — the identity the diff was built against. */
  baseSha: nonEmpty,
  /** The symbolic working-tree revision the job was enqueued with. */
  headSha: nonEmpty,
  files: z.array(vcsChangedFileSchema),
  /**
   * Review-time content of changed (non-removed) files, already loader-redacted
   * and secret-path-free (audit P1-06③: Notebook reads resolve review-time
   * content for these instead of re-reading the live checkout). Optional:
   * snapshots persisted before this field existed carry none.
   */
  fileContents: z.record(z.string()).optional(),
  /**
   * Review-time baselines for changed files (audit P1-06③ getBaseFile).
   * Optional: snapshots from before this field carry none.
   */
  baseFileContents: z.record(z.string()).optional(),
  capturedAt: nonEmpty
}).strict();

export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;
