import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isSecretPath } from "@consistency/schema";
import { execGit, type GitExec } from "@consistency/vcs-core";
import { redactSensitiveText } from "../../security/redact";

export { isSecretPath };

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export type ByteBudget = {
  limit: number;
  used: number;
};

export function resolveWorkspaceFile(workspacePath: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new Error("File path must be relative to the review workspace");
  }
  const root = realpathSync(resolve(workspacePath));
  const candidate = resolve(root, relativePath.replaceAll("/", sep));
  const lexicalRelative = relative(root, candidate);
  if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) {
    throw new Error("File path escapes the review workspace");
  }
  const actual = realpathSync(candidate);
  const actualRelative = relative(root, actual);
  if (actualRelative.startsWith("..") || isAbsolute(actualRelative)) {
    throw new Error("File resolves outside the review workspace");
  }
  if (!lstatSync(actual).isFile()) {
    throw new Error("Review context path is not a regular file");
  }
  return actual;
}

export function loadWorkspaceFiles(options: {
  workspacePath: string;
  paths: string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
  budget?: ByteBudget;
}): Record<string, string> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.budget?.limit ?? options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  let totalBytes = options.budget?.used ?? 0;
  const contents: Record<string, string> = {};

  for (const path of [...new Set(options.paths)]) {
    if (isSecretPath(path)) continue;
    let absolutePath: string;
    try {
      absolutePath = resolveWorkspaceFile(options.workspacePath, path);
    } catch (error) {
      if (error instanceof Error && /ENOENT/.test(error.message)) continue;
      throw error;
    }
    const rawSize = statSync(absolutePath).size;
    if (rawSize > maxFileBytes) continue;

    const buffer = readFileSync(absolutePath);
    if (buffer.includes(0)) continue;

    const content = redactSensitiveText(buffer.toString("utf8"));
    const outputSize = Buffer.byteLength(content, "utf8");

    if (
      outputSize > maxFileBytes
      || totalBytes + outputSize > maxTotalBytes
    ) {
      continue;
    }

    contents[path] = content;
    totalBytes += outputSize;
    if (options.budget) options.budget.used = totalBytes;
  }
  return contents;
}

/**
 * Same admission rules as {@link loadWorkspaceFiles}, but the bytes come from
 * `git show <sha>:<path>` instead of the working tree. A missing path is
 * skipped the way a missing workspace file is skipped.
 */
export async function loadRevisionFiles(options: {
  repoPath: string;
  sha: string;
  paths: string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
  budget?: ByteBudget;
  runGit?: GitExec;
}): Promise<Record<string, string>> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.budget?.limit ?? options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  let totalBytes = options.budget?.used ?? 0;
  const contents: Record<string, string> = {};
  const runGit = options.runGit ?? execGit;

  for (const path of [...new Set(options.paths)]) {
    if (isSecretPath(path)) continue;
    let stdout: string;
    try {
      ({ stdout } = await runGit(["show", `${options.sha}:${path}`], {
        cwd: options.repoPath,
        maxBytes: maxFileBytes
      }));
    } catch {
      // Missing at this revision, or larger than the same per-file cap the
      // workspace loader applies before reading. Either way the path is skipped,
      // matching loadWorkspaceFiles on a file it cannot read.
      continue;
    }
    if (stdout.includes("\0")) continue;

    const content = redactSensitiveText(stdout);
    const outputSize = Buffer.byteLength(content, "utf8");
    if (outputSize > maxFileBytes || totalBytes + outputSize > maxTotalBytes) continue;

    contents[path] = content;
    totalBytes += outputSize;
    if (options.budget) options.budget.used = totalBytes;
  }
  return contents;
}
