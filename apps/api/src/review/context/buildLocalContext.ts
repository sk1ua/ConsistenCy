import { readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  WORKING_TREE_REV,
  prReviewContextSchema,
  type ChangedFile,
  type IVCSService,
  type PRReviewContext,
  type VcsChangedFile
} from "@consistency/schema";
import { LocalGitAdapter, execGit, type GitExec } from "@consistency/vcs-core";
import { loadWorkspaceFiles, isSecretPath } from "./fileLoader";
import { createLocalReviewExcludeFilter } from "../localReviewExclude";

const PROJECT_METADATA_FILES = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "README.md",
  "README.rst",
  "pytest.ini",
  "tox.ini",
  "vitest.config.ts",
  "vite.config.ts",
  "jest.config.js",
  "jest.config.ts"
];

const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024;
const DEFAULT_MAX_PATCH_BYTES = 64 * 1024;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/**
 * Turn untracked paths into reviewable changed files (status `untracked`,
 * mapped to GitHub `added` downstream). Synthesizes a full-file addition
 * patch from disk so the deterministic engine and LLM see content/hunks.
 * Never mutates the working tree.
 */
export function untrackedPathToChangedFile(
  repoPath: string,
  relativePath: string,
  maxFileBytes: number = DEFAULT_MAX_FILE_BYTES
): VcsChangedFile | undefined {
  if (!relativePath || relativePath.includes("\0") || isSecretPath(relativePath)) {
    return undefined;
  }
  const absolute = join(repoPath, relativePath);
  let size: number;
  try {
    const stats = statSync(absolute);
    if (!stats.isFile()) return undefined;
    size = stats.size;
  } catch {
    return undefined;
  }

  if (size > maxFileBytes) {
    return {
      path: relativePath,
      status: "untracked",
      additions: 0,
      deletions: 0,
      binary: true,
      hunks: []
    };
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(absolute);
  } catch {
    return undefined;
  }
  if (buffer.includes(0)) {
    return {
      path: relativePath,
      status: "untracked",
      additions: 0,
      deletions: 0,
      binary: true,
      hunks: []
    };
  }

  const textContent = buffer.toString("utf8");
  let lines = textContent.split("\n");
  if (textContent.endsWith("\n") && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }
  const newLines = lines.length;
  if (newLines === 0) {
    return {
      path: relativePath,
      status: "untracked",
      additions: 0,
      deletions: 0,
      binary: false,
      hunks: []
    };
  }

  return {
    path: relativePath,
    status: "untracked",
    additions: newLines,
    deletions: 0,
    binary: false,
    hunks: [{
      header: `@@ -0,0 +1,${newLines} @@`,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines,
      content: lines.map(line => `+${line}`).join("\n")
    }]
  };
}

/**
 * Working-tree review surface: tracked dirty files plus untracked paths.
 * Matches POST /reviews/local enqueue rules (dirty OR untracked).
 */
export async function collectWorkingTreeChanges(
  repoPath: string,
  vcs: IVCSService,
  maxFileBytes: number = DEFAULT_MAX_FILE_BYTES
): Promise<VcsChangedFile[]> {
  const [tracked, untrackedPaths] = await Promise.all([
    vcs.getWorkingDiff(),
    vcs.getUntrackedFiles()
  ]);
  const exclude = createLocalReviewExcludeFilter(repoPath);
  const seen = new Set(tracked.map(file => file.path));
  const merged = tracked.filter(file => !exclude.excludes(file.path));
  for (const relativePath of untrackedPaths) {
    if (exclude.excludes(relativePath)) continue;
    if (seen.has(relativePath)) continue;
    const file = untrackedPathToChangedFile(repoPath, relativePath, maxFileBytes);
    if (file === undefined) continue;
    seen.add(relativePath);
    merged.push(file);
  }
  return merged;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n[truncated by ConsistenCy]`;
}

/**
 * Maps VCS-neutral statuses onto the GitHub vocabulary the downstream workflow
 * already branches on (`removed` gates content loading, `added` gates baseline
 * loading). Keeping one vocabulary avoids every consumer learning two.
 */
function toGitHubStatus(status: VcsChangedFile["status"]): string {
  switch (status) {
    case "deleted":
      return "removed";
    case "untracked":
      return "added";
    case "type_changed":
      return "modified";
    default:
      return status;
  }
}

function toChangedFile(file: VcsChangedFile, maxPatchBytes: number): ChangedFile {
  const patch = file.hunks.map((hunk) => `${hunk.header}\n${hunk.content}`).join("\n");
  const changed: ChangedFile = {
    path: file.path,
    status: toGitHubStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
    changes: file.additions + file.deletions
  };
  if (patch.length > 0) changed.patch = truncateUtf8(patch, maxPatchBytes);
  return changed;
}

export type BuildLocalContextInput = {
  jobId: string;
  /** Absolute path to the checkout under review. */
  repoPath: string;
  /**
   * Omit to review the uncommitted working tree. Supply both to review a
   * committed range, which is diffed from the merge base like a pull request.
   */
  baseRef?: string;
  headRef?: string;
};

export type BuildLocalContextDependencies = {
  /** Injectable so tests and future providers can substitute an adapter. */
  vcs?: IVCSService;
  runGit?: GitExec;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxDiffBytes?: number;
  maxPatchBytes?: number;
};

/**
 * Builds review context from a local checkout through `IVCSService`, producing
 * the same `PRReviewContext` the GitHub path produces so the review workflow is
 * unchanged downstream.
 *
 * Nothing is cloned: the checkout is read in place, so `workspacePath` is the
 * repository itself. All reads go through the adapter or `git show`; the
 * working tree is never modified.
 */
export async function buildLocalContext(
  input: BuildLocalContextInput,
  dependencies: BuildLocalContextDependencies = {}
): Promise<PRReviewContext> {
  const repoPath = resolve(input.repoPath);
  const vcs = dependencies.vcs ?? new LocalGitAdapter({ root: repoPath });
  const runGit = dependencies.runGit ?? execGit;

  const reviewingRange = input.baseRef !== undefined && input.headRef !== undefined;
  if (!reviewingRange && (input.baseRef !== undefined || input.headRef !== undefined)) {
    throw new Error("baseRef and headRef must be supplied together");
  }

  const changed = reviewingRange
    ? await vcs.getBranchDiff(input.baseRef as string, input.headRef as string)
    : await collectWorkingTreeChanges(
      repoPath,
      vcs,
      dependencies.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    );

  const maxPatchBytes = dependencies.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const changedFiles = changed.map((file) => toChangedFile(file, maxPatchBytes));

  for (const file of changedFiles) {
    if (file.path.includes("\0")) throw new Error("File path contains NUL character");
  }

  const diff = truncateUtf8(
    changed
      .map((file) => `--- a/${file.previousPath ?? file.path}\n+++ b/${file.path}\n`
        + file.hunks.map((hunk) => `${hunk.header}\n${hunk.content}`).join("\n"))
      .join("\n"),
    dependencies.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES
  );

  // Resolve the revision that supplies baseline content. For a working-tree
  // review that is HEAD; for a range it is the base ref itself.
  const headSha = reviewingRange
    ? (await runGit(["rev-parse", input.headRef as string], { cwd: repoPath })).stdout.trim()
    : WORKING_TREE_REV;
  const baseSha = reviewingRange
    ? (await runGit(["rev-parse", input.baseRef as string], { cwd: repoPath })).stdout.trim()
    : (await runGit(["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();

  const budget = {
    limit: dependencies.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    used: 0
  };
  const loaderOptions = {
    workspacePath: repoPath,
    maxFileBytes: dependencies.maxFileBytes,
    budget
  };

  const fileContents = loadWorkspaceFiles({
    ...loaderOptions,
    paths: changedFiles.filter((file) => file.status !== "removed").map((file) => file.path)
  });
  const projectMetadata = loadWorkspaceFiles({
    ...loaderOptions,
    paths: PROJECT_METADATA_FILES
  });

  const maxFileBytes = dependencies.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const baseFileContents: Record<string, string> = {};
  for (const file of changedFiles) {
    if (file.status === "added") continue;
    if (isSecretPath(file.path)) continue;

    try {
      const { stdout } = await runGit(["show", `${baseSha}:${file.path}`], {
        cwd: repoPath,
        maxBytes: maxFileBytes
      });
      if (stdout.includes("\0")) continue;

      const outputSize = Buffer.byteLength(stdout, "utf8");
      if (outputSize > maxFileBytes) continue;
      if (budget.used + outputSize > budget.limit) continue;

      baseFileContents[file.path] = stdout;
      budget.used += outputSize;
    } catch {
      // A path absent at the base revision simply has no baseline.
    }
  }

  return prReviewContextSchema.parse({
    jobId: input.jobId,
    source: "local_git",
    repositoryFullName: basename(repoPath),
    baseSha,
    headSha,
    changedFiles,
    diff,
    fileContents,
    baseFileContents,
    projectMetadata,
    workspacePath: repoPath
  });
}
