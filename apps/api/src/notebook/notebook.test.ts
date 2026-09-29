import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKING_TREE_REV } from "@consistency/schema";
import { execGit } from "@consistency/vcs-core";
import { InMemoryJobQueue } from "../jobQueue";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { SQLiteJobStore } from "../jobs/sqliteJobStore";
import { MockLLMProvider } from "../review/llm/mockProvider";
import { InMemoryNotebookStore, SQLiteNotebookStore, snapshotIndexHeadSha } from "./store";
import { RepositorySnapshotIndexer } from "./indexer";
import { NotebookGraph } from "./graph";
import { readRepositoryFile, selectNotebookSources, getDiff, getBaseFile } from "./tools";

describe("Repository Review Notebook", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("indexes a head snapshot, streams an answer, and persists citations bound to the selected SHA", async () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-notebook-"));
    directories.push(directory);
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "router.ts"), "export function reviewRouter() {\n  return 'evidence';\n}\n", "utf8");

    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request",
      deliveryId: "notebook-delivery-1",
      repository: "example/repo",
      pullRequestNumber: 7,
      installationId: 1,
      baseSha: "base-sha",
      headSha: "head-sha",
      repoPath: directory,
      publicationPolicy: "disabled"
    });
    jobs.markRunning(job.id);
    jobs.persistReportAndEnqueuePublish(job.id, {
      jobId: job.id,
      repositoryFullName: job.repository,
      pullRequestNumber: 7,
      baseSha: job.baseSha!,
      headSha: job.headSha!,
      summary: "A report with source evidence",
      score: 72,
      riskLevel: "medium",
      agentRuns: [],
      findings: [{
        id: "finding_1",
        agent: "Correctness",
        title: "Router evidence",
        severity: "medium",
        confidence: "confirmed",
        file: "src/router.ts",
        startLine: 1,
        endLine: 2,
        evidence: "The router returns a fixed value.",
        reasoning: "The changed path is directly observable.",
        recommendation: "Review the return path."
      }],
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(jobs.get(job.id)!);
    const indexer = new RepositorySnapshotIndexer({ store: notebooks });
    const graph = new NotebookGraph({ provider: new MockLLMProvider(), jobs, notebookStore: notebooks, indexer });

    const events = [] as Array<{ event: string; data: unknown }>;
    for await (const event of graph.streamMessage({ notebookId: ensured.notebook.id, content: "Why does the router change?", sourceJobIds: [job.id] })) events.push(event);

    expect(events.some(event => event.event === "text.delta")).toBe(true);
    expect(events.some(event => event.event === "citation")).toBe(true);
    expect(events.some(event => event.event === "run.completed")).toBe(true);
    const stored = notebooks.get(ensured.notebook.id)!;
    const assistant = stored.messages.find(message => message.role === "assistant");
    expect(assistant?.status).toBe("completed");
    expect(assistant?.citations[0]).toMatchObject({ repository: "example/repo", pullRequestNumber: 7, jobId: job.id, headSha: "head-sha" });
    expect(notebooks.getSnapshotIndex("example/repo", snapshotIndexHeadSha(jobs.get(job.id)!, ensured.source))?.status).toBe("ready");

    const cardEvents = [] as Array<{ event: string; data: any }>;
    for await (const event of graph.streamCard({ notebookId: ensured.notebook.id, kind: "fix_plan", sourceJobIds: [job.id] })) cardEvents.push(event);
    expect(cardEvents.some(event => event.event === "tool.started" && event.data.tool === "generate_patch")).toBe(true);
    expect(cardEvents.find(event => event.event === "tool.result" && event.data.tool === "generate_patch")?.data.writesWorkspace).toBe(false);
    expect(cardEvents.some(event => event.event === "card.completed")).toBe(true);
  });

  it("rejects workspace traversal and keeps source selection SHA-bound", async () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-notebook-safe-"));
    directories.push(directory);
    writeFileSync(join(directory, "safe.ts"), "export const safe = true;\n", "utf8");
    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({ kind: "pull_request", deliveryId: "safe-delivery", repository: "example/repo", pullRequestNumber: 1, baseSha: "base", headSha: "head", repoPath: directory, publicationPolicy: "disabled" });
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(job);
    const indexer = new RepositorySnapshotIndexer({ store: notebooks });
    const index = await indexer.ensure(job, ensured.source);
    expect(index.manifest.find(entry => entry.path === "safe.ts")).toMatchObject({ symbols: ["safe"], imports: [], preview: "export const safe = true;\n" });
    const selection = selectNotebookSources(ensured.notebook.id, notebooks, jobs, [job.id])[0]!;
    selection.index = index;
    expect(() => readRepositoryFile(selection, "../outside.ts")).toThrow();
  });

  it("indexes a public-read snapshot without an installation id", async () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-notebook-public-"));
    directories.push(directory);
    writeFileSync(join(directory, "README.md"), "# Public repository evidence\n", "utf8");

    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request",
      deliveryId: "public-read-index",
      repository: "espnet/espnet",
      pullRequestNumber: 6327,
      baseSha: "base-sha",
      headSha: "head-sha",
      accessMode: "public_read",
      publicationPolicy: "disabled"
    });
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(job);
    let seenToken: string | undefined;
    const indexer = new RepositorySnapshotIndexer({
      store: notebooks,
      publicReadToken: "public-read-token",
      cloneWorkspace: async options => {
        seenToken = options.token;
        return directory;
      }
    });

    const index = await indexer.ensure(job, ensured.source);

    expect(index.status).toBe("ready");
    expect(index.manifest).toContainEqual(expect.objectContaining({ path: "README.md" }));
    expect(seenToken).toBe("public-read-token");
  });

  it("streams a notebook answer for local_git WORKING_TREE sources without pullRequestNumber", async () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-notebook-local-"));
    directories.push(directory);
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "local.ts"), "export function localReview() {\n  return 'working-tree';\n}\n", "utf8");

    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request",
      deliveryId: "local-notebook-1",
      repository: "local/ConsistenCy",
      accessMode: "local_git",
      baseSha: "a".repeat(40),
      headSha: WORKING_TREE_REV,
      repoPath: directory,
      publicationPolicy: "disabled"
    });
    expect(job.pullRequestNumber).toBeUndefined();
    jobs.markRunning(job.id);
    jobs.persistReportAndEnqueuePublish(job.id, {
      jobId: job.id,
      repositoryFullName: job.repository,
      baseSha: job.baseSha!,
      headSha: job.headSha!,
      summary: "Local working-tree review",
      score: 80,
      riskLevel: "low",
      agentRuns: [],
      findings: [{
        id: "finding_local_1",
        agent: "Correctness",
        title: "Local evidence",
        severity: "low",
        confidence: "confirmed",
        file: "src/local.ts",
        startLine: 1,
        endLine: 2,
        evidence: "The local helper returns a fixed value.",
        reasoning: "Observable in the working tree.",
        recommendation: "Keep reviewing locally."
      }],
      createdAt: "2026-09-18T00:00:00.000Z"
    });

    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(jobs.get(job.id)!);
    expect(ensured.source.pullRequestNumber).toBeUndefined();
    const indexer = new RepositorySnapshotIndexer({ store: notebooks });
    const graph = new NotebookGraph({ provider: new MockLLMProvider(), jobs, notebookStore: notebooks, indexer });

    const events = [] as Array<{ event: string; data: unknown }>;
    for await (const event of graph.streamMessage({
      notebookId: ensured.notebook.id,
      content: "What does the local helper return?",
      sourceJobIds: [job.id]
    })) {
      events.push(event);
    }

    expect(events.some(event => event.event === "tool.started" && (event.data as { tool?: string }).tool === "search_repository")).toBe(true);
    expect(events.some(event => event.event === "run.failed")).toBe(false);
    expect(events.some(event => event.event === "text.delta" || event.event === "run.completed" || event.event === "run.degraded")).toBe(true);
    const assistant = notebooks.get(ensured.notebook.id)?.messages.find(message => message.role === "assistant");
    expect(assistant?.status === "completed" || assistant?.status === "degraded").toBe(true);
    for (const citation of assistant?.citations ?? []) {
      expect(citation.pullRequestNumber).toBeUndefined();
      expect(citation.jobId).toBe(job.id);
      expect(citation.headSha).toBe(WORKING_TREE_REV);
    }
  });

  it("resolves working-tree reviews against the persisted review snapshot after drift (P1-06③)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-notebook-snapshot-"));
    directories.push(directory);
    const git = async (args: string[]) => (await execGit(args, { cwd: directory })).stdout.trim();
    await git(["init", "-q"]);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(["config", "user.name", "Test"]);
    await git(["config", "user.email", "test@example.com"]);
    writeFileSync(join(directory, "tracked.ts"), "export const version = 1;\n", "utf8");
    // >2048 bytes with a marker BEYOND the preview cap: proves the working-tree
    // index pins full content, not just the 2KB preview slice.
    const stableReviewTime = `export const stable = 1; // review-time\n${"// padding line for the pinned-content boundary\n".repeat(90)}export const TAIL_MARKER_BEYOND_2048 = true; // review-time\n`;
    writeFileSync(join(directory, "stable.ts"), stableReviewTime, "utf8");
    expect(Buffer.byteLength(stableReviewTime, "utf8")).toBeGreaterThan(2_048);
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "base"]);

    // Review-time state: tracked.ts edited in place (content captured by the
    // review snapshot), plus an untracked file only the snapshot remembers.
    writeFileSync(join(directory, "tracked.ts"), "export const version = 2; // review-time\n", "utf8");
    writeFileSync(join(directory, "fresh-notebook.ts"), "export const fresh = true; // review-time\n", "utf8");

    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request",
      repository: "local/snapshot",
      accessMode: "local_git",
      baseSha: (await git(["rev-parse", "HEAD"])).trim(),
      headSha: WORKING_TREE_REV,
      repoPath: directory,
      publicationPolicy: "disabled"
    });
    jobs.saveReviewSnapshot({
      jobId: job.id,
      baseSha: job.baseSha!,
      headSha: WORKING_TREE_REV,
      files: [
        {
          path: "tracked.ts", status: "modified", additions: 1, deletions: 1, binary: false,
          hunks: [{ header: "@@ -1 +1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: "-export const version = 1;\n+export const version = 2; // review-time" }]
        },
        {
          path: "fresh-notebook.ts", status: "untracked", additions: 1, deletions: 0, binary: false,
          hunks: [{ header: "@@ -0,0 +1 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, content: "+export const fresh = true; // review-time" }]
        }
      ],
      fileContents: {
        "tracked.ts": "export const version = 2; // review-time\n",
        "fresh-notebook.ts": "export const fresh = true; // review-time\n"
      },
      baseFileContents: {
        "tracked.ts": "export const version = 1; // pinned-base\n"
      },
      capturedAt: new Date().toISOString()
    });

    // Index the review-time working tree, then drift the checkout past it.
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(jobs.get(job.id)!);
    const indexer = new RepositorySnapshotIndexer({ store: notebooks });
    const index = await indexer.ensure(jobs.get(job.id)!, ensured.source);
    writeFileSync(join(directory, "tracked.ts"), "export const version = 3; // post-review\n", "utf8");
    writeFileSync(join(directory, "stable.ts"), stableReviewTime.replaceAll("review-time", "post-review"), "utf8");

    const selection = selectNotebookSources(ensured.notebook.id, notebooks, jobs, [job.id])[0]!;
    selection.index = index;

    // File reads resolve the REVIEW-TIME content, not the drifted disk.
    const read = readRepositoryFile(selection, "tracked.ts", 1, 1);
    expect(read.content).toBe("export const version = 2; // review-time");

    // getDiff for a working-tree review now answers from the snapshot
    // (it used to throw INVALID_SHA because headSha is symbolic).
    const diff = await getDiff(selection);
    expect(diff.content).toContain("+export const version = 2; // review-time");
    expect(diff.content).toContain("+export const fresh = true; // review-time");
    expect(diff.content).not.toContain("post-review");

    const base = await getBaseFile(selection, "tracked.ts");
    expect(base.content).toBe("export const version = 1; // pinned-base\n");
    expect(base.content).not.toContain("post-review");

    // Unchanged files are not in review fileContents; the index-time pin is
    // the content. Live disk after capture must not win — including bytes
    // beyond the 2KB preview (audit P1-06③ full-content pin).
    const unchanged = readRepositoryFile(selection, "stable.ts", 1, 200);
    expect(unchanged.content).toContain("export const stable = 1; // review-time");
    expect(unchanged.content).toContain("TAIL_MARKER_BEYOND_2048 = true; // review-time");
    expect(unchanged.content).not.toContain("post-review");
  });

  it("answers getDiff with merge-base (three-dot) semantics matching the review (P1-06③)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-notebook-range-"));
    directories.push(directory);
    const git = async (args: string[]) => (await execGit(args, { cwd: directory })).stdout.trim();
    await git(["init", "-q"]);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(["config", "user.name", "Test"]);
    await git(["config", "user.email", "test@example.com"]);
    writeFileSync(join(directory, "shared.ts"), "export const shared = 0;\n", "utf8");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "root"]);
    await git(["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(directory, "feature-only.ts"), "export const featureOnly = true; // head-side\n", "utf8");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "feature change"]);
    await git(["checkout", "-q", "main"]);
    writeFileSync(join(directory, "base-only.ts"), "export const baseOnly = true; // base-side\n", "utf8");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "base moves on"]);

    const head = (await git(["rev-parse", "feature"])).trim();
    const base = (await git(["rev-parse", "main"])).trim();

    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request",
      repository: "local/range",
      accessMode: "local_git",
      baseSha: base,
      headSha: head,
      repoPath: directory,
      publicationPolicy: "disabled"
    });
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(jobs.get(job.id)!);
    const indexer = new RepositorySnapshotIndexer({ store: notebooks });
    const index = await indexer.ensure(jobs.get(job.id)!, ensured.source);
    const selection = selectNotebookSources(ensured.notebook.id, notebooks, jobs, [job.id])[0]!;
    selection.index = index;

    const diff = await getDiff(selection);
    // Three-dot: only what feature changed since the merge base. The old
    // two-dot form would also have shown main's base-only.ts addition.
    expect(diff.content).toContain("feature-only.ts");
    expect(diff.content).not.toContain("base-only.ts");
  });

  it("refuses to turn an ungrounded question into a code claim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-notebook-no-evidence-"));
    directories.push(directory);
    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({ kind: "pull_request", deliveryId: "no-evidence-delivery", repository: "example/no-evidence", pullRequestNumber: 2, baseSha: "base", headSha: "head", publicationPolicy: "disabled" });
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(job);
    const graph = new NotebookGraph({ provider: new MockLLMProvider(), jobs, notebookStore: notebooks, indexer: new RepositorySnapshotIndexer({ store: notebooks }) });
    for await (const _event of graph.streamMessage({ notebookId: ensured.notebook.id, content: "Which function is unsafe?", sourceJobIds: [job.id] })) {
      // Consume the stream so the final persisted message is available.
    }
    const assistant = notebooks.get(ensured.notebook.id)?.messages.find(message => message.role === "assistant");
    expect(assistant?.content).toContain("当前上下文无法确认");
    expect(assistant?.citations).toEqual([]);
  });

  it("persists Notebook messages, cards, and SHA indexes through SQLite", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const jobs = new SQLiteJobStore(database);
      jobs.recordWebhookDelivery({ deliveryId: "sqlite-notebook-1", event: "pull_request", status: "enqueued" });
      const job = jobs.enqueue({ kind: "pull_request", deliveryId: "sqlite-notebook-1", repository: "example/sqlite", pullRequestNumber: 2, baseSha: "base", headSha: "head", publicationPolicy: "disabled" });
      const sqliteNotebooks = new SQLiteNotebookStore(database);
      const ensured = sqliteNotebooks.ensureForJob(job);
      const citation = {
        id: "citation_sqlite_1",
        repository: job.repository,
        pullRequestNumber: job.pullRequestNumber!,
        jobId: job.id,
        headSha: job.headSha!,
        file: "README.md",
        startLine: 1,
        endLine: 2,
        excerpt: "# Evidence",
        kind: "file" as const
      };
      const message = sqliteNotebooks.createMessage({ notebookId: ensured.notebook.id, role: "user", content: "Explain the source", status: "completed", sourceJobIds: [job.id], citations: [citation] });
      const card = sqliteNotebooks.createCard({ notebookId: ensured.notebook.id, kind: "risk_brief", title: "Risk Brief", content: "No persisted findings.", sourceJobIds: [job.id], status: "generated", citations: [{ ...citation, id: "citation_sqlite_card" }] });
      sqliteNotebooks.upsertSnapshotIndex({ repository: job.repository, headSha: job.headSha!, status: "ready", manifest: [] });
      const loaded = sqliteNotebooks.get(ensured.notebook.id)!;
      expect(loaded.sources[0]).toMatchObject({ jobId: job.id, headSha: "head" });
      expect(loaded.messages[0]?.content).toBe("Explain the source");
      expect(loaded.messages[0]?.citations).toHaveLength(1);
      expect(loaded.cards[0]?.kind).toBe("risk_brief");
      expect(loaded.cards[0]?.citations).toHaveLength(1);
      expect(database.prepare("SELECT COUNT(*) AS count FROM notebook_citations").get()).toMatchObject({ count: 2 });
      sqliteNotebooks.updateMessage(message.id, { citations: [] });
      expect(sqliteNotebooks.get(ensured.notebook.id)?.messages[0]?.citations).toEqual([]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM notebook_citations WHERE message_id = ?").get(message.id)).toMatchObject({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM notebook_citations WHERE card_id = ?").get(card.id)).toMatchObject({ count: 1 });
      expect(sqliteNotebooks.getSnapshotIndex(job.repository, "head")?.status).toBe("ready");
    } finally {
      database.close();
    }
  });

  it("P1-03: secret-shaped values in repository evidence never reach the Notebook model prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-notebook-redact-"));
    directories.push(directory);
    const token = `ghp_${"F".repeat(36)}`;
    writeFileSync(join(directory, "secret.ts"), `export const token = "${token}";\n`, "utf8");

    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request",
      deliveryId: "notebook-redact",
      repository: "example/redact",
      pullRequestNumber: 3,
      installationId: 1,
      baseSha: "base",
      headSha: "head",
      repoPath: directory,
      publicationPolicy: "disabled"
    });
    jobs.markRunning(job.id);
    jobs.persistReportAndEnqueuePublish(job.id, {
      jobId: job.id,
      repositoryFullName: job.repository,
      pullRequestNumber: 3,
      baseSha: job.baseSha!,
      headSha: job.headSha!,
      summary: "Has a synthetic token in a changed file",
      score: 40,
      riskLevel: "high",
      agentRuns: [],
      findings: [{
        id: "finding_token",
        agent: "Security",
        title: "Synthetic credential",
        severity: "high",
        confidence: "confirmed",
        file: "secret.ts",
        startLine: 1,
        endLine: 1,
        evidence: "A literal synthetic token is assigned.",
        reasoning: "Would be exposed in version control.",
        recommendation: "Move to a secret store."
      }],
      createdAt: "2026-09-20T00:00:00.000Z"
    });

    const captured: { userPrompt?: string } = {};
    const provider = {
      name: "openai" as const,
      model: "test",
      invokeWithSchema: async () => ({ data: {} }),
      generateStructuredFinding: async () => ({ data: [] }),
      generateAgentRun: async () => ({ data: { findings: [] } }),
      generateSummary: async () => ({ data: { summary: "ok" } }),
      async *stream(request: { userPrompt: string }) {
        captured.userPrompt = request.userPrompt;
        yield { kind: "text_delta" as const, text: "已按引用复核。" };
        yield { kind: "completed" as const };
      }
    };
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(jobs.get(job.id)!);
    const graph = new NotebookGraph({
      provider: provider as never,
      jobs,
      notebookStore: notebooks,
      indexer: new RepositorySnapshotIndexer({ store: notebooks })
    });
    for await (const _event of graph.streamMessage({
      notebookId: ensured.notebook.id,
      content: "Where is the token?",
      sourceJobIds: [job.id]
    })) {
      // drain
    }
    expect(captured.userPrompt).toBeDefined();
    expect(captured.userPrompt).not.toContain(token);
  });

  it("P2-05: an aborted signal fails the Notebook run instead of calling the model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-notebook-abort-"));
    directories.push(directory);
    writeFileSync(join(directory, "ok.ts"), "export const ok = true;\n", "utf8");
    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request",
      deliveryId: "notebook-abort",
      repository: "example/abort",
      pullRequestNumber: 4,
      installationId: 1,
      baseSha: "base",
      headSha: "head",
      repoPath: directory,
      publicationPolicy: "disabled"
    });
    const notebooks = new InMemoryNotebookStore();
    const ensured = notebooks.ensureForJob(job);
    let dispatched = 0;
    const provider = new MockLLMProvider();
    const original = provider.stream.bind(provider);
    provider.stream = async function* (request) {
      dispatched += 1;
      yield* original(request);
    };
    const graph = new NotebookGraph({
      provider,
      jobs,
      notebookStore: notebooks,
      indexer: new RepositorySnapshotIndexer({ store: notebooks })
    });
    const abort = new AbortController();
    abort.abort(new Error("notebook client disconnected"));
    const events: string[] = [];
    for await (const event of graph.streamMessage({
      notebookId: ensured.notebook.id,
      content: "What changed?",
      sourceJobIds: [job.id],
      signal: abort.signal
    })) {
      events.push(event.event);
    }
    expect(events).toContain("run.failed");
    expect(dispatched).toBe(0);
    const assistant = notebooks.get(ensured.notebook.id)?.messages.find(message => message.role === "assistant");
    expect(assistant?.status).toBe("failed");
  });
});
