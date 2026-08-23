import { basename, relative, resolve, sep } from "node:path";
import { WORKING_TREE_REV, type IVCSService } from "@consistency/schema";
import { LocalGitAdapter } from "@consistency/vcs-core";
import type { ReviewJobStore } from "../jobQueue";

export type LocalTriggerInput = {
  /** Path to the checkout to review. */
  repoPath: string;
  /** Canonical opaque repository id of the REGISTERED repository this review
   *  belongs to (persisted on the job; no name inference anywhere). */
  repositoryId?: string;
  /** Supply both to review a committed range; omit both for the working tree. */
  baseRef?: string;
  headRef?: string;
  llmProvider?: "deepseek" | "openai";
  llmModel?: string;
};

export type LocalTriggerDependencies = {
  /**
   * Directories under which a reviewable checkout may live. Required: without
   * it any caller who can reach this endpoint could make the server read an
   * arbitrary repository on disk.
   */
  allowedRoots: string[];
  vcsFactory?: (root: string) => IVCSService;
};

export class LocalTriggerError extends Error {
  constructor(message: string, readonly code: "PATH_NOT_ALLOWED" | "NOT_A_REPOSITORY" | "NOTHING_TO_REVIEW") {
    super(message);
    this.name = "LocalTriggerError";
  }
}

function canonicalizePath(p: string): string {
  const resolved = resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertInsideAllowedRoot(repoPath: string, allowedRoots: string[]): void {
  if (allowedRoots.length === 0) {
    throw new LocalTriggerError("No local review roots are configured", "PATH_NOT_ALLOWED");
  }
  const canonicalTarget = canonicalizePath(repoPath);
  const permitted = allowedRoots.some((root) => {
    const canonicalRoot = canonicalizePath(root);
    if (canonicalTarget === canonicalRoot) return true;
    const rel = relative(canonicalRoot, canonicalTarget);
    return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`.${sep}.`) && !/^[A-Za-z]:/.test(rel);
  });
  if (!permitted) {
    throw new LocalTriggerError("Repository path is outside the configured review roots", "PATH_NOT_ALLOWED");
  }
}

/**
 * Enqueues a review of a local checkout. Local jobs never publish, so their
 * publication policy is fixed to `disabled`.
 */
export async function triggerLocalReview(
  jobs: ReviewJobStore,
  input: LocalTriggerInput,
  dependencies: LocalTriggerDependencies
): Promise<{ jobId: string }> {
  const repoPath = resolve(input.repoPath);
  assertInsideAllowedRoot(repoPath, dependencies.allowedRoots);

  const reviewingRange = input.baseRef !== undefined && input.headRef !== undefined;
  if (!reviewingRange && (input.baseRef !== undefined || input.headRef !== undefined)) {
    throw new LocalTriggerError("baseRef and headRef must be supplied together", "NOTHING_TO_REVIEW");
  }

  const vcs = dependencies.vcsFactory?.(repoPath) ?? new LocalGitAdapter({ root: repoPath });

  let baseSha: string;
  let headSha: string;
  try {
    if (reviewingRange) {
      const [base] = await vcs.getCommitHistory(1);
      if (base === undefined) throw new LocalTriggerError("Repository has no commits", "NOTHING_TO_REVIEW");
      const changed = await vcs.getBranchDiff(input.baseRef as string, input.headRef as string);
      if (changed.length === 0) {
        throw new LocalTriggerError("The requested range has no changes", "NOTHING_TO_REVIEW");
      }
      baseSha = input.baseRef as string;
      headSha = input.headRef as string;
    } else {
      const [head] = await vcs.getCommitHistory(1);
      if (head === undefined) throw new LocalTriggerError("Repository has no commits", "NOTHING_TO_REVIEW");
      const changed = await vcs.getWorkingDiff();
      const untracked = await vcs.getUntrackedFiles();
      if (changed.length === 0 && untracked.length === 0) {
        throw new LocalTriggerError("The working tree is clean", "NOTHING_TO_REVIEW");
      }
      baseSha = head.sha;
      headSha = WORKING_TREE_REV;
    }
  } catch (error) {
    if (error instanceof LocalTriggerError) throw error;
    throw new LocalTriggerError(
      `Not a readable git repository: ${error instanceof Error ? error.message : "unknown error"}`,
      "NOT_A_REPOSITORY"
    );
  }

  const job = jobs.enqueue({
    kind: "pull_request",
    repository: basename(repoPath),
    repositoryId: input.repositoryId,
    repoPath,
    accessMode: "local_git",
    publicationPolicy: "disabled",
    baseSha,
    headSha,
    llmProvider: input.llmProvider,
    llmModel: input.llmModel,
    action: "local_trigger"
  });

  return { jobId: job.id };
}
