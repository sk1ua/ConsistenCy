import { existsSync } from "node:fs";
import { WORKING_TREE_REV, type IVCSService, type VcsChangedFile } from "@consistency/schema";
import { LocalGitAdapter } from "@consistency/vcs-core";
import { collectWorkingTreeChanges } from "./context/buildLocalContext";
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

export type DiffFileSummary = {
  path: string;
  status: VcsChangedFile["status"];
  additions: number;
  deletions: number;
};

export type JobDiffDependencies = {
  jobs: ReviewJobStore;
  workspaceRoot: string;
  vcsFactory?: (root: string) => IVCSService;
  allowTruncate?: boolean;
  page?: number;
  pageSize?: number;
  search?: string;
  file?: string;
  getReport?: (jobId: string) => { findings?: Array<{ file: string }> } | undefined;
};

export type JobDiffResult = {
  files: VcsChangedFile[];
  available: boolean;
  /**
   * True when the files come from an identity that cannot drift: a persisted
   * review-time snapshot (working-tree jobs) or pinned commit SHAs (range and
   * cloned-workspace jobs). False only for legacy working-tree jobs captured
   * before snapshots existed — their diff is read live and may have drifted
   * from the reviewed content (audit P1-01).
   */
  pinned: boolean;
  /** Total number of changed files detected before truncation/paging. */
  totalFiles?: number;
  /** True when the returned files array was truncated or paged. */
  truncated?: boolean;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  allFilesSummary?: DiffFileSummary[];
};

/**
 * Computes the diff snapshot for a job on demand.
 *
 * Local working-tree jobs resolve from the review-time snapshot persisted at
 * context capture (audit P1-01): report, diff, and evidence references stay
 * aligned with what was reviewed even after the working tree changes or the
 * API restarts. Jobs created before snapshots existed fall back to a live
 * read and are marked `pinned: false` so the UI can disclose the drift.
 * Range jobs diff pinned SHAs via git objects; public/GitHub App jobs diff
 * the cloned analysis workspace — no database migration was needed, but a
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
    let pinned: boolean;
    if (job.accessMode === "local_git") {
      if (!job.repoPath) throw new JobDiffError("Local job is missing repoPath", "JOB_DIFF_UNAVAILABLE", 404);
      if (!job.baseSha) throw new JobDiffError("Local job is missing revision metadata", "JOB_DIFF_UNAVAILABLE", 404);
      
      const snapshot = dependencies.jobs.getReviewSnapshot(jobId);
      if (snapshot) {
        files = snapshot.files;
        pinned = true;
      } else if (job.headSha === WORKING_TREE_REV) {
        const vcs = dependencies.vcsFactory?.(job.repoPath) ?? new LocalGitAdapter({ root: job.repoPath });
        files = await collectWorkingTreeChanges(job.repoPath, vcs);
        pinned = false;
      } else {
        const vcs = dependencies.vcsFactory?.(job.repoPath) ?? new LocalGitAdapter({ root: job.repoPath });
        try {
          files = await vcs.getBranchDiff(job.baseSha, job.headSha ?? "");
        } catch {
          // Fall back to working tree changes if branch diff fails on local repo
          files = await collectWorkingTreeChanges(job.repoPath, vcs);
        }
        pinned = true;
      }
    } else {
      const root = workspacePathForJob(dependencies.workspaceRoot, job.id);
      if (!existsSync(root)) {
        // No cloned workspace (cleaned up, or never created): the diff is
        // genuinely unavailable. Production never synthesizes a replacement
        // diff — real data or explicit unavailability only (audit P1-11).
        return { files: [], available: false, pinned: false };
      }
      if (!job.baseSha || !job.headSha) {
        throw new JobDiffError("Job is missing revision metadata", "JOB_DIFF_UNAVAILABLE", 404);
      }
      const vcs = dependencies.vcsFactory?.(root) ?? new LocalGitAdapter({ root });
      files = await vcs.getBranchDiff(job.baseSha, job.headSha);
      pinned = true;
    }

    const totalBytes = files.reduce((sum, file) =>
      sum + file.hunks.reduce((hunkSum, hunk) =>
        hunkSum + Buffer.byteLength(hunk.header, "utf8") + Buffer.byteLength(hunk.content, "utf8"), 0), 0);

    if (!dependencies.allowTruncate && dependencies.page === undefined) {
      if (files.length > MAX_DIFF_FILES) {
        throw new JobDiffError(`Diff exceeds ${MAX_DIFF_FILES} files`, "DIFF_TOO_LARGE", 413);
      }
      if (totalBytes > MAX_DIFF_BYTES) {
        throw new JobDiffError(`Diff exceeds ${MAX_DIFF_BYTES} bytes`, "DIFF_TOO_LARGE", 413);
      }
    }

    const totalFiles = files.length;
    const allFilesSummary: DiffFileSummary[] = files.map(f => ({
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions
    }));

    let filtered = files;
    if (dependencies.search && dependencies.search.trim()) {
      const q = dependencies.search.trim().toLowerCase();
      filtered = filtered.filter(f => f.path.toLowerCase().includes(q));
    }
    if (dependencies.file && dependencies.file.trim()) {
      const targetPath = dependencies.file.trim();
      const match = filtered.filter(f => f.path === targetPath);
      if (match.length > 0) filtered = match;
    }

    // Default pageSize: 100 for large diffs, or all if <= 100
    const defaultPageSize = filtered.length > 100 ? 100 : Math.max(1, filtered.length);
    const pageSize = Math.min(500, Math.max(1, dependencies.pageSize ?? defaultPageSize));
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(totalPages, Math.max(1, dependencies.page ?? 1));
    const startIndex = (page - 1) * pageSize;
    let pagedFiles = filtered.slice(startIndex, startIndex + pageSize);

    let truncated = false;
    const bytes = pagedFiles.reduce((sum, file) =>
      sum + file.hunks.reduce((hunkSum, hunk) =>
        hunkSum + Buffer.byteLength(hunk.header, "utf8") + Buffer.byteLength(hunk.content, "utf8"), 0), 0);
    if (bytes > MAX_DIFF_BYTES) {
      if (dependencies.allowTruncate) {
        let currentBytes = 0;
        const capped: VcsChangedFile[] = [];
        for (const file of pagedFiles) {
          const fileBytes = file.hunks.reduce((sum, hunk) =>
            sum + Buffer.byteLength(hunk.header, "utf8") + Buffer.byteLength(hunk.content, "utf8"), 0);
          if (currentBytes + fileBytes > MAX_DIFF_BYTES && capped.length > 0) {
            truncated = true;
            break;
          }
          currentBytes += fileBytes;
          capped.push(file);
        }
        pagedFiles = capped;
      } else {
        throw new JobDiffError(`Diff exceeds ${MAX_DIFF_BYTES} bytes`, "DIFF_TOO_LARGE", 413);
      }
    }

    return {
      files: pagedFiles,
      available: true,
      pinned,
      totalFiles,
      page,
      pageSize,
      totalPages,
      allFilesSummary,
      truncated: truncated || totalPages > 1
    };
  } catch (error) {
    if (error instanceof JobDiffError) throw error;
    throw new JobDiffError(
      `Could not read repository diff: ${error instanceof Error ? error.message : "unknown error"}`,
      "DIFF_UNAVAILABLE",
      422
    );
  }
}
