/**
 * Working-tree review snapshot persistence (audit P1-01).
 *
 * A working-tree review has no head commit to pin, so the change surface the
 * review analyzed is persisted at context capture. The acceptance scenario
 * mandated by supervision: build a review over a working tree containing
 * staged, unstaged, untracked, deleted, and renamed changes; then rewrite the
 * working tree AND restart the store (fresh process state, same database
 * file). The old job's diff must still resolve the review-time content, a new
 * review must capture the new content, and `.consistencyignore` plus the
 * secret-path boundary must hold throughout.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKING_TREE_REV, type ReviewSnapshot, type VcsChangedFile } from "@consistency/schema";
import { execGit } from "@consistency/vcs-core";
import { applyModelContentPolicy, changedLineRanges } from "@consistency/workload-review";
import { openDatabase, type ConsistencyDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { SQLiteJobStore } from "../jobs/sqliteJobStore";
import { createContextBuilder } from "./context/contextRouter";
import { resolveJobDiff } from "./jobDiff";

const CUSTOM_UNMARKED_VALUE = "no-regex-marker-771234";

let repoRoot: string;
let dataRoot: string;
const openDatabases: ConsistencyDatabase[] = [];
const git = async (args: string[]) => (await execGit(args, { cwd: repoRoot })).stdout.trim();
const write = (name: string, content: string) => writeFileSync(join(repoRoot, name), content);

beforeAll(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), "consistency-snap-repo-"));
  dataRoot = mkdtempSync(join(tmpdir(), "consistency-snap-db-"));
  await git(["init"]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(["config", "user.name", "Test Runner"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "commit.gpgsign", "false"]);

  write("package.json", JSON.stringify({ name: "snapshot-fixture" }));
  write("staged.ts", "export const staged = 1;\n");
  write("dirty.ts", "export const dirty = 1;\n");
  write("doomed.ts", "export const doomed = 1;\n");
  write("moved-old.ts", "export const moved = 1;\n");
  write(".env.production", `BASE_SETTING=one\n`);
  write(".consistencyignore", "generated-skip.ts\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial commit"]);
}, 60_000);

afterAll(() => {
  for (const database of openDatabases.splice(0)) {
    try { database.close(); } catch { /* already closed */ }
  }
  for (const directory of [repoRoot, dataRoot]) {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function openStore(): SQLiteJobStore {
  const database = openDatabase(join(dataRoot, "jobs.db"));
  openDatabases.push(database);
  runMigrations(database);
  return new SQLiteJobStore(database);
}

function makeBuilder(store: SQLiteJobStore) {
  return createContextBuilder({
    // The GitHub branch is unreachable for local_git inputs; a throwing stub
    // keeps this test honest about which path is exercised.
    github: (() => {
      throw new Error("github context builder must not be reached");
    }) as never,
    onWorkingTreeSurface: capture => {
      const snapshot: ReviewSnapshot = {
        jobId: capture.jobId,
        baseSha: capture.baseSha,
        headSha: WORKING_TREE_REV,
        files: capture.files,
        ...(capture.fileContents !== undefined ? { fileContents: capture.fileContents } : {}),
        ...(capture.baseFileContents !== undefined ? { baseFileContents: capture.baseFileContents } : {}),
        capturedAt: new Date().toISOString()
      };
      store.saveReviewSnapshot(snapshot);
    }
  });
}

function hunkLineRanges(file: VcsChangedFile): Array<{ start: number; end: number }> {
  return file.hunks.map(hunk => ({
    start: hunk.newStart,
    end: hunk.newStart + Math.max(hunk.newLines, 1) - 1
  }));
}

describe("working-tree review snapshot persistence (audit P1-01)", () => {
  it("review-time surface survives working-tree drift AND a store restart", async () => {
    const store = openStore();

    // --- Review-time working tree: staged, unstaged, untracked, deleted,
    // --- renamed, a modified tracked secret path, and an excluded file.
    write("staged.ts", "export const staged = 2; // review-time\n");
    await git(["add", "staged.ts"]);
    write("dirty.ts", "export const dirty = 2; // review-time\n");
    write("fresh.ts", "export const fresh = true; // review-time\n");
    await git(["rm", "-q", "--", "doomed.ts"]);
    await git(["mv", "moved-old.ts", "moved-new.ts"]);
    write(".env.production", `BASE_SETTING=one\nCUSTOM_UNMARKED_SETTING=${CUSTOM_UNMARKED_VALUE}\n`);
    write("generated-skip.ts", "export const excluded = true;\n");

    const headAtCapture = (await git(["rev-parse", "HEAD"])).trim();
    const job = store.enqueue({
      kind: "pull_request",
      repository: basename(repoRoot),
      repoPath: repoRoot,
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: headAtCapture,
      headSha: WORKING_TREE_REV,
      action: "local_trigger"
    });

    const context = await makeBuilder(store)({
      jobId: job.id,
      repositoryFullName: basename(repoRoot),
      repoPath: repoRoot,
      accessMode: "local_git",
      baseSha: headAtCapture,
      headSha: WORKING_TREE_REV
    });

    // The excluded file never entered the review surface at capture time.
    expect(context.changedFiles.map(file => file.path)).not.toContain("generated-skip.ts");
    // The tracked secret path IS part of the analysis surface (the local
    // secret detector needs it), and its diff section exists in raw form...
    expect(context.changedFiles.some(file => file.path === ".env.production")).toBe(true);
    expect(context.diff).toContain(CUSTOM_UNMARKED_VALUE);
    // ...but the model-visible projection drops the whole section (P0-01).
    expect(applyModelContentPolicy(context).diff).not.toContain(CUSTOM_UNMARKED_VALUE);
    expect(applyModelContentPolicy(context).diff).not.toContain(".env.production");

    const captured = store.getReviewSnapshot(job.id);
    expect(captured).toBeDefined();
    expect(captured!.baseSha).toBe(headAtCapture);
    // Batch 2 (audit P1-06③): the capture also carries the review-time
    // content of changed files — loader-redacted and secret-path-free.
    expect(captured!.fileContents?.["staged.ts"]).toContain("export const staged = 2; // review-time");
    expect(captured!.fileContents?.["dirty.ts"]).toContain("export const dirty = 2; // review-time");
    expect(captured!.fileContents?.[".env.production"]).toBeUndefined();
    expect(captured!.fileContents?.["doomed.ts"]).toBeUndefined();
    expect(captured!.baseFileContents?.["staged.ts"]).toContain("export const staged = 1;");
    expect(captured!.baseFileContents?.["dirty.ts"]).toContain("export const dirty = 1;");
    expect(captured!.baseFileContents?.["doomed.ts"]).toContain("export const doomed = 1;");
    expect(captured!.baseFileContents?.["moved-new.ts"]).toContain("export const moved = 1;");
    expect(captured!.baseFileContents?.["moved-old.ts"]).toContain("export const moved = 1;");
    expect(captured!.baseFileContents?.["fresh.ts"]).toBeUndefined();

    // --- Drift: commit everything, then mutate the tree further.
    await git(["add", "-A"]);
    await git(["commit", "-m", "commit the reviewed working tree"]);
    write("dirty.ts", "export const dirty = 3; // post-review\n");
    await git(["rm", "-q", "--", "fresh.ts"]);
    write("late.ts", "export const late = true;\n");

    // --- Restart: a NEW store instance on the SAME database file. Nothing
    // --- in memory survives; only durable rows can answer.
    const restarted = openStore();

    const result = await resolveJobDiff(job.id, { jobs: restarted, workspaceRoot: dataRoot });
    expect(result.available).toBe(true);
    expect(result.pinned).toBe(true);

    // Batch 2: the review-time file contents survived the restart too.
    const snapshotAfterRestart = restarted.getReviewSnapshot(job.id);
    expect(snapshotAfterRestart?.fileContents?.["dirty.ts"]).toContain("export const dirty = 2; // review-time");
    expect(snapshotAfterRestart?.baseFileContents?.["staged.ts"]).toContain("export const staged = 1;");
    expect(snapshotAfterRestart?.baseFileContents?.["moved-new.ts"]).toContain("export const moved = 1;");

    const byPath = new Map(result.files.map(file => [file.path, file]));
    const surface = captured!.files;

    // Every review-time change kind resolves from the snapshot, byte-stable.
    expect(result.files).toEqual(surface);

    const staged = byPath.get("staged.ts");
    const stagedText = staged?.hunks.map(hunk => `${hunk.header}\n${hunk.content}`).join("\n") ?? "";
    expect(stagedText).toContain("+export const staged = 2; // review-time");

    const dirty = byPath.get("dirty.ts");
    const dirtyText = dirty?.hunks.map(hunk => `${hunk.header}\n${hunk.content}`).join("\n") ?? "";
    expect(dirtyText).toContain("+export const dirty = 2; // review-time");
    expect(dirtyText).not.toContain("export const dirty = 3; // post-review");

    expect(byPath.get("fresh.ts")?.status).toBe("untracked");
    expect(byPath.get("doomed.ts")?.status).toBe("deleted");
    const renamed = byPath.get("moved-new.ts");
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.previousPath).toBe("moved-old.ts");

    // Post-review drift never appears in the old job's diff.
    expect(byPath.has("late.ts")).toBe(false);

    // Evidence alignment: a finding confirmed against the review-time staged
    // hunk still intersects the persisted hunk ranges.
    const stagedRanges = hunkLineRanges(staged!);
    const findingLine = 1;
    expect(stagedRanges.some(range => findingLine >= range.start && findingLine <= range.end)).toBe(true);
    // And the patch-derived ranges agree (same grounding math as production).
    const changedFile = context.changedFiles.find(file => file.path === "staged.ts");
    expect(changedLineRanges(changedFile!.patch)).not.toHaveLength(0);

    // --- A NEW review after the drift captures the NEW content.
    const newHead = (await git(["rev-parse", "HEAD"])).trim();
    const job2 = restarted.enqueue({
      kind: "pull_request",
      repository: basename(repoRoot),
      repoPath: repoRoot,
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: newHead,
      headSha: WORKING_TREE_REV,
      action: "local_trigger"
    });
    const context2 = await makeBuilder(restarted)({
      jobId: job2.id,
      repositoryFullName: basename(repoRoot),
      repoPath: repoRoot,
      accessMode: "local_git",
      baseSha: newHead,
      headSha: WORKING_TREE_REV
    });
    expect(context2.diff).toContain("+export const dirty = 3; // post-review");
    expect(context2.diff).toContain("late.ts");
    // fresh.ts was deleted after the drift commit, so the NEW review reports
    // it as removed (its old content legitimately appears as minus lines).
    expect(context2.changedFiles.find(file => file.path === "fresh.ts")?.status).toBe("removed");
    expect(context2.changedFiles.find(file => file.path === "late.ts")?.status).toBe("added");

    const result2 = await resolveJobDiff(job2.id, { jobs: restarted, workspaceRoot: dataRoot });
    expect(result2.pinned).toBe(true);
    expect(result2.files.map(file => file.path)).toContain("dirty.ts");
    expect(result2.files.map(file => file.path)).not.toContain("doomed.ts");
  }, 60_000);

  it("legacy working-tree jobs without a snapshot fall back to a live read marked unpinned", async () => {
    const store = openStore();
    const head = (await git(["rev-parse", "HEAD"])).trim();
    const legacy = store.enqueue({
      kind: "pull_request",
      repository: basename(repoRoot),
      repoPath: repoRoot,
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: head,
      headSha: WORKING_TREE_REV,
      action: "local_trigger"
    });

    const result = await resolveJobDiff(legacy.id, { jobs: store, workspaceRoot: dataRoot });
    expect(result.available).toBe(true);
    // Honest drift disclosure: no review-time snapshot exists for this job,
    // so the diff is the CURRENT working tree and is labeled as unpinned.
    expect(result.pinned).toBe(false);
    expect(result.files.some(file => file.path === "dirty.ts")).toBe(true);
  }, 60_000);

  it("committed-range local jobs remain SHA-pinned", async () => {
    const store = openStore();
    await git(["add", "-A"]);
    await git(["commit", "-m", "range head"]);
    const head = (await git(["rev-parse", "HEAD"])).trim();
    const base = (await git(["rev-parse", "HEAD~1"])).trim();
    const rangeJob = store.enqueue({
      kind: "pull_request",
      repository: basename(repoRoot),
      repoPath: repoRoot,
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: base,
      headSha: head,
      action: "local_trigger"
    });

    const result = await resolveJobDiff(rangeJob.id, { jobs: store, workspaceRoot: dataRoot });
    expect(result.available).toBe(true);
    expect(result.pinned).toBe(true);
  }, 60_000);
});
