import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKING_TREE_REV, type IVCSService, type VcsChangedFile } from "@consistency/schema";
import { InMemoryJobQueue } from "../jobQueue";
import { LocalTriggerError, triggerLocalReview } from "./local";

const ALLOWED_ROOT = resolve("D:/workspaces");
const REPO = join(ALLOWED_ROOT, "ConsistenCy");

const dirtyFile: VcsChangedFile = {
  path: "src/app.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  binary: false,
  hunks: []
};

/** Ref name -> immutable commit the fake checkout would resolve to. */
const PINNED_REVISIONS: Record<string, string | undefined> = {
  main: "b".repeat(40),
  feature: "c".repeat(40)
};

type RevisionResolvingFake = IVCSService & {
  resolveRevision(revision: string): Promise<string | undefined>;
};

function fakeVcs(overrides: Partial<RevisionResolvingFake> = {}): RevisionResolvingFake {
  return {
    provider: "local_git",
    getWorkingDiff: async () => [dirtyFile],
    getBranchDiff: async () => [dirtyFile],
    getCommitHistory: async () => [{
      sha: "a".repeat(40),
      parentShas: [],
      author: { name: "Test Runner", email: "test@example.com" },
      authoredAt: "2026-08-05T00:00:00.000Z",
      message: "initial commit"
    }],
    getUntrackedFiles: async () => [],
    getFileTreeAtCommit: async () => [],
    resolveRevision: async revision => PINNED_REVISIONS[revision],
    ...overrides
  };
}

const deps = (overrides: Partial<Parameters<typeof triggerLocalReview>[2]> = {}) => ({
  allowedRoots: [ALLOWED_ROOT],
  vcsFactory: () => fakeVcs(),
  ...overrides
});

describe("triggerLocalReview", () => {
  it("enqueues a non-publishing local job for a dirty worktree", async () => {
    const jobs = new InMemoryJobQueue();
    const { jobId } = await triggerLocalReview(jobs, { repoPath: REPO }, deps());

    const job = jobs.get(jobId)!;
    expect(job.accessMode).toBe("local_git");
    expect(job.repoPath).toBe(REPO);
    expect(job.repository).toBe("ConsistenCy");
    expect(job.pullRequestNumber).toBeUndefined();
    expect(job.installationId).toBeUndefined();
    expect(job.headSha).toBe(WORKING_TREE_REV);
    expect(job.baseSha).toBe("a".repeat(40));
    // A local review has nowhere to publish to.
    expect(job.publicationPolicy).toBe("disabled");
  });

  it("pins queued jobs to immutable revisions rather than ref names", async () => {
    const jobs = new InMemoryJobQueue();
    let diffArgs: readonly [string, string] | undefined;
    const { jobId } = await triggerLocalReview(
      jobs,
      { repoPath: REPO, baseRef: "main", headRef: "feature" },
      deps({
        vcsFactory: () => fakeVcs({
          getBranchDiff: async (base, head) => {
            diffArgs = [base, head];
            return [dirtyFile];
          }
        })
      })
    );

    // The job must store the resolved commits, not the moving ref names, so
    // branch movement between enqueue and execution cannot change what a local
    // review analyzes or what evidence cites.
    const job = jobs.get(jobId)!;
    expect(job.baseSha).toBe(PINNED_REVISIONS.main);
    expect(job.headSha).toBe(PINNED_REVISIONS.feature);
    expect(diffArgs).toEqual([PINNED_REVISIONS.main, PINNED_REVISIONS.feature]);
  });

  it("declines a range whose revisions cannot be resolved in this repository", async () => {
    const jobs = new InMemoryJobQueue();
    await expect(triggerLocalReview(
      jobs,
      { repoPath: REPO, baseRef: "no-such-base", headRef: "feature" },
      deps()
    )).rejects.toMatchObject({ code: "NOTHING_TO_REVIEW" });
    expect(jobs.list()).toHaveLength(0);
  });

  it("refuses a repository outside the configured roots", async () => {
    const jobs = new InMemoryJobQueue();
    await expect(triggerLocalReview(jobs, { repoPath: resolve("D:/elsewhere/secrets") }, deps()))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(jobs.list()).toHaveLength(0);
  });

  it("refuses a traversal that climbs out of an allowed root", async () => {
    const jobs = new InMemoryJobQueue();
    const escape = join(ALLOWED_ROOT, "..", "elsewhere");
    await expect(triggerLocalReview(jobs, { repoPath: escape }, deps()))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("fails closed when no roots are configured", async () => {
    const jobs = new InMemoryJobQueue();
    await expect(triggerLocalReview(jobs, { repoPath: REPO }, deps({ allowedRoots: [] })))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("does not treat a sibling directory with a shared prefix as inside the root", async () => {
    const jobs = new InMemoryJobQueue();
    await expect(triggerLocalReview(jobs, { repoPath: `${ALLOWED_ROOT}-other` }, deps()))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("allows the configured root itself", async () => {
    const jobs = new InMemoryJobQueue();
    await expect(triggerLocalReview(jobs, { repoPath: ALLOWED_ROOT + sep }, deps()))
      .resolves.toMatchObject({ jobId: expect.stringContaining("job_") });
  });

  it("declines a clean worktree instead of queueing an empty review", async () => {
    const jobs = new InMemoryJobQueue();
    await expect(triggerLocalReview(jobs, { repoPath: REPO }, deps({
      vcsFactory: () => fakeVcs({ getWorkingDiff: async () => [], getUntrackedFiles: async () => [] })
    }))).rejects.toMatchObject({ code: "NOTHING_TO_REVIEW" });
    expect(jobs.list()).toHaveLength(0);
  });

  it("queues a review when only untracked files are present", async () => {
    const jobs = new InMemoryJobQueue();
    await expect(triggerLocalReview(jobs, { repoPath: REPO }, deps({
      vcsFactory: () => fakeVcs({ getWorkingDiff: async () => [], getUntrackedFiles: async () => ["new.ts"] })
    }))).resolves.toBeTruthy();
  });

  it("reports an unreadable repository rather than leaking the git error", async () => {
    const jobs = new InMemoryJobQueue();
    await expect(triggerLocalReview(jobs, { repoPath: REPO }, deps({
      vcsFactory: () => fakeVcs({
        getCommitHistory: async () => { throw new Error("fatal: not a git repository"); }
      })
    }))).rejects.toBeInstanceOf(LocalTriggerError);
  });

  it("rejects a half-specified range", async () => {
    const jobs = new InMemoryJobQueue();
    await expect(triggerLocalReview(jobs, { repoPath: REPO, headRef: "feature" }, deps()))
      .rejects.toMatchObject({ code: "NOTHING_TO_REVIEW" });
  });

  it("handles case-insensitive canonical path equivalence on Windows", async () => {
    const jobs = new InMemoryJobQueue();
    const alternateCasePath = REPO.toLowerCase();
    await expect(triggerLocalReview(jobs, { repoPath: alternateCasePath }, deps()))
      .resolves.toMatchObject({ jobId: expect.stringContaining("job_") });
  });
});
