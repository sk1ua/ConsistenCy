/**
 * RepositorySnapshot tests — AC-SNAP-1 … AC-SNAP-6.
 *
 * Uses throwaway temporary Git repositories created by the tests. All
 * immutability proofs rely on Git object-database reads, never the mutable
 * working tree.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  RepositorySnapshot,
  SnapshotDiffUnavailableError,
  SnapshotFileNotFoundError,
  SnapshotPathError,
  asRepositorySnapshotId,
  parseSnapshotUri,
} from "../index.js";

const TMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-snap-"));
  TMP_DIRS.push(dir);
  return dir;
}

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

interface Fixture {
  readonly repoPath: string;
  readonly shaA: string;
  readonly shaB: string;
}

/** Create a temp repo with commit A (two files) and commit B (one changed, one added). */
function makeRepo(): Fixture {
  const repoPath = makeTempDir();
  git(repoPath, ["init", "-q"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);

  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "src", "a.ts"), "content A1\n", "utf8");
  fs.writeFileSync(path.join(repoPath, "README.md"), "# repo\n", "utf8");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", "A"]);
  const shaA = git(repoPath, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(repoPath, "src", "a.ts"), "content B2\n", "utf8");
  fs.writeFileSync(path.join(repoPath, "src", "b.ts"), "new file\n", "utf8");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", "B"]);
  const shaB = git(repoPath, ["rev-parse", "HEAD"]);

  return { repoPath, shaA, shaB };
}

function snapshotAt(repo: Fixture, sha: string, baseSha?: string) {
  return RepositorySnapshot.create({
    repositoryPath: repo.repoPath,
    repository: "test/example",
    headSha: sha,
    baseSha,
  });
}

describe("RepositorySnapshot — immutability and path safety", () => {
  it("AC-SNAP-1: a snapshot at a SHA reads the correct file content", () => {
    const repo = makeRepo();
    const snapA = snapshotAt(repo, repo.shaA);
    expect(snapA.readFile("src/a.ts").content).toBe("content A1\n");
    expect(snapA.readFile("README.md").content).toBe("# repo\n");
    expect(snapA.identity().headSha).toBe(repo.shaA);

    const snapB = snapshotAt(repo, repo.shaB);
    expect(snapB.readFile("src/a.ts").content).toBe("content B2\n");
    expect(snapB.listFiles()).toContain("src/b.ts");
  });

  it("AC-SNAP-2: later working-tree mutations never alter an existing snapshot", () => {
    const repo = makeRepo();
    const snapA = snapshotAt(repo, repo.shaA);

    // Mutate the working tree AND add commit C.
    fs.writeFileSync(path.join(repo.repoPath, "src", "a.ts"), "WORKTREE HACK\n", "utf8");
    fs.writeFileSync(path.join(repo.repoPath, "hacked.txt"), "uncommitted\n", "utf8");
    git(repo.repoPath, ["add", "."]);
    git(repo.repoPath, ["commit", "-q", "-m", "C"]);
    const shaC = git(repo.repoPath, ["rev-parse", "HEAD"]);

    // The old snapshot still sees A's state — object database reads only.
    expect(snapA.readFile("src/a.ts").content).toBe("content A1\n");
    expect(snapA.listFiles()).not.toContain("hacked.txt");
    expect(snapA.listFiles()).not.toContain("src/b.ts");

    // A new snapshot at C sees the new state.
    const snapC = snapshotAt(repo, shaC);
    expect(snapC.readFile("src/a.ts").content).toBe("WORKTREE HACK\n");
    expect(snapC.listFiles()).toContain("hacked.txt");
  });

  it("AC-SNAP-3: two snapshots of the same SHA are semantically equivalent", () => {
    const repo = makeRepo();
    const snap1 = RepositorySnapshot.create({
      repositoryPath: repo.repoPath,
      repository: "test/example",
      headSha: repo.shaA,
      snapshotId: asRepositorySnapshotId("snap_one"),
    });
    const snap2 = RepositorySnapshot.create({
      repositoryPath: repo.repoPath,
      repository: "test/example",
      headSha: repo.shaA,
      snapshotId: asRepositorySnapshotId("snap_two"),
    });

    expect(snap1.listFiles()).toEqual(snap2.listFiles());
    for (const file of snap1.listFiles()) {
      expect(snap1.readFile(file)).toEqual(snap2.readFile(file));
    }
    expect(snap1.identity()).toEqual(snap2.identity());
    // Instance ids may differ; semantic identity does not.
    expect(snap1.id).not.toBe(snap2.id);
    expect(snap1.uri()).toBe("snapshot://test/example/snap_one");
    expect(parseSnapshotUri(snap1.uri()).snapshotId).toBe(snap1.id);
  });

  it("AC-SNAP-4: path traversal is rejected", () => {
    const repo = makeRepo();
    const snap = snapshotAt(repo, repo.shaA);
    for (const bad of ["../secret", "src/../../etc/passwd", "a/..", "..\\secret"]) {
      expect(() => snap.readFile(bad)).toThrow(SnapshotPathError);
      expect(() => snap.getFileMetadata(bad)).toThrow(SnapshotPathError);
    }
  });

  it("AC-SNAP-5: absolute paths are rejected", () => {
    const repo = makeRepo();
    const snap = snapshotAt(repo, repo.shaA);
    for (const bad of ["/etc/passwd", "C:\\Windows\\win.ini", "\\\\server\\share", "//etc/passwd"]) {
      expect(() => snap.readFile(bad)).toThrow(SnapshotPathError);
    }
    expect(() => snap.readFile("src/\0nul.ts")).toThrow(SnapshotPathError);
  });

  it("AC-SNAP-6: Windows separators are normalized to repository-relative /", () => {
    const repo = makeRepo();
    const snap = snapshotAt(repo, repo.shaA);
    const viaWindows = snap.readFile("src\\a.ts");
    expect(viaWindows.path).toBe("src/a.ts");
    expect(viaWindows.content).toBe("content A1\n");
    expect(viaWindows).toEqual(snap.readFile("src/a.ts"));
    expect(snap.getFileMetadata("src\\a.ts").path).toBe("src/a.ts");
  });

  it("base/head diff is deterministic and requires baseSha", () => {
    const repo = makeRepo();
    const withBase = snapshotAt(repo, repo.shaB, repo.shaA);
    // Ordered by (status asc, path asc): added before modified.
    expect(withBase.getDiff()).toEqual([
      { path: "src/b.ts", status: "added" },
      { path: "src/a.ts", status: "modified" },
    ]);

    const noBase = snapshotAt(repo, repo.shaB);
    expect(() => noBase.getDiff()).toThrow(SnapshotDiffUnavailableError);

    // Deletion shows up as status deleted.
    fs.rmSync(path.join(repo.repoPath, "README.md"));
    git(repo.repoPath, ["add", "-A"]);
    git(repo.repoPath, ["commit", "-q", "-m", "D"]);
    const shaD = git(repo.repoPath, ["rev-parse", "HEAD"]);
    expect(snapshotAt(repo, shaD, repo.shaB).getDiff()).toEqual([
      { path: "README.md", status: "deleted" },
    ]);
  });

  it("fail closed: missing files and unknown SHAs", () => {
    const repo = makeRepo();
    const snap = snapshotAt(repo, repo.shaA);
    expect(() => snap.readFile("does-not-exist.ts")).toThrow(SnapshotFileNotFoundError);
    expect(() => snap.getFileMetadata("does-not-exist.ts")).toThrow(SnapshotFileNotFoundError);

    expect(() =>
      RepositorySnapshot.create({
        repositoryPath: repo.repoPath,
        repository: "test/example",
        headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    ).toThrow(/headSha does not exist/);
  });

  it("file metadata exposes the git blob sha deterministically", () => {
    const repo = makeRepo();
    const snapA = snapshotAt(repo, repo.shaA);
    const snapB = snapshotAt(repo, repo.shaB);
    const metaA = snapA.getFileMetadata("src/a.ts");
    const metaB = snapB.getFileMetadata("src/a.ts");
    expect(metaA.blobSha).toMatch(/^[0-9a-f]{40}$/);
    expect(metaA.blobSha).not.toBe(metaB.blobSha); // different content → different blob
  });
});
