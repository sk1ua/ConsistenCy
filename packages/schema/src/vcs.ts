import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const nonNegativeInt = z.number().int().nonnegative();

export const vcsProviderSchema = z.enum(["local_git", "github", "gitlab"]);

/**
 * Named revision for the uncommitted working tree.
 *
 * Git has no object id for uncommitted state, so a review of a dirty worktree
 * has no head SHA. This constant is used in that slot instead of inventing a
 * hex string that would look like a real commit.
 */
export const WORKING_TREE_REV = "WORKING_TREE";

/**
 * Git object id. Accepts abbreviated (>= 7) through full SHA-256 (64) ids so
 * the same schema covers `rev-parse --short` output and sha256-format repos.
 */
export const gitShaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{7,64}$/, "Expected a lowercase hex git object id (7-64 chars)");

export const fileChangeStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "type_changed"
]);

export const changeEventTypeSchema = z.enum([
  "WORKING_DIR_DIRTY",
  "COMMIT_PUSHED",
  "BRANCH_SWITCHED",
  "PR_SIMULATION"
]);

export const vcsActorSchema = z.object({
  name: nonEmpty,
  email: nonEmpty.optional()
}).strict();

/**
 * One unified-diff hunk. `oldStart`/`newStart` are 0 when the corresponding
 * side is empty (pure addition or deletion), so both are non-negative rather
 * than positive.
 */
export const diffHunkSchema = z.object({
  header: nonEmpty,
  oldStart: nonNegativeInt,
  oldLines: nonNegativeInt,
  newStart: nonNegativeInt,
  newLines: nonNegativeInt,
  content: z.string()
}).strict();

export const vcsChangedFileSchema = z.object({
  path: nonEmpty,
  previousPath: nonEmpty.optional(),
  status: fileChangeStatusSchema,
  additions: nonNegativeInt,
  deletions: nonNegativeInt,
  binary: z.boolean().default(false),
  hunks: z.array(diffHunkSchema).default([])
}).strict().superRefine((file, context) => {
  if ((file.status === "renamed" || file.status === "copied") && file.previousPath === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `status '${file.status}' requires previousPath`,
      path: ["previousPath"]
    });
  }
  if (file.binary && file.hunks.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Binary files must not carry text hunks",
      path: ["hunks"]
    });
  }
});

/**
 * Identifies the repository a change event came from. `branch` is absent on a
 * detached HEAD and `headSha` is absent in a repository with no commits yet.
 */
export const repoRefSchema = z.object({
  root: nonEmpty,
  provider: vcsProviderSchema.default("local_git"),
  branch: nonEmpty.optional(),
  headSha: gitShaSchema.optional()
}).strict();

const changeEventBase = {
  eventId: nonEmpty,
  repository: repoRefSchema,
  detectedAt: z.string().datetime(),
  changedFiles: z.array(vcsChangedFileSchema).default([]),
  /** Cheap pre-analysis triage signal, 0..1, matching the engine risk scale. */
  impactScoreHint: z.number().min(0).max(1).optional()
};

export const workingDirDirtyEventSchema = z.object({
  ...changeEventBase,
  type: z.literal("WORKING_DIR_DIRTY"),
  baseSha: gitShaSchema.optional(),
  untrackedFiles: z.array(nonEmpty).default([])
}).strict();

export const commitPushedEventSchema = z.object({
  ...changeEventBase,
  type: z.literal("COMMIT_PUSHED"),
  sha: gitShaSchema,
  parentShas: z.array(gitShaSchema).default([]),
  author: vcsActorSchema,
  authoredAt: z.string().datetime(),
  message: z.string()
}).strict();

export const branchSwitchedEventSchema = z.object({
  ...changeEventBase,
  type: z.literal("BRANCH_SWITCHED"),
  fromBranch: nonEmpty.optional(),
  toBranch: nonEmpty,
  fromSha: gitShaSchema.optional(),
  toSha: gitShaSchema
}).strict();

export const prSimulationEventSchema = z.object({
  ...changeEventBase,
  type: z.literal("PR_SIMULATION"),
  baseRef: nonEmpty,
  headRef: nonEmpty,
  baseSha: gitShaSchema,
  headSha: gitShaSchema
}).strict();

export const codeChangeEventSchema = z.discriminatedUnion("type", [
  workingDirDirtyEventSchema,
  commitPushedEventSchema,
  branchSwitchedEventSchema,
  prSimulationEventSchema
]).superRefine((event, context) => {
  if (event.type === "PR_SIMULATION" && event.baseSha === event.headSha) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "PR_SIMULATION requires baseSha and headSha to differ",
      path: ["headSha"]
    });
  }
});

export const vcsCommitSummarySchema = z.object({
  sha: gitShaSchema,
  parentShas: z.array(gitShaSchema),
  author: vcsActorSchema,
  authoredAt: z.string().datetime(),
  message: z.string()
}).strict();

export const vcsFileTreeEntrySchema = z.object({
  path: nonEmpty,
  type: z.enum(["blob", "tree"]),
  sha: gitShaSchema,
  size: nonNegativeInt.optional()
}).strict();

export type VcsProvider = z.infer<typeof vcsProviderSchema>;
export type GitSha = z.infer<typeof gitShaSchema>;
export type FileChangeStatus = z.infer<typeof fileChangeStatusSchema>;
export type ChangeEventType = z.infer<typeof changeEventTypeSchema>;
export type VcsActor = z.infer<typeof vcsActorSchema>;
export type DiffHunk = z.infer<typeof diffHunkSchema>;
export type VcsChangedFile = z.infer<typeof vcsChangedFileSchema>;
export type RepoRef = z.infer<typeof repoRefSchema>;
export type WorkingDirDirtyEvent = z.infer<typeof workingDirDirtyEventSchema>;
export type CommitPushedEvent = z.infer<typeof commitPushedEventSchema>;
export type BranchSwitchedEvent = z.infer<typeof branchSwitchedEventSchema>;
export type PrSimulationEvent = z.infer<typeof prSimulationEventSchema>;
export type CodeChangeEvent = z.infer<typeof codeChangeEventSchema>;
export type VcsCommitSummary = z.infer<typeof vcsCommitSummarySchema>;
export type VcsFileTreeEntry = z.infer<typeof vcsFileTreeEntrySchema>;

/**
 * Provider-neutral read surface consumed by the review pipeline. Implementations
 * are read-only by contract: nothing here mutates the working tree, so an
 * adapter can be pointed at a developer's live checkout without risk.
 */
export interface IVCSService {
  readonly provider: VcsProvider;
  /** Uncommitted tracked changes (staged and unstaged) against HEAD. */
  getWorkingDiff(): Promise<VcsChangedFile[]>;
  getBranchDiff(base: string, head: string): Promise<VcsChangedFile[]>;
  getCommitHistory(depth: number): Promise<VcsCommitSummary[]>;
  getUntrackedFiles(): Promise<string[]>;
  getFileTreeAtCommit(sha: string): Promise<VcsFileTreeEntry[]>;
}
