import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  IVCSService,
  RepoRef,
  VcsChangedFile,
  VcsCommitSummary,
  VcsFileTreeEntry,
  WorkingDirDirtyEvent
} from "@consistency/schema";
import { parseUnifiedDiff, splitNulRecords } from "./diff";
import { assertSafeRef, execGit, type GitExec } from "./git";

const UNIT = "\x1f";
const RECORD = "\x1e";

/**
 * Diff flags pinned for every invocation. The prefixes must stay explicit so
 * repository-level `diff.noprefix` / `diff.mnemonicPrefix` config cannot change
 * the shape of what the parser receives.
 */
const DIFF_FLAGS = [
  "--patch",
  "--no-color",
  "--find-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/"
];

const LS_TREE_ENTRY = /^(\d+) (blob|tree|commit) ([0-9a-f]+)\s+(\d+|-)\t(.*)$/;

export type ChurnStats = {
  windowDays: number;
  commits: number;
  /** Added plus deleted lines across the window; binary files contribute none. */
  linesChanged: number;
  filesTouched: number;
};

export type LocalGitAdapterOptions = {
  /** Absolute path to a working tree. */
  root: string;
  exec?: GitExec;
  timeoutMs?: number;
};

/**
 * Read-only `IVCSService` over a local checkout.
 *
 * Every method is a read: no command here writes to the object store, the
 * index, or the working tree, so the adapter is safe to point at a directory a
 * developer is actively editing.
 */
export class LocalGitAdapter implements IVCSService {
  readonly provider = "local_git" as const;

  private readonly root: string;
  private readonly exec: GitExec;
  private readonly timeoutMs: number | undefined;

  constructor(options: LocalGitAdapterOptions) {
    this.root = resolve(options.root);
    this.exec = options.exec ?? execGit;
    this.timeoutMs = options.timeoutMs;
  }

  private async run(args: string[]): Promise<string> {
    const result = await this.exec(args, { cwd: this.root, timeoutMs: this.timeoutMs });
    return result.stdout;
  }

  private async hasCommits(): Promise<boolean> {
    try {
      await this.run(["rev-parse", "--verify", "--quiet", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Absolute path of the working tree root, per git rather than per caller. */
  async getRepositoryRoot(): Promise<string> {
    return (await this.run(["rev-parse", "--show-toplevel"])).trim();
  }

  async getCurrentBranch(): Promise<string | undefined> {
    const branch = (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    // A detached HEAD reports the literal "HEAD" rather than a branch name.
    return branch === "HEAD" || branch.length === 0 ? undefined : branch;
  }

  async getHeadSha(): Promise<string | undefined> {
    if (!(await this.hasCommits())) return undefined;
    return (await this.run(["rev-parse", "HEAD"])).trim();
  }

  async getRepoRef(): Promise<RepoRef> {
    const [root, branch, headSha] = await Promise.all([
      this.getRepositoryRoot(),
      this.getCurrentBranch().catch(() => undefined),
      this.getHeadSha()
    ]);
    const ref: RepoRef = { root, provider: this.provider };
    if (branch !== undefined) ref.branch = branch;
    if (headSha !== undefined) ref.headSha = headSha;
    return ref;
  }

  /**
   * Staged and unstaged tracked changes against HEAD. Untracked files are not
   * included; they carry no baseline and are reported by `getUntrackedFiles`.
   *
   * Before the first commit there is no HEAD to diff against, so this falls
   * back to the staged diff, which git resolves against the empty tree.
   */
  async getWorkingDiff(): Promise<VcsChangedFile[]> {
    const args = (await this.hasCommits())
      ? ["diff", ...DIFF_FLAGS, "HEAD"]
      : ["diff", ...DIFF_FLAGS, "--cached"];
    return parseUnifiedDiff(await this.run(args));
  }

  /**
   * Diff from the merge base of `base` and `head` to `head` — the three-dot
   * range, matching what a pull request shows. A two-dot range would also
   * report changes that landed on `base` after the branch point.
   */
  async getBranchDiff(base: string, head: string): Promise<VcsChangedFile[]> {
    const range = `${assertSafeRef(base)}...${assertSafeRef(head)}`;
    return parseUnifiedDiff(await this.run(["diff", ...DIFF_FLAGS, range]));
  }

  async getCommitHistory(depth: number): Promise<VcsCommitSummary[]> {
    if (!Number.isInteger(depth) || depth <= 0) {
      throw new Error("depth must be a positive integer");
    }
    if (!(await this.hasCommits())) return [];

    const format = ["%H", "%P", "%an", "%ae", "%aI", "%B"].join(UNIT) + RECORD;
    const stdout = await this.run(["log", `--max-count=${depth}`, `--format=${format}`]);

    return stdout
      .split(RECORD)
      .map((record) => record.replace(/^\n/, ""))
      .filter((record) => record.trim().length > 0)
      .map((record) => {
        const [sha = "", parents = "", name = "", email = "", authoredAt = "", message = ""] =
          record.split(UNIT);
        const summary: VcsCommitSummary = {
          sha: sha.trim(),
          parentShas: parents.trim().length > 0 ? parents.trim().split(" ") : [],
          author: email.trim().length > 0
            ? { name: name.trim(), email: email.trim() }
            : { name: name.trim() },
          authoredAt: new Date(authoredAt.trim()).toISOString(),
          message: message.replace(/\n+$/, "")
        };
        return summary;
      });
  }

  async getUntrackedFiles(): Promise<string[]> {
    const stdout = await this.run(["ls-files", "--others", "--exclude-standard", "-z"]);
    return splitNulRecords(stdout);
  }

  /**
   * Recursive tree listing at a revision. Submodule entries (`commit` objects)
   * are omitted: they point into a different repository, so they are neither a
   * blob nor a tree in this one.
   */
  async getFileTreeAtCommit(sha: string): Promise<VcsFileTreeEntry[]> {
    const revision = assertSafeRef(sha);
    const stdout = await this.run(["ls-tree", "-r", "-t", "--long", "-z", revision]);

    const entries: VcsFileTreeEntry[] = [];
    for (const record of splitNulRecords(stdout)) {
      const match = LS_TREE_ENTRY.exec(record);
      if (match === null) continue;
      const [, , type, objectSha = "", size = "-", path = ""] = match;
      if (type !== "blob" && type !== "tree") continue;
      const entry: VcsFileTreeEntry = { path, type, sha: objectSha };
      if (size !== "-") entry.size = Number(size);
      entries.push(entry);
    }
    return entries;
  }

  /**
   * Commit and line-churn totals over a trailing window.
   *
   * Deliberately not on `IVCSService`: it is a metrics concern, and forcing
   * every provider to implement `--numstat` parsing to satisfy the review
   * interface would be the wrong trade.
   */
  async getChurnStats(windowDays: number): Promise<ChurnStats> {
    if (!Number.isInteger(windowDays) || windowDays <= 0) {
      throw new Error("windowDays must be a positive integer");
    }
    if (!(await this.hasCommits())) {
      return { windowDays, commits: 0, linesChanged: 0, filesTouched: 0 };
    }

    const stdout = await this.run([
      "log",
      `--since=${windowDays}.days.ago`,
      "--numstat",
      "--format=%x1ecommit",
      "--no-renames"
    ]);

    let commits = 0;
    let linesChanged = 0;
    const files = new Set<string>();

    for (const rawLine of stdout.split("\n")) {
      const line = rawLine.replace(/\x1e/g, "");
      if (line === "commit") {
        commits += 1;
        continue;
      }
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [added = "", deleted = "", path = ""] = parts;
      // Binary files report "-" for both counts.
      if (added !== "-") linesChanged += Number(added) || 0;
      if (deleted !== "-") linesChanged += Number(deleted) || 0;
      if (path.length > 0) files.add(path);
    }

    return { windowDays, commits, linesChanged, filesTouched: files.size };
  }

  /**
   * Assembles the `WORKING_DIR_DIRTY` event the heartbeat daemon publishes.
   * Returns undefined when the tree is clean, so callers can skip emitting.
   */
  async buildWorkingDirDirtyEvent(): Promise<WorkingDirDirtyEvent | undefined> {
    const [repository, changedFiles, untrackedFiles] = await Promise.all([
      this.getRepoRef(),
      this.getWorkingDiff(),
      this.getUntrackedFiles()
    ]);

    if (changedFiles.length === 0 && untrackedFiles.length === 0) return undefined;

    const event: WorkingDirDirtyEvent = {
      type: "WORKING_DIR_DIRTY",
      eventId: `wd_${randomUUID()}`,
      repository,
      detectedAt: new Date().toISOString(),
      changedFiles,
      untrackedFiles
    };
    if (repository.headSha !== undefined) event.baseSha = repository.headSha;
    return event;
  }

  /**
   * Discovers configured git remotes.
   */
  async getRemotes(): Promise<Array<{ name: string; url: string; githubFullName?: string }>> {
    try {
      const stdout = await this.run(["remote", "-v"]);
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      const remoteMap = new Map<string, string>();
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2 && parts[0] && parts[1]) {
          remoteMap.set(parts[0], parts[1]);
        }
      }
      return Array.from(remoteMap.entries()).map(([name, url]) => {
        const parsed = parseGitHubRemote(url);
        return {
          name,
          url,
          githubFullName: parsed?.fullName
        };
      });
    } catch {
      return [];
    }
  }
}

/**
 * Robust parser for GitHub remote URLs (HTTPS, SSH, git://, etc.)
 */
export function parseGitHubRemote(url: string): { owner: string; repo: string; fullName: string } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Handle https://github.com/owner/repo(.git), git@github.com:owner/repo(.git), ssh://git@github.com/owner/repo(.git)
  const match = trimmed.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)github\.com[:/]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/);
  if (!match || !match[1] || !match[2]) return null;
  const owner = match[1];
  const repo = match[2];
  return { owner, repo, fullName: `${owner}/${repo}` };
}
