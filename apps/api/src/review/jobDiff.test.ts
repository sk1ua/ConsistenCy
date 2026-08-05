import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKING_TREE_REV, type IVCSService, type VcsChangedFile } from "@consistency/schema";
import { InMemoryJobQueue } from "../jobQueue";
import { JobDiffError, MAX_DIFF_BYTES, MAX_DIFF_FILES, resolveJobDiff } from "./jobDiff";

function changedFile(path: string, content = "line\n"): VcsChangedFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    binary: false,
    hunks: [{
      header: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      content
    }]
  };
}

function fakeVcs(files: VcsChangedFile[]): IVCSService {
  return {
    provider: "local_git",
    getWorkingDiff: vi.fn(async () => files),
    getBranchDiff: vi.fn(async () => files),
    getCommitHistory: vi.fn(async () => []),
    getUntrackedFiles: vi.fn(async () => []),
    getFileTreeAtCommit: vi.fn(async () => [])
  };
}

describe("resolveJobDiff", () => {
  let root: string;
  let jobs: InMemoryJobQueue;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "job-diff-"));
    jobs = new InMemoryJobQueue();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("diffs the working tree for local jobs with WORKING_TREE_REV", async () => {
    const vcs = fakeVcs([changedFile("a.py")]);
    const job = jobs.enqueue({
      kind: "pull_request",
      repository: "repo",
      repoPath: root,
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: "a".repeat(40),
      headSha: WORKING_TREE_REV,
      action: "local_trigger"
    });
    const result = await resolveJobDiff(job.id, { jobs, workspaceRoot: root, vcsFactory: () => vcs });
    expect(result.available).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(vcs.getWorkingDiff).toHaveBeenCalledOnce();
  });

  it("diffs a committed range for local jobs", async () => {
    const vcs = fakeVcs([changedFile("b.py")]);
    const job = jobs.enqueue({
      kind: "pull_request",
      repository: "repo",
      repoPath: root,
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      action: "local_trigger"
    });
    const result = await resolveJobDiff(job.id, { jobs, workspaceRoot: root, vcsFactory: () => vcs });
    expect(result.available).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(vcs.getBranchDiff).toHaveBeenCalledWith("a".repeat(40), "b".repeat(40));
  });

  it("reports unavailable when a PR workspace has been cleaned up", async () => {
    const job = jobs.enqueue({
      kind: "pull_request",
      repository: "owner/repo",
      pullRequestNumber: 1,
      accessMode: "public_read",
      publicationPolicy: "disabled",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40)
    });
    const result = await resolveJobDiff(job.id, { jobs, workspaceRoot: root });
    expect(result).toEqual({ files: [], available: false });
  });

  it("rejects diffs beyond the file and byte budgets", async () => {
    const tooMany = Array.from({ length: MAX_DIFF_FILES + 1 }, (_, index) => changedFile(`f${index}.py`));
    await expect(resolveJobDiff(jobWith("too-many"), { jobs, workspaceRoot: root, vcsFactory: () => fakeVcs(tooMany) }))
      .rejects.toMatchObject({ code: "DIFF_TOO_LARGE", statusCode: 413 });

    const huge = changedFile("huge.py", `x\n`.repeat(MAX_DIFF_BYTES / 2 + 1));
    await expect(resolveJobDiff(jobWith("huge"), { jobs, workspaceRoot: root, vcsFactory: () => fakeVcs([huge]) }))
      .rejects.toMatchObject({ code: "DIFF_TOO_LARGE", statusCode: 413 });
  });

  function jobWith(repository: string) {
    return jobs.enqueue({
      kind: "pull_request",
      repository,
      repoPath: root,
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: "a".repeat(40),
      headSha: WORKING_TREE_REV,
      action: "local_trigger"
    }).id;
  }

  it("surfaces unknown jobs as 404", async () => {
    await expect(resolveJobDiff("job_missing", { jobs, workspaceRoot: root }))
      .rejects.toMatchObject({ code: "JOB_NOT_FOUND", statusCode: 404 });
  });
});
