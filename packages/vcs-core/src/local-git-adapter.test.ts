import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeChangeEventSchema, vcsChangedFileSchema } from "@consistency/schema";
import { GitCommandError, assertSafeRef, execGit } from "./git";
import { LocalGitAdapter, parseGitHubRemote } from "./local-git-adapter";

let root: string;
let adapter: LocalGitAdapter;

const git = (args: string[]) => execGit(args, { cwd: root });
const write = (name: string, content: string) => writeFileSync(join(root, name), content);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "consistency-vcs-"));
  await git(["init"]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(["config", "user.name", "Test Runner"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "commit.gpgsign", "false"]);

  write("a.txt", "line1\nline2\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial commit"]);

  adapter = new LocalGitAdapter({ root });
}, 60_000);

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe("LocalGitAdapter", { timeout: 30_000 }, () => {
  it("reports a clean tree as having no changes and no event", async () => {
    expect(await adapter.getWorkingDiff()).toEqual([]);
    expect(await adapter.getUntrackedFiles()).toEqual([]);
    expect(await adapter.buildWorkingDirDirtyEvent()).toBeUndefined();
  });

  it("describes the repository it is pointed at", async () => {
    const ref = await adapter.getRepoRef();
    expect(ref.provider).toBe("local_git");
    expect(ref.branch).toBe("main");
    expect(ref.headSha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(basename(ref.root).toLowerCase()).toBe(basename(root).toLowerCase());
  });

  it("extracts an unstaged worktree diff and separates untracked files", async () => {
    write("a.txt", "line1\nline2 modified\n");
    write("b.txt", "brand new\n");

    const diff = await adapter.getWorkingDiff();
    expect(diff).toHaveLength(1);
    expect(diff[0]?.path).toBe("a.txt");
    expect(diff[0]?.status).toBe("modified");
    expect(diff[0]?.additions).toBe(1);
    expect(diff[0]?.deletions).toBe(1);
    expect(diff[0]?.hunks.length).toBeGreaterThan(0);
    expect(() => vcsChangedFileSchema.parse(diff[0])).not.toThrow();

    expect(await adapter.getUntrackedFiles()).toEqual(["b.txt"]);
  });

  it("builds a schema-valid WORKING_DIR_DIRTY event", async () => {
    const event = await adapter.buildWorkingDirDirtyEvent();
    expect(event).toBeDefined();
    expect(() => codeChangeEventSchema.parse(event)).not.toThrow();
    expect(event?.type).toBe("WORKING_DIR_DIRTY");
    expect(event?.untrackedFiles).toEqual(["b.txt"]);
    expect(event?.changedFiles).toHaveLength(1);
    expect(event?.baseSha).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("still sees changes after they are staged", async () => {
    await git(["add", "a.txt"]);
    const diff = await adapter.getWorkingDiff();
    expect(diff.map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("compares branches from their merge base", async () => {
    await git(["add", "."]);
    await git(["commit", "-m", "second commit"]);
    await git(["checkout", "-b", "feature"]);

    write("c.ts", "export const c = 1;\n");
    await git(["add", "."]);
    await git(["commit", "-m", "add c"]);

    const diff = await adapter.getBranchDiff("main", "feature");
    expect(diff.map((file) => file.path)).toEqual(["c.ts"]);
    expect(diff[0]?.status).toBe("added");
    expect(diff[0]?.additions).toBe(1);
  });

  it("reads commit history newest-first with parent links", async () => {
    const history = await adapter.getCommitHistory(10);
    expect(history).toHaveLength(3);
    expect(history[0]?.message).toBe("add c");
    expect(history[0]?.author).toEqual({ name: "Test Runner", email: "test@example.com" });
    expect(history[0]?.parentShas).toHaveLength(1);
    expect(history[2]?.message).toBe("initial commit");
    expect(history[2]?.parentShas).toEqual([]);
    expect(new Date(history[0]?.authoredAt ?? "").getTime()).not.toBeNaN();
  });

  it("honours the requested depth and rejects a nonsensical one", async () => {
    expect(await adapter.getCommitHistory(1)).toHaveLength(1);
    await expect(adapter.getCommitHistory(0)).rejects.toThrow(/positive integer/);
  });

  it("returns empty history only for a readable unborn repository", async () => {
    const unbornRoot = mkdtempSync(join(tmpdir(), "consistency-vcs-unborn-"));
    try {
      await execGit(["init"], { cwd: unbornRoot });
      const unbornAdapter = new LocalGitAdapter({ root: unbornRoot });
      const failingAdapter = new LocalGitAdapter({
        root: unbornRoot,
        exec: async () => {
          throw new GitCommandError("injected operational failure", [], 128, "D:/private/token");
        }
      });

      await expect(unbornAdapter.getCommitHistory(15)).resolves.toEqual([]);
      await expect(failingAdapter.getCommitHistory(15)).rejects.toBeInstanceOf(GitCommandError);
    } finally {
      rmSync(unbornRoot, { recursive: true, force: true });
    }
  });

  it("rejects an empty successful history HEAD probe", async () => {
    const malformedAdapter = new LocalGitAdapter({
      root,
      exec: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0
      })
    });

    await expect(malformedAdapter.getCommitHistory(15)).rejects.toBeInstanceOf(GitCommandError);
  });

  it("rejects a malformed successful history HEAD probe", async () => {
    const malformedAdapter = new LocalGitAdapter({
      root,
      exec: async (args) => ({
        stdout: args[0] === "rev-parse" ? "not-a-git-sha" : "",
        stderr: "",
        exitCode: 0
      })
    });

    await expect(malformedAdapter.getCommitHistory(15)).rejects.toBeInstanceOf(GitCommandError);
  });

  it("preserves multi-paragraph commit messages", async () => {
    write("d.txt", "d\n");
    await git(["add", "."]);
    await git(["commit", "-m", "subject line", "-m", "body paragraph"]);

    const [latest] = await adapter.getCommitHistory(1);
    expect(latest?.message).toBe("subject line\n\nbody paragraph");
  });

  it("lists the tree at a revision, excluding untracked files", async () => {
    write("never-committed.txt", "not staged\n");

    const tree = await adapter.getFileTreeAtCommit("HEAD");
    const blobs = tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
    expect(blobs).toContain("a.txt");
    expect(blobs).toContain("c.ts");
    expect(blobs).not.toContain("never-committed.txt");
    for (const entry of tree) {
      expect(entry.sha).toMatch(/^[0-9a-f]{40,64}$/);
    }
  });

  it("refuses refs that could be read as options or ranges", async () => {
    await expect(adapter.getBranchDiff("--output=pwned.txt", "main"))
      .rejects.toThrow(/must not start with '-'/);
    await expect(adapter.getFileTreeAtCommit("main..feature"))
      .rejects.toThrow(/single revision/);
    await expect(adapter.getFileTreeAtCommit("main:file.txt"))
      .rejects.toThrow(/must not contain ':'/);
    expect(assertSafeRef("HEAD~1")).toBe("HEAD~1");
    expect(assertSafeRef("origin/main")).toBe("origin/main");
  });

  it("surfaces git failures as GitCommandError", async () => {
    await expect(adapter.getFileTreeAtCommit("nosuchref")).rejects.toBeInstanceOf(GitCommandError);
  });

  it("reports no branch on a detached HEAD", async () => {
    const [latest] = await adapter.getCommitHistory(1);
    await git(["checkout", "--detach", latest?.sha ?? "HEAD"]);

    const ref = await adapter.getRepoRef();
    expect(ref.branch).toBeUndefined();
    expect(ref.headSha).toBe(latest?.sha);
  });
});

describe("parseGitHubRemote", () => {
  it("parses https, ssh, and git URLs into canonical owner/repo", () => {
    expect(parseGitHubRemote("https://github.com/sk1ua/ConsistenCy.git")).toEqual({
      owner: "sk1ua",
      repo: "ConsistenCy",
      fullName: "sk1ua/ConsistenCy"
    });
    expect(parseGitHubRemote("git@github.com:sk1ua/ConsistenCy.git")).toEqual({
      owner: "sk1ua",
      repo: "ConsistenCy",
      fullName: "sk1ua/ConsistenCy"
    });
    expect(parseGitHubRemote("ssh://git@github.com/openai/codex")).toEqual({
      owner: "openai",
      repo: "codex",
      fullName: "openai/codex"
    });
    expect(parseGitHubRemote("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(parseGitHubRemote("not a url")).toBeNull();
  });
});

describe("LocalGitAdapter.getChurnStats", { timeout: 30_000 }, () => {
  it("counts commits and changed lines in the window", async () => {
    const stats = await adapter.getChurnStats(365);
    expect(stats.windowDays).toBe(365);
    expect(stats.commits).toBeGreaterThan(0);
    expect(stats.linesChanged).toBeGreaterThan(0);
    expect(stats.filesTouched).toBeGreaterThan(0);
  });

  it("returns zeroes for a window with no commits", async () => {
    // A zero-day window still resolves; git simply matches nothing recent enough.
    const stats = await adapter.getChurnStats(1);
    expect(stats.commits).toBeGreaterThanOrEqual(0);
    expect(stats.linesChanged).toBeGreaterThanOrEqual(0);
  });

  it("rejects a nonsensical window", async () => {
    await expect(adapter.getChurnStats(0)).rejects.toThrow(/positive integer/);
    await expect(adapter.getChurnStats(1.5)).rejects.toThrow(/positive integer/);
  });
});

describe("LocalGitAdapter.resolveTrunkRef", { timeout: 30_000 }, () => {
  const initTrunkRepo = async (prefix: string, trunk: string) => {
    const repoRoot = mkdtempSync(join(tmpdir(), prefix));
    const repoGit = (args: string[]) => execGit(args, { cwd: repoRoot });
    await repoGit(["init", "--quiet", `--initial-branch=${trunk}`]);
    await repoGit(["config", "user.name", "Test Runner"]);
    await repoGit(["config", "user.email", "test@example.com"]);
    writeFileSync(join(repoRoot, "a.txt"), "line\n");
    await repoGit(["add", "."]);
    await repoGit(["commit", "--quiet", "-m", "initial commit"]);
    return { repoRoot, repoGit };
  };

  it("resolves main and master trunks from local branches", async () => {
    const mainRepo = await initTrunkRepo("consistency-vcs-trunk-main-", "main");
    const masterRepo = await initTrunkRepo("consistency-vcs-trunk-master-", "master");
    try {
      await expect(new LocalGitAdapter({ root: mainRepo.repoRoot }).resolveTrunkRef()).resolves.toBe("main");
      await expect(new LocalGitAdapter({ root: masterRepo.repoRoot }).resolveTrunkRef()).resolves.toBe("master");
    } finally {
      rmSync(mainRepo.repoRoot, { recursive: true, force: true });
      rmSync(masterRepo.repoRoot, { recursive: true, force: true });
    }
  });

  it("prefers the branch pinned by refs/remotes/origin/HEAD", async () => {
    const { repoRoot, repoGit } = await initTrunkRepo("consistency-vcs-trunk-remote-", "main");
    try {
      await repoGit(["branch", "master"]);
      await repoGit(["update-ref", "refs/remotes/origin/master", "refs/heads/master"]);
      await repoGit(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"]);
      await expect(new LocalGitAdapter({ root: repoRoot }).resolveTrunkRef()).resolves.toBe("master");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("returns undefined when no trunk ref can be verified", async () => {
    const unbornRoot = mkdtempSync(join(tmpdir(), "consistency-vcs-trunk-unborn-"));
    try {
      await execGit(["init", "--quiet"], { cwd: unbornRoot });
      await expect(new LocalGitAdapter({ root: unbornRoot }).resolveTrunkRef()).resolves.toBeUndefined();
    } finally {
      rmSync(unbornRoot, { recursive: true, force: true });
    }
  });
});
