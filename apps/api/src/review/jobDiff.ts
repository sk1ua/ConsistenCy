import { existsSync } from "node:fs";
import { WORKING_TREE_REV, type IVCSService, type VcsChangedFile } from "@consistency/schema";
import { LocalGitAdapter } from "@consistency/vcs-core";
import { workspacePathForJob } from "../github/clone";
import type { ReviewJobStore } from "../jobQueue";

export const MAX_DIFF_FILES = 500;
export const MAX_DIFF_BYTES = 20 * 1024 * 1024;

export class JobDiffError extends Error {
  constructor(message: string, public readonly code: string, public readonly statusCode: number) {
    super(message);
    this.name = "JobDiffError";
  }
}

export type JobDiffDependencies = {
  jobs: ReviewJobStore;
  workspaceRoot: string;
  vcsFactory?: (root: string) => IVCSService;
};

export type JobDiffResult = {
  files: VcsChangedFile[];
  available: boolean;
};

/**
 * Computes the diff snapshot for a job on demand.
 *
 * Local jobs diff the live checkout via `repoPath`; public/GitHub App jobs
 * diff the cloned analysis workspace. No database migration is needed, but a
 * workspace that has been cleaned up yields a 404 and the UI hides the tab.
 */
export async function resolveJobDiff(
  jobId: string,
  dependencies: JobDiffDependencies
): Promise<JobDiffResult> {
  const job = dependencies.jobs.get(jobId);
  if (!job) throw new JobDiffError("Job not found", "JOB_NOT_FOUND", 404);

  try {
    let files: VcsChangedFile[];
    if (job.accessMode === "local_git") {
      if (!job.repoPath) throw new JobDiffError("Local job is missing repoPath", "JOB_DIFF_UNAVAILABLE", 404);
      if (!job.baseSha) throw new JobDiffError("Local job is missing revision metadata", "JOB_DIFF_UNAVAILABLE", 404);
      const vcs = dependencies.vcsFactory?.(job.repoPath) ?? new LocalGitAdapter({ root: job.repoPath });
      files = job.headSha === WORKING_TREE_REV
        ? await vcs.getWorkingDiff()
        : await vcs.getBranchDiff(job.baseSha, job.headSha ?? "");
    } else {
      const root = workspacePathForJob(dependencies.workspaceRoot, job.id);
      if (!existsSync(root)) {
        return { files: [], available: false };
      }
      if (!job.baseSha || !job.headSha) {
        throw new JobDiffError("Job is missing revision metadata", "JOB_DIFF_UNAVAILABLE", 404);
      }
      const vcs = dependencies.vcsFactory?.(root) ?? new LocalGitAdapter({ root });
      files = await vcs.getBranchDiff(job.baseSha, job.headSha);
    }

    if (files.length > MAX_DIFF_FILES) {
      throw new JobDiffError(`Diff exceeds ${MAX_DIFF_FILES} files`, "DIFF_TOO_LARGE", 413);
    }
    const bytes = files.reduce((sum, file) =>
      sum + file.hunks.reduce((hunkSum, hunk) =>
        hunkSum + Buffer.byteLength(hunk.header, "utf8") + Buffer.byteLength(hunk.content, "utf8"), 0), 0);
    if (bytes > MAX_DIFF_BYTES) {
      throw new JobDiffError(`Diff exceeds ${MAX_DIFF_BYTES} bytes`, "DIFF_TOO_LARGE", 413);
    }
    return { files, available: true };
  } catch (error) {
    if (error instanceof JobDiffError) throw error;
    throw new JobDiffError(
      `Could not read repository diff: ${error instanceof Error ? error.message : "unknown error"}`,
      "DIFF_UNAVAILABLE",
      422
    );
  }
}
