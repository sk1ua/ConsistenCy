/**
 * H25 — Notebook context and evidence persistence: negative boundaries.
 *
 * Each test reproduces one boundary the Notebook must survive without losing
 * the evidence anchor (file + line range) or the version (job + head SHA):
 *
 *   B1  content past the 64KB read cap               (truncate, never lose source)
 *   B2  base-side missing files / deleted sources    (review input or labeled missing)
 *   B3  binary files                                 (never text, never a crash)
 *   B4  same path in two snapshots                   (no cross-snapshot bleed)
 *   B5  secret redaction                             (anchor + fingerprint survive)
 *
 * Reads must always resolve the REVIEWED bytes: the pinned index slice or the
 * persisted review snapshot — never the live checkout after it has drifted.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKING_TREE_REV } from "@consistency/schema";
import { execGit } from "@consistency/vcs-core";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { InMemoryJobQueue, type ReviewJob } from "../jobQueue";
import { SQLiteJobStore } from "../jobs/sqliteJobStore";
import { MockLLMProvider } from "../review/llm/mockProvider";
import { RepositorySnapshotIndexer } from "./indexer";
import { InMemoryNotebookStore, SQLiteNotebookStore, snapshotIndexHeadSha } from "./store";
import { NotebookGraph } from "./graph";
import {
  NotebookToolError,
  getBaseFile,
  readRepositoryFile,
  searchRepository,
  selectNotebookSources,
  type NotebookSourceSelection
} from "./tools";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempRepo(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function git(directory: string, args: string[]): Promise<string> {
  return (await execGit(args, { cwd: directory })).stdout.trim();
}

async function initRepo(directory: string): Promise<void> {
  await git(directory, ["init", "-q"]);
  await git(directory, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(directory, ["config", "user.name", "Test"]);
  await git(directory, ["config", "user.email", "test@example.com"]);
}

function selectionFor(notebooks: InMemoryNotebookStore, jobs: InMemoryJobQueue, job: ReviewJob): NotebookSourceSelection {
  const notebook = notebooks.findByJobId(job.id)!;
  return selectNotebookSources(notebook.id, notebooks, jobs, [job.id])[0]!;
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function captureAsyncError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectToolError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(NotebookToolError);
  expect((error as NotebookToolError).code).toBe(code);
}

describe("H25 Notebook persistence boundaries", () => {
  it("B1: content past the 64KB read cap is truncated, yet every read keeps its file and SHA anchor", async () => {
    const directory = tempRepo("consistency-h25-large-");
    const header = "export const headMarker = 'served';\n";
    const padding = "// padding line beyond the notebook read cap\n".repeat(2_000);
    const tail = "export const tailMarkerOnlyAfter64KB = true;\n";
    const body = `${header}${padding}${tail}`;
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(64 * 1024);
    writeFileSync(join(directory, "large.ts"), body, "utf8");

    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request", deliveryId: "h25-large", repository: "local/large", accessMode: "local_git",
      baseSha: "a".repeat(40), headSha: WORKING_TREE_REV, repoPath: directory, publicationPolicy: "disabled"
    });
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(jobs.get(job.id)!);
    const indexer = new RepositorySnapshotIndexer({ store: notebooks });
    const index = await indexer.ensure(jobs.get(job.id)!, ensured.source);

    const entry = index.manifest.find(item => item.path === "large.ts");
    expect(entry).toBeDefined();
    // The durable pin is capped at the largest slice any read path serves.
    expect(entry!.content).toBeDefined();
    expect(Buffer.byteLength(entry!.content!, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(entry!.content).not.toContain("tailMarkerOnlyAfter64KB");
    // Metadata still describes the whole file, so the file stays discoverable.
    expect(entry!.bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(entry!.lines).toBeGreaterThan(2_000);

    const selection = selectionFor(notebooks, jobs, job);
    selection.index = index;
    const read = readRepositoryFile(selection, "large.ts", 1, 1);
    expect(read.content).toBe("export const headMarker = 'served';");
    expect(read.citation).toMatchObject({ repository: "local/large", jobId: job.id, headSha: WORKING_TREE_REV, file: "large.ts" });
    expect(read.citation.excerpt.trim().length).toBeGreaterThan(0);

    // A range whose bytes were capped away is a labeled boundary that names the
    // file — never a malformed citation and never a live-disk fallback.
    const tailLine = body.split("\n").findIndex(line => line.includes("tailMarkerOnlyAfter64KB")) + 1;
    expect(tailLine).toBeGreaterThan(2_000);
    const beyond = captureError(() => readRepositoryFile(selection, "large.ts", tailLine, tailLine + 1));
    expectToolError(beyond, "LINES_NOT_AVAILABLE");
    expect((beyond as NotebookToolError).message).toContain("large.ts");
    expect((beyond as NotebookToolError).message).not.toContain("tailMarkerOnlyAfter64KB");
  });

  it("B1: a file above the index byte cap is reported missing instead of summarized", async () => {
    const directory = tempRepo("consistency-h25-huge-");
    writeFileSync(join(directory, "huge.txt"), "x".repeat(600 * 1024), "utf8");
    writeFileSync(join(directory, "small.ts"), "export const small = true;\n", "utf8");

    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request", deliveryId: "h25-huge", repository: "local/huge", accessMode: "local_git",
      baseSha: "b".repeat(40), headSha: WORKING_TREE_REV, repoPath: directory, publicationPolicy: "disabled"
    });
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(jobs.get(job.id)!);
    const index = await new RepositorySnapshotIndexer({ store: notebooks }).ensure(jobs.get(job.id)!, ensured.source);
    expect(index.manifest.some(item => item.path === "huge.txt")).toBe(false);

    const selection = selectionFor(notebooks, jobs, job);
    selection.index = index;
    expectToolError(captureError(() => readRepositoryFile(selection, "huge.txt")), "FILE_NOT_INDEXED");
    expect(searchRepository(selection, "huge").some(match => match.file === "huge.txt")).toBe(false);
  });

  it("B2: after the working tree drifts or a source file is deleted, reads keep the index-time review input", async () => {
    const directory = tempRepo("consistency-h25-drift-");
    await initRepo(directory);
    writeFileSync(join(directory, "drift.ts"), "export const stage = 'reviewed';\n", "utf8");
    writeFileSync(join(directory, "gone.ts"), "export const gone = 'reviewed';\n", "utf8");
    await git(directory, ["add", "."]);
    await git(directory, ["commit", "-q", "-m", "reviewed state"]);
    const headSha = await git(directory, ["rev-parse", "HEAD"]);

    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request", deliveryId: "h25-drift", repository: "local/drift", accessMode: "local_git",
      baseSha: headSha, headSha, repoPath: directory, publicationPolicy: "disabled"
    });
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(jobs.get(job.id)!);
    const index = await new RepositorySnapshotIndexer({ store: notebooks }).ensure(jobs.get(job.id)!, ensured.source);
    const selection = selectionFor(notebooks, jobs, job);
    selection.index = index;
    expect(readRepositoryFile(selection, "drift.ts", 1, 1).content).toBe("export const stage = 'reviewed';");

    // The developer keeps working in the reviewed checkout.
    writeFileSync(join(directory, "drift.ts"), "export const stage = 'post-review-drift';\n", "utf8");
    rmSync(join(directory, "gone.ts"));

    const drifted = readRepositoryFile(selection, "drift.ts", 1, 1);
    expect(drifted.content).toBe("export const stage = 'reviewed';");
    expect(drifted.content).not.toContain("post-review-drift");
    expect(drifted.citation).toMatchObject({ file: "drift.ts", jobId: job.id, headSha });

    // A deleted source resolves its reviewed bytes (or a labeled missing), never
    // an unlabeled failure and never the live tree.
    const deleted = readRepositoryFile(selection, "gone.ts", 1, 1);
    expect(deleted.content).toBe("export const gone = 'reviewed';");
    expect(deleted.citation.headSha).toBe(headSha);

    const answer = searchRepository(selection, "post-review-drift");
    expect(answer.flatMap(match => match.content)).not.toContain("post-review-drift");
  });

  it("B2: base-side missing files are labeled missing — added, deleted, and renamed paths", async () => {
    const directory = tempRepo("consistency-h25-base-");
    await initRepo(directory);
    writeFileSync(join(directory, "deleted.ts"), "export const deleted = 'base-only';\n", "utf8");
    writeFileSync(join(directory, "kept.ts"), "export const kept = 1;\n", "utf8");
    writeFileSync(join(directory, "old-name.ts"), "export const moved = 'base-only';\n", "utf8");
    await git(directory, ["add", "."]);
    await git(directory, ["commit", "-q", "-m", "base"]);
    const baseSha = await git(directory, ["rev-parse", "HEAD"]);

    rmSync(join(directory, "deleted.ts"));
    await git(directory, ["mv", "old-name.ts", "new-name.ts"]);
    writeFileSync(join(directory, "added.ts"), "export const added = 'head-only';\n", "utf8");
    writeFileSync(join(directory, "kept.ts"), "export const kept = 2;\n", "utf8");
    await git(directory, ["add", "."]);
    await git(directory, ["commit", "-q", "-m", "head"]);
    const headSha = await git(directory, ["rev-parse", "HEAD"]);

    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request", deliveryId: "h25-base", repository: "local/base", accessMode: "local_git",
      baseSha, headSha, repoPath: directory, publicationPolicy: "disabled"
    });
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(jobs.get(job.id)!);
    const index = await new RepositorySnapshotIndexer({ store: notebooks }).ensure(jobs.get(job.id)!, ensured.source);
    const selection = selectionFor(notebooks, jobs, job);
    selection.index = index;

    // Added at head: the base side never had it. The live checkout HAS the file,
    // so a live-tree fallback would leak it — the labeled error proves it does not.
    expectToolError(await captureAsyncError(() => getBaseFile(selection, "added.ts")), "FILE_NOT_IN_BASE");

    // Deleted at head: the base blob IS the reviewed input and is SHA-pinned.
    const deletedBase = await getBaseFile(selection, "deleted.ts");
    expect(deletedBase.content).toBe("export const deleted = 'base-only';\n");
    expect(deletedBase.citation).toMatchObject({ file: "deleted.ts", jobId: job.id, headSha });

    // Renamed: the head-side name never existed at base; the previous name is
    // gone from the head snapshot. Both are reported, neither is filled in.
    expectToolError(await captureAsyncError(() => getBaseFile(selection, "new-name.ts")), "FILE_NOT_IN_BASE");
    expectToolError(captureError(() => readRepositoryFile(selection, "old-name.ts")), "FILE_NOT_INDEXED");
    expect(readRepositoryFile(selection, "new-name.ts", 1, 1).content).toBe("export const moved = 'base-only';");

    // A traversal path never reaches git even though the head-manifest gate is
    // bypassed for base reads.
    expectToolError(await captureAsyncError(() => getBaseFile(selection, "../../outside.ts")), "FILE_NOT_INDEXED");
  });

  it("B2: the pinned snapshot survives an API restart and still serves the reviewed bytes", async () => {
    const directory = tempRepo("consistency-h25-restart-");
    await initRepo(directory);
    writeFileSync(join(directory, "reviewed.ts"), "export const reviewed = 'at-review';\n", "utf8");
    writeFileSync(join(directory, "foundation.ts"), "export const foundation = 'at-review';\n", "utf8");
    await git(directory, ["add", "."]);
    await git(directory, ["commit", "-q", "-m", "reviewed state"]);
    const headSha = await git(directory, ["rev-parse", "HEAD"]);

    const databasePath = join(directory, "notebook.db");
    const first = openDatabase(databasePath);
    runMigrations(first);
    try {
      const firstJobs = new SQLiteJobStore(first);
      firstJobs.recordWebhookDelivery({ deliveryId: "h25-restart", event: "pull_request", status: "enqueued" });
      const job = firstJobs.enqueue({
        kind: "pull_request", deliveryId: "h25-restart", repository: "local/restart", accessMode: "local_git",
        baseSha: headSha, headSha, repoPath: directory, publicationPolicy: "disabled"
      });
      const firstNotebooks = new SQLiteNotebookStore(first);
      const ensured = firstNotebooks.ensureForJob(job);
      const index = await new RepositorySnapshotIndexer({ store: firstNotebooks }).ensure(job, ensured.source);
      expect(index.status).toBe("ready");
      expect(index.manifest.find(item => item.path === "reviewed.ts")?.content).toContain("at-review");

      // Drift + restart: nothing in memory survives, only durable rows can answer.
      writeFileSync(join(directory, "reviewed.ts"), "export const reviewed = 'after-restart-drift';\n", "utf8");
      rmSync(join(directory, "foundation.ts"));
      const second = openDatabase(databasePath);
      runMigrations(second);
      try {
        const secondJobs = new SQLiteJobStore(second);
        const secondNotebooks = new SQLiteNotebookStore(second);
        const notebookId = secondNotebooks.findByJobId(job.id)!.id;
        const selection = selectNotebookSources(notebookId, secondNotebooks, secondJobs, [job.id])[0]!;
        selection.index = secondNotebooks.getSnapshotIndex("local/restart", snapshotIndexHeadSha(job, ensured.source));
        expect(selection.index?.status).toBe("ready");

        const read = readRepositoryFile(selection, "reviewed.ts", 1, 1);
        expect(read.content).toBe("export const reviewed = 'at-review';");
        expect(read.content).not.toContain("after-restart-drift");
        expect(read.citation).toMatchObject({ jobId: job.id, headSha, file: "reviewed.ts" });
        // A source file deleted after the restart resolves its reviewed bytes,
        // never an unlabeled failure or the drifted tree.
        expect(readRepositoryFile(selection, "foundation.ts", 1, 1).content).toBe("export const foundation = 'at-review';");
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  });

  it("B3: binary files never become Notebook text, never enter a prompt, and never break a run", async () => {
    const directory = tempRepo("consistency-h25-binary-");
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d]),
      Buffer.from("IHDR", "ascii"),
      Buffer.from("png-binary-payload\u0000tail", "utf8")
    ]);
    // Control-byte payload with no NUL: still a binary artifact of the run.
    const controlOnly = Buffer.from(Array.from({ length: 1_024 }, (_value, position) => 1 + (position % 7)));
    writeFileSync(join(directory, "logo.png"), png);
    writeFileSync(join(directory, "blob.dat"), controlOnly);
    writeFileSync(join(directory, "readme.md"), "# Notebook binary boundary\n\nThe readme is text.\n", "utf8");

    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request", deliveryId: "h25-binary", repository: "local/binary", accessMode: "local_git",
      baseSha: "c".repeat(40), headSha: WORKING_TREE_REV, repoPath: directory, publicationPolicy: "disabled"
    });
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(jobs.get(job.id)!);
    const indexer = new RepositorySnapshotIndexer({ store: notebooks });
    const index = await indexer.ensure(jobs.get(job.id)!, ensured.source);
    expect(index.manifest.map(item => item.path)).toEqual(["readme.md"]);

    const selection = selectionFor(notebooks, jobs, job);
    selection.index = index;
    expectToolError(captureError(() => readRepositoryFile(selection, "logo.png")), "FILE_NOT_INDEXED");
    expectToolError(captureError(() => readRepositoryFile(selection, "blob.dat")), "FILE_NOT_INDEXED");
    expect(searchRepository(selection, "png binary payload blob").some(match => match.file !== "readme.md")).toBe(false);

    const graph = new NotebookGraph({ provider: new MockLLMProvider(), jobs, notebookStore: notebooks, indexer });
    const events = [] as Array<{ event: string; data: unknown }>;
    for await (const event of graph.streamMessage({
      notebookId: ensured.notebook.id,
      content: "What does logo.png and blob.dat contain?",
      sourceJobIds: [job.id]
    })) {
      events.push(event);
    }
    expect(events.some(event => event.event === "run.failed")).toBe(false);
    const assistant = notebooks.get(ensured.notebook.id)?.messages.find(message => message.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.content).not.toContain("IHDR");
    expect(assistant!.content).not.toContain("\u0000");
  });

  it("B4: the same path in two pinned SHAs keeps its own bytes and its own SHA-bound citation", async () => {
    const directory = tempRepo("consistency-h25-two-sha-");
    await initRepo(directory);
    writeFileSync(join(directory, "shared.ts"), "export const shared = 'root';\n", "utf8");
    await git(directory, ["add", "."]);
    await git(directory, ["commit", "-q", "-m", "root"]);
    const rootSha = await git(directory, ["rev-parse", "HEAD"]);
    writeFileSync(join(directory, "shared.ts"), "export const shared = 'alpha';\n", "utf8");
    await git(directory, ["add", "."]);
    await git(directory, ["commit", "-q", "-m", "alpha"]);
    const alphaSha = await git(directory, ["rev-parse", "HEAD"]);
    writeFileSync(join(directory, "shared.ts"), "export const shared = 'beta';\n", "utf8");
    await git(directory, ["add", "."]);
    await git(directory, ["commit", "-q", "-m", "beta"]);
    const betaSha = await git(directory, ["rev-parse", "HEAD"]);

    const jobs = new InMemoryJobQueue();
    const alpha = jobs.enqueue({
      kind: "pull_request", deliveryId: "h25-alpha", repository: "local/two-sha", accessMode: "local_git",
      baseSha: rootSha, headSha: alphaSha, repoPath: directory, publicationPolicy: "disabled"
    });
    const notebooks = new InMemoryNotebookStore();
    const indexer = new RepositorySnapshotIndexer({ store: notebooks });

    // Each review is indexed while the checkout is at its own head SHA.
    await git(directory, ["checkout", "-q", alphaSha]);
    const alphaSource = notebooks.ensureForJob(jobs.get(alpha.id)!).source;
    const alphaIndex = await indexer.ensure(jobs.get(alpha.id)!, alphaSource);
    await git(directory, ["checkout", "-q", betaSha]);
    const beta = jobs.enqueue({
      kind: "pull_request", deliveryId: "h25-beta", repository: "local/two-sha", accessMode: "local_git",
      baseSha: alphaSha, headSha: betaSha, repoPath: directory, publicationPolicy: "disabled"
    });
    const betaSource = notebooks.ensureForJob(jobs.get(beta.id)!).source;
    const betaIndex = await indexer.ensure(jobs.get(beta.id)!, betaSource);

    expect(notebooks.getSnapshotIndex("local/two-sha", snapshotIndexHeadSha(jobs.get(alpha.id)!, alphaSource))?.manifest.find(item => item.path === "shared.ts")?.content)
      .toContain("alpha");
    expect(notebooks.getSnapshotIndex("local/two-sha", snapshotIndexHeadSha(jobs.get(beta.id)!, betaSource))?.manifest.find(item => item.path === "shared.ts")?.content)
      .toContain("beta");

    const notebookId = notebooks.findByJobId(alpha.id)!.id;
    const alphaSelection = selectNotebookSources(notebookId, notebooks, jobs, [alpha.id])[0]!;
    alphaSelection.index = alphaIndex;
    const betaSelection = selectNotebookSources(notebookId, notebooks, jobs, [beta.id])[0]!;
    betaSelection.index = betaIndex;

    // Interleave the reads: neither snapshot may serve the other's bytes.
    const betaRead = readRepositoryFile(betaSelection, "shared.ts", 1, 1);
    expect(betaRead.content).toBe("export const shared = 'beta';");
    expect(betaRead.citation).toMatchObject({ jobId: beta.id, headSha: betaSha, file: "shared.ts" });
    const alphaRead = readRepositoryFile(alphaSelection, "shared.ts", 1, 1);
    expect(alphaRead.content).toBe("export const shared = 'alpha';");
    expect(alphaRead.citation).toMatchObject({ jobId: alpha.id, headSha: alphaSha, file: "shared.ts" });
    expect(readRepositoryFile(betaSelection, "shared.ts", 1, 1).content).toBe("export const shared = 'beta';");
  });

  it("B4: two local reviews of the same Git SHA never reuse a drifted checkout index", async () => {
    const directory = tempRepo("consistency-h25-same-sha-");
    await initRepo(directory);
    writeFileSync(join(directory, "shared.ts"), "export const shared = 'first-capture';\n", "utf8");
    await git(directory, ["add", "."]);
    await git(directory, ["commit", "-q", "-m", "capture"]);
    const headSha = await git(directory, ["rev-parse", "HEAD"]);

    const jobs = new InMemoryJobQueue();
    const notebooks = new InMemoryNotebookStore();
    const indexer = new RepositorySnapshotIndexer({ store: notebooks });
    const first = jobs.enqueue({
      kind: "pull_request", deliveryId: "h25-same-sha-first", repository: "local/same-sha", accessMode: "local_git",
      baseSha: headSha, headSha, repoPath: directory, publicationPolicy: "disabled"
    });
    const firstJob = jobs.get(first.id)!;
    const firstSource = notebooks.ensureForJob(firstJob).source;
    const firstIndex = await indexer.ensure(firstJob, firstSource);

    writeFileSync(join(directory, "shared.ts"), "export const shared = 'second-capture';\n", "utf8");
    const second = jobs.enqueue({
      kind: "pull_request", deliveryId: "h25-same-sha-second", repository: "local/same-sha", accessMode: "local_git",
      baseSha: headSha, headSha, repoPath: directory, publicationPolicy: "disabled"
    });
    const secondJob = jobs.get(second.id)!;
    const secondSource = notebooks.ensureForJob(secondJob).source;
    const secondIndex = await indexer.ensure(secondJob, secondSource);

    expect(firstIndex.id).not.toBe(secondIndex.id);
    expect(secondIndex.manifest.find(item => item.path === "shared.ts")?.content).toContain("second-capture");
    const notebookId = notebooks.findByJobId(first.id)!.id;
    const firstSelection = selectNotebookSources(notebookId, notebooks, jobs, [first.id])[0]!;
    expect(firstSelection.index?.id).toBe(firstIndex.id);
    expect(readRepositoryFile(firstSelection, "shared.ts", 1, 1).content).toBe("export const shared = 'first-capture';");
    expect(readRepositoryFile(firstSelection, "shared.ts", 1, 1).citation).toMatchObject({ jobId: first.id, headSha });
    const secondSelection = selectNotebookSources(notebookId, notebooks, jobs, [second.id])[0]!;
    expect(secondSelection.index?.id).toBe(secondIndex.id);
    expect(readRepositoryFile(secondSelection, "shared.ts", 1, 1).content).toBe("export const shared = 'second-capture';");
  });

  it("B4: same-SHA local indexes remain isolated after closing and reopening SQLite", async () => {
    const directory = tempRepo("consistency-h25-same-sha-durable-");
    const databasePath = join(tempRepo("consistency-h25-index-db-"), "notebook.db");
    await initRepo(directory);
    writeFileSync(join(directory, "shared.ts"), "export const shared = 'committed';\n", "utf8");
    await git(directory, ["add", "."]);
    await git(directory, ["commit", "-q", "-m", "baseline"]);
    const headSha = await git(directory, ["rev-parse", "HEAD"]);
    const captures: Array<{ jobId: string; indexId: string; marker: string }> = [];

    const first = openDatabase(databasePath);
    try {
      runMigrations(first);
      const jobs = new SQLiteJobStore(first);
      const notebooks = new SQLiteNotebookStore(first);
      const indexer = new RepositorySnapshotIndexer({ store: notebooks });
      for (const marker of ["first-capture", "second-capture"]) {
        writeFileSync(join(directory, "shared.ts"), `export const shared = '${marker}';\n`, "utf8");
        jobs.recordWebhookDelivery({ deliveryId: marker, event: "pull_request", status: "enqueued" });
        const job = jobs.enqueue({
          kind: "pull_request", deliveryId: marker, repository: "local/same-sha-durable", accessMode: "local_git",
          baseSha: headSha, headSha, repoPath: directory, publicationPolicy: "disabled"
        });
        const { source } = notebooks.ensureForJob(job);
        const index = await indexer.ensure(job, source);
        expect(index.status).toBe("ready");
        captures.push({ jobId: job.id, indexId: index.id, marker });
      }
      expect(captures[0]!.indexId).not.toBe(captures[1]!.indexId);
      expect(await git(directory, ["rev-parse", "HEAD"])).toBe(headSha);
    } finally { first.close(); }

    // No original connection or in-memory store survives; live bytes disappear.
    rmSync(join(directory, "shared.ts"));
    const reopened = openDatabase(databasePath);
    try {
      runMigrations(reopened);
      const jobs = new SQLiteJobStore(reopened);
      const notebooks = new SQLiteNotebookStore(reopened);
      const indexer = new RepositorySnapshotIndexer({ store: notebooks });
      const notebookId = notebooks.findByJobId(captures[0]!.jobId)!.id;
      expect(notebooks.findByJobId(captures[1]!.jobId)!.id).toBe(notebookId);
      for (const capture of captures) {
        const job = jobs.get(capture.jobId)!;
        const source = notebooks.getSourceForJob(notebookId, capture.jobId)!;
        const cached = await indexer.ensure(job, source);
        expect(cached.id).toBe(capture.indexId);
        const selection = selectNotebookSources(notebookId, notebooks, jobs, [capture.jobId])[0]!;
        // Selection must retrieve the durable job-specific index itself.
        expect(selection.index?.id).toBe(capture.indexId);
        const read = readRepositoryFile(selection, "shared.ts", 1, 1);
        expect(read.content).toBe(`export const shared = '${capture.marker}';`);
        expect(read.citation).toMatchObject({ jobId: capture.jobId, headSha, file: "shared.ts", startLine: 1, endLine: 1 });
        expect(read.citation.headSha).not.toContain(":job:");
        const other = captures.find(item => item.jobId !== capture.jobId)!;
        // Search intentionally falls back to context excerpts on no match;
        // those excerpts must still come from this job, not the other capture.
        const matches = searchRepository(selection, other.marker);
        expect(matches.length).toBeGreaterThan(0);
        for (const match of matches) {
          expect(match.content).toContain(capture.marker);
          expect(match.content).not.toContain(other.marker);
          expect(match.citation).toMatchObject({ jobId: capture.jobId, headSha });
        }
      }
    } finally { reopened.close(); }
  });

  it("B4: two working-tree reviews of one repository never swap review-time bytes", async () => {
    const directory = tempRepo("consistency-h25-two-tree-");
    const sharedPath = join(directory, "shared.ts");
    writeFileSync(sharedPath, "export const shared = 'first-review';\n", "utf8");

    const jobs = new InMemoryJobQueue();
    const first = jobs.enqueue({
      kind: "pull_request", deliveryId: "h25-tree-first", repository: "local/two-tree", accessMode: "local_git",
      baseSha: "d".repeat(40), headSha: WORKING_TREE_REV, repoPath: directory, publicationPolicy: "disabled"
    });
    jobs.saveReviewSnapshot({
      jobId: first.id, baseSha: first.baseSha!, headSha: WORKING_TREE_REV,
      files: [{ path: "shared.ts", status: "modified", additions: 1, deletions: 1, binary: false, hunks: [] }],
      fileContents: { "shared.ts": "export const shared = 'first-review';\n" },
      baseFileContents: { "shared.ts": "export const shared = 'baseline';\n" },
      capturedAt: new Date().toISOString()
    });
    const notebooks = new InMemoryNotebookStore();
    const indexer = new RepositorySnapshotIndexer({ store: notebooks });
    const firstIndex = await indexer.ensure(jobs.get(first.id)!, notebooks.ensureForJob(jobs.get(first.id)!).source);

    writeFileSync(sharedPath, "export const shared = 'second-review';\n", "utf8");
    const second = jobs.enqueue({
      kind: "pull_request", deliveryId: "h25-tree-second", repository: "local/two-tree", accessMode: "local_git",
      baseSha: "d".repeat(40), headSha: WORKING_TREE_REV, repoPath: directory, publicationPolicy: "disabled"
    });
    jobs.saveReviewSnapshot({
      jobId: second.id, baseSha: second.baseSha!, headSha: WORKING_TREE_REV,
      files: [{ path: "shared.ts", status: "modified", additions: 1, deletions: 1, binary: false, hunks: [] }],
      fileContents: { "shared.ts": "export const shared = 'second-review';\n" },
      baseFileContents: { "shared.ts": "export const shared = 'baseline';\n" },
      capturedAt: new Date().toISOString()
    });
    const secondIndex = await indexer.ensure(jobs.get(second.id)!, notebooks.ensureForJob(jobs.get(second.id)!).source);

    const notebookId = notebooks.findByJobId(first.id)!.id;
    expect(notebooks.findByJobId(second.id)!.id).toBe(notebookId);
    const firstSelection = selectNotebookSources(notebookId, notebooks, jobs, [first.id])[0]!;
    firstSelection.index = firstIndex;
    const secondSelection = selectNotebookSources(notebookId, notebooks, jobs, [second.id])[0]!;
    secondSelection.index = secondIndex;

    const firstRead = readRepositoryFile(firstSelection, "shared.ts", 1, 1);
    expect(firstRead.content).toBe("export const shared = 'first-review';");
    expect(firstRead.citation).toMatchObject({ jobId: first.id, headSha: WORKING_TREE_REV });
    const secondRead = readRepositoryFile(secondSelection, "shared.ts", 1, 1);
    expect(secondRead.content).toBe("export const shared = 'second-review';");
    expect(secondRead.citation.jobId).toBe(second.id);
    // Each base read stays with its own review too.
    expect((await getBaseFile(firstSelection, "shared.ts")).content).toBe("export const shared = 'baseline';\n");
    expect(readRepositoryFile(firstSelection, "shared.ts", 1, 1).content).toBe("export const shared = 'first-review';");
  });

  it("B5: redaction removes the secret yet the citation anchor and its fingerprint stay stable", async () => {
    const directory = tempRepo("consistency-h25-redact-");
    const secret = `ghp_${"G".repeat(36)}`;
    const body = [
      "export const publicValue = 1;",
      `const token = "${secret}";`,
      "export const anchor = 'after-secret';",
      "export const tail = 'end';",
      ""
    ].join("\n");
    writeFileSync(join(directory, "config.ts"), body, "utf8");
    writeFileSync(join(directory, ".env"), `API_KEY=${secret}\n`, "utf8");

    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request", deliveryId: "h25-redact", repository: "local/redact", accessMode: "local_git",
      baseSha: "e".repeat(40), headSha: WORKING_TREE_REV, repoPath: directory, publicationPolicy: "disabled"
    });
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(jobs.get(job.id)!);
    const index = await new RepositorySnapshotIndexer({ store: notebooks }).ensure(jobs.get(job.id)!, ensured.source);
    expect(index.manifest.some(item => item.path === ".env")).toBe(false);

    const selection = selectionFor(notebooks, jobs, job);
    selection.index = index;
    const first = readRepositoryFile(selection, "config.ts", 2, 2);
    expect(first.content).not.toContain(secret);
    expect(first.content).toContain("[REDACTED]");
    expect(first.citation).toMatchObject({ jobId: job.id, headSha: WORKING_TREE_REV, file: "config.ts", startLine: 2, endLine: 2 });
    // Redaction is inline for value secrets: the line anchor still points at the
    // same reference in the reviewed projection.
    expect(readRepositoryFile(selection, "config.ts", 3, 3).content).toBe("export const anchor = 'after-secret';");

    const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
    const cited = fingerprint(`${first.citation.file}:${first.citation.startLine}-${first.citation.endLine}:${first.citation.headSha}:${first.content}`);
    const reread = readRepositoryFile(selection, "config.ts", 2, 2);
    expect(reread.content).toBe(first.content);
    expect(fingerprint(`${reread.citation.file}:${reread.citation.startLine}-${reread.citation.endLine}:${reread.citation.headSha}:${reread.content}`)).toBe(cited);
    // A re-index of the same reviewed bytes reproduces the same cited excerpt.
    const reindexed = await new RepositorySnapshotIndexer({ store: new InMemoryNotebookStore() }).ensure(jobs.get(job.id)!, ensured.source);
    const reindexSelection = selectionFor(notebooks, jobs, job);
    reindexSelection.index = reindexed;
    expect(readRepositoryFile(reindexSelection, "config.ts", 2, 2).content).toBe(first.content);

    // Secret-path files stay unreadable: no anchor is invented for them.
    expectToolError(captureError(() => readRepositoryFile(selection, ".env")), "FILE_NOT_INDEXED");
  });

  it("B5: secret material in the reviewed tree never reaches the Notebook prompt or the answer", async () => {
    const directory = tempRepo("consistency-h25-redact-prompt-");
    const secret = `ghp_${"H".repeat(36)}`;
    writeFileSync(join(directory, "leak.ts"), `export const credential = "${secret}";\n`, "utf8");
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src", "keep.ts"), "export const keep = 'text';\n", "utf8");

    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request", deliveryId: "h25-redact-prompt", repository: "local/redact-prompt", accessMode: "local_git",
      baseSha: "f".repeat(40), headSha: WORKING_TREE_REV, repoPath: directory, publicationPolicy: "disabled"
    });
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(jobs.get(job.id)!);
    const prompts: string[] = [];
    const provider = {
      name: "openai" as const,
      model: "test",
      invokeWithSchema: async () => ({ data: {} }),
      generateStructuredFinding: async () => ({ data: [] }),
      generateAgentRun: async () => ({ data: { findings: [] } }),
      generateSummary: async () => ({ data: { summary: "ok" } }),
      async *stream(request: { userPrompt: string }) {
        prompts.push(request.userPrompt);
        yield { kind: "text_delta" as const, text: "已按引用复核。" };
        yield { kind: "completed" as const };
      }
    };
    const graph = new NotebookGraph({
      provider: provider as never,
      jobs,
      notebookStore: notebooks,
      indexer: new RepositorySnapshotIndexer({ store: notebooks })
    });
    for await (const _event of graph.streamMessage({
      notebookId: ensured.notebook.id,
      content: "Where is the credential?",
      sourceJobIds: [job.id]
    })) {
      // drain
    }
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(secret);
    const assistant = notebooks.get(ensured.notebook.id)?.messages.find(message => message.role === "assistant");
    expect(assistant!.content).not.toContain(secret);
    for (const citation of assistant!.citations) {
      expect(citation.excerpt).not.toContain(secret);
      expect(citation.file).toBe("leak.ts");
      expect(citation.jobId).toBe(job.id);
    }
  });
});
