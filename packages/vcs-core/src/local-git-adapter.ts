import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  parseGitHubRepositoryFullName,
  type GitHubRepositoryIdentity,
  type IVCSService,
  type RepoRef,
  type VcsChangedFile,
  type VcsCommitSummary,
  type VcsFileTreeEntry,
  type WorkingDirDirtyEvent
} from "@consistency/schema";
import { parseUnifiedDiff, splitNulRecords } from "./diff";
import { GitCommandError, assertSafeRef, execGit, type GitExec } from "./git";

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
  "--no-ext-diff",
  "--no-textconv",
  "--find-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/"
];

const LS_TREE_ENTRY = /^(\d+) (blob|tree|commit) ([0-9a-f]+)\s+(\d+|-)\t(.*)$/;
const HISTORY_HEAD_ARGS = ["rev-parse", "--verify", "--quiet", "HEAD"];
const GIT_SHA = /^[0-9a-f]{40,64}$/;

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

  private async hasHistoryHead(): Promise<boolean> {
    try {
      const head = (await this.run(HISTORY_HEAD_ARGS)).trim();
      if (!GIT_SHA.test(head)) {
        throw new GitCommandError("git returned invalid HEAD output", HISTORY_HEAD_ARGS, 0, "");
      }
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1) return false;
      throw error;
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

  private async refExists(ref: string): Promise<boolean> {
    try {
      await this.run(["rev-parse", "--verify", "--quiet", assertSafeRef(ref)]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolves only a verified symbolic default for the selected remote. This
   * does not fetch and never falls back to local branch-name heuristics.
   */
  async resolveRemoteDefaultBranch(remoteName: string): Promise<string | undefined> {
    if (!/^[A-Za-z0-9._-]+$/.test(remoteName) || remoteName.startsWith("-")) return undefined;
    const remoteHeadRef = `refs/remotes/${remoteName}/HEAD`;
    try {
      const symbolicTarget = (await this.run(["symbolic-ref", "--short", "--quiet", remoteHeadRef])).trim();
      const prefix = `${remoteName}/`;
      if (!symbolicTarget.startsWith(prefix)) return undefined;
      const branch = symbolicTarget.slice(prefix.length);
      if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) return undefined;
      return (await this.refExists(`refs/remotes/${remoteName}/${branch}`)) ? branch : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Trunk branch for branch-diff basing: the branch pinned by
   * `refs/remotes/origin/HEAD` when the remote set one, otherwise the first of
   * `main`/`master` that actually resolves. Undefined when no trunk can be
   * verified, so callers must not advertise a branch diff against a
   * hypothetical base then.
   */
  async resolveTrunkRef(): Promise<string | undefined> {
    try {
      const remoteHead = (await this.run(["symbolic-ref", "--short", "--quiet", "refs/remotes/origin/HEAD"])).trim();
      const remoteBranch = remoteHead.replace(/^origin\//, "");
      if (remoteBranch.length > 0 && (await this.refExists(remoteBranch))) return remoteBranch;
    } catch {
      // No pinned origin/HEAD; fall through to the local candidates.
    }
    for (const candidate of ["main", "master"]) {
      if (await this.refExists(candidate)) return candidate;
    }
    return undefined;
  }

  /**
   * Resolves any single revision git accepts (branch, tag, abbreviated or full
   * SHA) into its immutable object name. Returns undefined when the revision
   * cannot be verified, so callers can fail closed instead of storing a
   * symbolic name that may move before a queued job executes.
   */
  async resolveRevision(revision: string): Promise<string | undefined> {
    try {
      const sha = (await this.run(["rev-parse", "--verify", "--quiet", assertSafeRef(revision)])).trim();
      return GIT_SHA.test(sha) ? sha : undefined;
    } catch {
      return undefined;
    }
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
    if (!(await this.hasHistoryHead())) return [];

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
   * Discovers configured git remotes while keeping fetch and push URLs distinct.
   * Raw URLs are server-internal and must not cross the renderer boundary.
   */
  async getRemotes(): Promise<GitRemoteObservation[]> {
    try {
      const stdout = await this.run(["remote", "-v"]);
      const remoteMap = new Map<string, { fetchUrl?: string; pushUrl?: string }>();
      for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
        if (!match?.[1] || !match[2] || !match[3]) continue;
        const observation = remoteMap.get(match[1]) ?? {};
        if (match[3] === "fetch" && observation.fetchUrl === undefined) observation.fetchUrl = match[2];
        if (match[3] === "push" && observation.pushUrl === undefined) observation.pushUrl = match[2];
        remoteMap.set(match[1], observation);
      }
      return Array.from(remoteMap.entries()).map(([name, observation]) => {
        const parsed = observation.fetchUrl === undefined ? null : parseGitHubRemote(observation.fetchUrl);
        return {
          name,
          ...observation,
          ...(parsed === null ? {} : { githubFullName: parsed.fullName })
        };
      });
    } catch {
      return [];
    }
  }
}

export type GitHubRemoteIdentity = GitHubRepositoryIdentity;
export { parseGitHubRepositoryFullName };

export type GitRemoteObservation = {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly githubFullName?: string;
};

function parseRawOwnerRepoClonePath(
  pathname: string,
  form: "url" | "scp"
): GitHubRemoteIdentity | null {
  if (
    pathname.includes("%")
    || pathname.includes("\\")
    || pathname.includes("?")
    || pathname.includes("#")
  ) return null;

  let rawPath = pathname;
  if (form === "url") {
    if (!rawPath.startsWith("/")) return null;
    rawPath = rawPath.slice(1);
  } else if (rawPath.startsWith("/")) {
    return null;
  }

  if (rawPath.endsWith("/")) rawPath = rawPath.slice(0, -1);
  const parts = rawPath.split("/");
  if (
    parts.length !== 2
    || parts.some(part => part.length === 0 || part === "." || part === "..")
  ) return null;

  const repositoryPart = parts[1]!;
  const repo = repositoryPart.endsWith(".git")
    ? repositoryPart.slice(0, -4)
    : repositoryPart;
  return parseGitHubRepositoryFullName(`${parts[0]}/${repo}`);
}

function hasExplicitUrlPortDelimiter(authority: string): boolean {
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  return hostAndPort.includes(":");
}

/**
 * Parses trusted github.com HTTPS and SSH clone forms. The unauthenticated
 * git:// transport is intentionally unsupported; enterprise hosts and URLs
 * containing credentials, query strings, or fragments are rejected.
 */
export function parseGitHubRemote(value: string): GitHubRemoteIdentity | null {
  if (
    value !== value.trim()
    || value.includes("%")
    || value.includes("\\")
    || /[\s\u0000-\u001f\u007f]/.test(value)
  ) return null;
  if (!value) return null;

  const trimmed = value;
  const scpMatch = /^git@github\.com:([^?#]+)$/i.exec(trimmed);
  if (scpMatch?.[1]) return parseRawOwnerRepoClonePath(scpMatch[1], "scp");

  const rawUrlMatch = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)(\/[^?#]*)?$/.exec(trimmed);
  const rawAuthority = rawUrlMatch?.[1];
  const rawPath = rawUrlMatch?.[2];
  if (
    rawAuthority === undefined
    || rawPath === undefined
    || hasExplicitUrlPortDelimiter(rawAuthority)
  ) return null;
  const identity = parseRawOwnerRepoClonePath(rawPath, "url");
  if (identity === null) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    url.pathname !== rawPath
    || url.hostname.toLowerCase() !== "github.com"
    || url.search
    || url.hash
  ) return null;
  if (url.protocol === "https:") {
    if (url.username || url.password) return null;
  } else if (url.protocol === "ssh:") {
    if (url.username.toLowerCase() !== "git" || url.password) return null;
  } else {
    return null;
  }
  return identity;
}

/** Selects canonical GitHub identity from fetch URLs only. */
export function selectGitHubRemote(remotes: readonly GitRemoteObservation[]): GitRemoteObservation | undefined {
  const recognized = remotes
    .filter(remote => remote.fetchUrl !== undefined && remote.githubFullName !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
  return recognized.find(remote => remote.name === "origin") ?? recognized[0];
}
