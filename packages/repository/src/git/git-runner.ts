/**
 * Git CLI runner — the narrow Git backend for PR-4 snapshots.
 *
 * All reads target the Git OBJECT DATABASE (`git show <sha>:<path>`,
 * `git ls-tree <sha>`, `git rev-parse <sha>`), never the mutable working
 * tree. That is what makes snapshot reads immune to later checkout changes.
 *
 * Local Git only: no remote protocol, no GitHub SDK, no clone management.
 */

import { spawnSync } from "node:child_process";

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;
  constructor(args: readonly string[], stderr: string) {
    super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
    this.name = "GitCommandError";
    this.args = args;
    this.stderr = stderr;
  }
}

const MAX_BUFFER = 64 * 1024 * 1024; // 64 MiB — generous for source files

/**
 * Run `git` inside `repoPath` and return the RAW stdout (no trimming —
 * `git show` output IS the blob content and must not be altered). Throws
 * {@link GitCommandError} on non-zero exit (fail closed).
 */
export function runGit(repoPath: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  if (result.error) {
    throw new GitCommandError(args, `failed to spawn git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new GitCommandError(args, result.stderr || `exit code ${result.status}`);
  }
  return result.stdout;
}
