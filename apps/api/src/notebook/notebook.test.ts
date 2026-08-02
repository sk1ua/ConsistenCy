import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "../jobQueue";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { SQLiteJobStore } from "../jobs/sqliteJobStore";
import { MockLLMProvider } from "../review/llm/mockProvider";
import { InMemoryNotebookStore, SQLiteNotebookStore } from "./store";
import { RepositorySnapshotIndexer } from "./indexer";
import { NotebookGraph } from "./graph";
import { readRepositoryFile, selectNotebookSources } from "./tools";

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
    expect(notebooks.getSnapshotIndex("example/repo", "head-sha")?.status).toBe("ready");

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
});
