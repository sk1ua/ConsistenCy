import { randomUUID } from "node:crypto";
import {
  notebookCardSchema,
  notebookCitationSchema,
  notebookMessageSchema,
  notebookSchema,
  notebookSourceSchema,
  type Notebook,
  type NotebookCard,
  type NotebookCardKind,
  type NotebookCitation,
  type NotebookMessage,
  type NotebookSource,
  type TokenUsage
} from "@consistency/schema";
import type { ConsistencyDatabase } from "../db/connection";
import type { ReviewJob } from "../jobQueue";

export type SnapshotManifestEntry = {
  path: string;
  bytes: number;
  lines: number;
  language: string;
  symbols?: string[];
  imports?: string[];
  preview?: string;
};

export type SnapshotIndex = {
  id: string;
  repository: string;
  headSha: string;
  status: "queued" | "indexing" | "ready" | "failed";
  workspacePath?: string;
  manifest: SnapshotManifestEntry[];
  indexedAt?: string;
  error?: string;
};

export type CreateNotebookMessageInput = {
  notebookId: string;
  role: NotebookMessage["role"];
  content: string;
  status: NotebookMessage["status"];
  sourceJobIds: string[];
  citations?: NotebookCitation[];
  provider?: NotebookMessage["provider"];
  model?: string;
  tokenUsage?: TokenUsage;
  error?: string;
};

export type CreateNotebookCardInput = {
  notebookId: string;
  kind: NotebookCardKind;
  title: string;
  content: string;
  sourceJobIds: string[];
  citations?: NotebookCitation[];
  status: NotebookCard["status"];
  provider?: NotebookCard["provider"];
  model?: string;
};

export interface NotebookStore {
  ensureForJob(job: ReviewJob): { notebook: Notebook; source: NotebookSource };
  get(id: string): Notebook | undefined;
  findByJobId(jobId: string): Notebook | undefined;
  getSource(id: string): NotebookSource | undefined;
  getSourceForJob(notebookId: string, jobId: string): NotebookSource | undefined;
  createMessage(input: CreateNotebookMessageInput): NotebookMessage;
  updateMessage(id: string, patch: Partial<Omit<CreateNotebookMessageInput, "notebookId" | "role">> & { role?: NotebookMessage["role"] }): NotebookMessage | undefined;
  createCard(input: CreateNotebookCardInput): NotebookCard;
  getSnapshotIndex(repository: string, headSha: string): SnapshotIndex | undefined;
  upsertSnapshotIndex(input: Omit<SnapshotIndex, "id"> & { id?: string }): SnapshotIndex;
  updateSourceStatus(id: string, status: NotebookSource["indexStatus"], indexedAt?: string, error?: string): NotebookSource | undefined;
}

function now(): string {
  return new Date().toISOString();
}

function createSource(job: ReviewJob, notebookId: string): NotebookSource {
  return notebookSourceSchema.parse({
    id: `source_${randomUUID()}`,
    repository: job.repository,
    pullRequestNumber: job.pullRequestNumber,
    jobId: job.id,
    baseSha: job.baseSha,
    headSha: job.headSha,
    indexStatus: "queued"
  });
}

export class InMemoryNotebookStore implements NotebookStore {
  private readonly notebooks = new Map<string, Notebook>();
  private readonly indexes = new Map<string, SnapshotIndex>();

  ensureForJob(job: ReviewJob): { notebook: Notebook; source: NotebookSource } {
    let notebook = [...this.notebooks.values()].find(item => item.repository === job.repository);
    if (!notebook) {
      const timestamp = now();
      notebook = notebookSchema.parse({
        id: `notebook_${randomUUID()}`,
        repository: job.repository,
        createdAt: timestamp,
        updatedAt: timestamp,
        sources: [],
        messages: [],
        cards: []
      });
    }

    let source = notebook.sources.find(item => item.jobId === job.id);
    if (!source) {
      source = createSource(job, notebook.id);
      notebook = { ...notebook, sources: [...notebook.sources, source], updatedAt: now() };
    }
    this.notebooks.set(notebook.id, notebook);
    return { notebook, source };
  }

  get(id: string): Notebook | undefined {
    const notebook = this.notebooks.get(id);
    return notebook ? notebookSchema.parse(notebook) : undefined;
  }

  findByJobId(jobId: string): Notebook | undefined {
    const notebook = [...this.notebooks.values()].find(item => item.sources.some(source => source.jobId === jobId));
    return notebook ? notebookSchema.parse(notebook) : undefined;
  }

  getSource(id: string): NotebookSource | undefined {
    return [...this.notebooks.values()].flatMap(item => item.sources).find(source => source.id === id);
  }

  getSourceForJob(notebookId: string, jobId: string): NotebookSource | undefined {
    return this.notebooks.get(notebookId)?.sources.find(source => source.jobId === jobId);
  }

  createMessage(input: CreateNotebookMessageInput): NotebookMessage {
    const notebook = this.notebooks.get(input.notebookId);
    if (!notebook) throw new Error("Notebook not found");
    const timestamp = now();
    const message = notebookMessageSchema.parse({
      id: `message_${randomUUID()}`,
      ...input,
      citations: input.citations ?? [],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.notebooks.set(notebook.id, { ...notebook, messages: [...notebook.messages, message], updatedAt: timestamp });
    return message;
  }

  updateMessage(id: string, patch: Partial<Omit<CreateNotebookMessageInput, "notebookId" | "role">> & { role?: NotebookMessage["role"] }): NotebookMessage | undefined {
    for (const notebook of this.notebooks.values()) {
      const existing = notebook.messages.find(message => message.id === id);
      if (!existing) continue;
      const updated = notebookMessageSchema.parse({ ...existing, ...patch, updatedAt: now() });
      this.notebooks.set(notebook.id, {
        ...notebook,
        messages: notebook.messages.map(message => message.id === id ? updated : message),
        updatedAt: updated.updatedAt
      });
      return updated;
    }
    return undefined;
  }

  createCard(input: CreateNotebookCardInput): NotebookCard {
    const notebook = this.notebooks.get(input.notebookId);
    if (!notebook) throw new Error("Notebook not found");
    const card = notebookCardSchema.parse({ id: `card_${randomUUID()}`, ...input, citations: input.citations ?? [], createdAt: now() });
    this.notebooks.set(notebook.id, { ...notebook, cards: [card, ...notebook.cards], updatedAt: card.createdAt });
    return card;
  }

  getSnapshotIndex(repository: string, headSha: string): SnapshotIndex | undefined {
    return this.indexes.get(`${repository}@${headSha}`);
  }

  upsertSnapshotIndex(input: Omit<SnapshotIndex, "id"> & { id?: string }): SnapshotIndex {
    const key = `${input.repository}@${input.headSha}`;
    const value = { ...input, id: input.id ?? this.indexes.get(key)?.id ?? `index_${randomUUID()}` };
    this.indexes.set(key, value);
    return value;
  }

  updateSourceStatus(id: string, status: NotebookSource["indexStatus"], indexedAt?: string, error?: string): NotebookSource | undefined {
    for (const notebook of this.notebooks.values()) {
      const source = notebook.sources.find(item => item.id === id);
      if (!source) continue;
      const updated = notebookSourceSchema.parse({ ...source, indexStatus: status, indexedAt, error });
      this.notebooks.set(notebook.id, { ...notebook, sources: notebook.sources.map(item => item.id === id ? updated : item), updatedAt: now() });
      return updated;
    }
    return undefined;
  }
}

export class SQLiteNotebookStore implements NotebookStore {
  constructor(private readonly database: ConsistencyDatabase) {}

  ensureForJob(job: ReviewJob): { notebook: Notebook; source: NotebookSource } {
    return this.database.transaction(() => {
      const timestamp = now();
      let notebookRow = this.database.prepare("SELECT * FROM notebooks WHERE repository_full_name = ? ORDER BY updated_at DESC LIMIT 1").get(job.repository) as any;
      if (!notebookRow) {
        const id = `notebook_${randomUUID()}`;
        this.database.prepare("INSERT INTO notebooks (id, repository_full_name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, job.repository, timestamp, timestamp);
        notebookRow = { id, repository_full_name: job.repository, created_at: timestamp, updated_at: timestamp };
      }
      let sourceRow = this.database.prepare("SELECT * FROM notebook_sources WHERE notebook_id = ? AND job_id = ?").get(notebookRow.id, job.id) as any;
      if (!sourceRow) {
        const source = createSource(job, notebookRow.id);
        this.database.prepare(`
          INSERT INTO notebook_sources (
            id, notebook_id, job_id, repository_full_name, pull_request_number,
            base_sha, head_sha, index_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(source.id, notebookRow.id, source.jobId, source.repository, source.pullRequestNumber ?? null, source.baseSha, source.headSha, source.indexStatus);
        sourceRow = this.database.prepare("SELECT * FROM notebook_sources WHERE id = ?").get(source.id) as any;
      }
      this.database.prepare("UPDATE notebooks SET updated_at = ? WHERE id = ?").run(timestamp, notebookRow.id);
      return { notebook: this.get(notebookRow.id)!, source: this.sourceFromRow(sourceRow) };
    })();
  }

  get(id: string): Notebook | undefined {
    const row = this.database.prepare("SELECT * FROM notebooks WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    const sources = (this.database.prepare("SELECT * FROM notebook_sources WHERE notebook_id = ? ORDER BY head_sha ASC").all(id) as any[]).map(rowItem => this.sourceFromRow(rowItem));
    const messages = (this.database.prepare("SELECT * FROM notebook_messages WHERE notebook_id = ? ORDER BY created_at ASC").all(id) as any[]).map(rowItem => this.messageFromRow(rowItem));
    const cards = (this.database.prepare("SELECT * FROM notebook_cards WHERE notebook_id = ? ORDER BY created_at DESC").all(id) as any[]).map(rowItem => this.cardFromRow(rowItem));
    return notebookSchema.parse({
      id: row.id,
      repository: row.repository_full_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sources,
      messages,
      cards
    });
  }

  getSource(id: string): NotebookSource | undefined {
    const row = this.database.prepare("SELECT * FROM notebook_sources WHERE id = ?").get(id) as any;
    return row ? this.sourceFromRow(row) : undefined;
  }

  getSourceForJob(notebookId: string, jobId: string): NotebookSource | undefined {
    const row = this.database.prepare("SELECT * FROM notebook_sources WHERE notebook_id = ? AND job_id = ?").get(notebookId, jobId) as any;
    return row ? this.sourceFromRow(row) : undefined;
  }

  findByJobId(jobId: string): Notebook | undefined {
    const row = this.database.prepare("SELECT notebook_id FROM notebook_sources WHERE job_id = ? LIMIT 1").get(jobId) as any;
    return row ? this.get(row.notebook_id) : undefined;
  }

  createMessage(input: CreateNotebookMessageInput): NotebookMessage {
    return this.database.transaction(() => {
      const message = notebookMessageSchema.parse({
        id: `message_${randomUUID()}`,
        ...input,
        citations: input.citations ?? [],
        createdAt: now(),
        updatedAt: now()
      });
      this.database.prepare(`
        INSERT INTO notebook_messages (
          id, notebook_id, role, content, status, source_job_ids_json, citations_json,
          provider, model, token_usage_json, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(message.id, message.notebookId, message.role, message.content, message.status, JSON.stringify(message.sourceJobIds), JSON.stringify(message.citations), message.provider ?? null, message.model ?? null, message.tokenUsage ? JSON.stringify(message.tokenUsage) : null, message.error ?? null, message.createdAt, message.updatedAt);
      this.replaceCitations(message.notebookId, message.id, undefined, message.citations);
      this.touch(message.notebookId, message.updatedAt);
      return message;
    })();
  }

  updateMessage(id: string, patch: Partial<Omit<CreateNotebookMessageInput, "notebookId" | "role">> & { role?: NotebookMessage["role"] }): NotebookMessage | undefined {
    return this.database.transaction(() => {
      const row = this.database.prepare("SELECT * FROM notebook_messages WHERE id = ?").get(id) as any;
      if (!row) return undefined;
      const current = this.messageFromRow(row);
      const updated = notebookMessageSchema.parse({ ...current, ...patch, updatedAt: now() });
      this.database.prepare(`
        UPDATE notebook_messages SET role = ?, content = ?, status = ?, source_job_ids_json = ?, citations_json = ?,
          provider = ?, model = ?, token_usage_json = ?, error = ?, updated_at = ? WHERE id = ?
      `).run(updated.role, updated.content, updated.status, JSON.stringify(updated.sourceJobIds), JSON.stringify(updated.citations), updated.provider ?? null, updated.model ?? null, updated.tokenUsage ? JSON.stringify(updated.tokenUsage) : null, updated.error ?? null, updated.updatedAt, id);
      this.replaceCitations(updated.notebookId, updated.id, undefined, updated.citations);
      this.touch(updated.notebookId, updated.updatedAt);
      return updated;
    })();
  }

  createCard(input: CreateNotebookCardInput): NotebookCard {
    return this.database.transaction(() => {
      const card = notebookCardSchema.parse({ id: `card_${randomUUID()}`, ...input, citations: input.citations ?? [], createdAt: now() });
      this.database.prepare(`
        INSERT INTO notebook_cards (
          id, notebook_id, kind, title, content, source_job_ids_json, citations_json,
          status, provider, model, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(card.id, card.notebookId, card.kind, card.title, card.content, JSON.stringify(card.sourceJobIds), JSON.stringify(card.citations), card.status, card.provider ?? null, card.model ?? null, card.createdAt);
      this.replaceCitations(card.notebookId, undefined, card.id, card.citations);
      this.touch(card.notebookId, card.createdAt);
      return card;
    })();
  }

  getSnapshotIndex(repository: string, headSha: string): SnapshotIndex | undefined {
    const row = this.database.prepare("SELECT * FROM repository_snapshot_indexes WHERE repository_full_name = ? AND head_sha = ?").get(repository, headSha) as any;
    if (!row) return undefined;
    return this.indexFromRow(row);
  }

  upsertSnapshotIndex(input: Omit<SnapshotIndex, "id"> & { id?: string }): SnapshotIndex {
    const id = input.id ?? `index_${randomUUID()}`;
    this.database.prepare(`
      INSERT INTO repository_snapshot_indexes (
        id, repository_full_name, head_sha, status, workspace_path, manifest_json, indexed_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_full_name, head_sha) DO UPDATE SET
        status = excluded.status, workspace_path = excluded.workspace_path,
        manifest_json = excluded.manifest_json, indexed_at = excluded.indexed_at, error = excluded.error
    `).run(id, input.repository, input.headSha, input.status, input.workspacePath ?? null, JSON.stringify(input.manifest), input.indexedAt ?? null, input.error ?? null);
    return this.getSnapshotIndex(input.repository, input.headSha)!;
  }

  updateSourceStatus(id: string, status: NotebookSource["indexStatus"], indexedAt?: string, error?: string): NotebookSource | undefined {
    this.database.prepare("UPDATE notebook_sources SET index_status = ?, indexed_at = ?, error = ? WHERE id = ?").run(status, indexedAt ?? null, error ?? null, id);
    const row = this.database.prepare("SELECT * FROM notebook_sources WHERE id = ?").get(id) as any;
    return row ? this.sourceFromRow(row) : undefined;
  }

  private touch(notebookId: string, timestamp: string): void {
    this.database.prepare("UPDATE notebooks SET updated_at = ? WHERE id = ?").run(timestamp, notebookId);
  }

  private sourceFromRow(row: any): NotebookSource {
    return notebookSourceSchema.parse({
      id: row.id,
      repository: row.repository_full_name,
      pullRequestNumber: row.pull_request_number ?? undefined,
      jobId: row.job_id,
      baseSha: row.base_sha,
      headSha: row.head_sha,
      indexStatus: row.index_status,
      indexedAt: row.indexed_at ?? undefined,
      error: row.error ?? undefined
    });
  }

  private messageFromRow(row: any): NotebookMessage {
    return notebookMessageSchema.parse({
      id: row.id,
      notebookId: row.notebook_id,
      role: row.role,
      content: row.content,
      status: row.status,
      sourceJobIds: JSON.parse(row.source_job_ids_json),
      citations: this.citationsFor("message_id", row.id, row.citations_json),
      provider: row.provider ?? undefined,
      model: row.model ?? undefined,
      tokenUsage: row.token_usage_json ? JSON.parse(row.token_usage_json) : undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private cardFromRow(row: any): NotebookCard {
    return notebookCardSchema.parse({
      id: row.id,
      notebookId: row.notebook_id,
      kind: row.kind,
      title: row.title,
      content: row.content,
      sourceJobIds: JSON.parse(row.source_job_ids_json),
      citations: this.citationsFor("card_id", row.id, row.citations_json),
      status: row.status,
      provider: row.provider ?? undefined,
      model: row.model ?? undefined,
      createdAt: row.created_at
    });
  }

  private replaceCitations(notebookId: string, messageId: string | undefined, cardId: string | undefined, citations: NotebookCitation[]): void {
    const scopeColumn = messageId ? "message_id" : "card_id";
    const scopeId = messageId ?? cardId;
    if (!scopeId) throw new Error("Notebook citation owner is required");
    this.database.prepare(`DELETE FROM notebook_citations WHERE ${scopeColumn} = ?`).run(scopeId);
    const insert = this.database.prepare(`
      INSERT INTO notebook_citations (
        id, notebook_id, message_id, card_id, repository_full_name,
        pull_request_number, job_id, head_sha, file, start_line, end_line,
        excerpt, kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const citation of citations) {
      insert.run(
        citation.id, notebookId, messageId ?? null, cardId ?? null,
        citation.repository, citation.pullRequestNumber, citation.jobId,
        citation.headSha, citation.file, citation.startLine, citation.endLine,
        citation.excerpt, citation.kind
      );
    }
  }

  private citationsFor(scopeColumn: "message_id" | "card_id", scopeId: string, legacyJson: string): NotebookCitation[] {
    const rows = this.database.prepare(`SELECT * FROM notebook_citations WHERE ${scopeColumn} = ? ORDER BY rowid ASC`).all(scopeId) as any[];
    if (rows.length > 0) {
      return rows.map(row => notebookCitationSchema.parse({
        id: row.id,
        repository: row.repository_full_name,
        pullRequestNumber: row.pull_request_number,
        jobId: row.job_id,
        headSha: row.head_sha,
        file: row.file,
        startLine: row.start_line,
        endLine: row.end_line,
        // 防御性兜底：旧数据可能存过空 excerpt
        excerpt: (row.excerpt ?? "").trim().length > 0 ? row.excerpt : row.file,
        kind: row.kind
      }));
    }
    return JSON.parse(legacyJson ?? "[]") as NotebookCitation[];
  }

  private indexFromRow(row: any): SnapshotIndex {
    return {
      id: row.id,
      repository: row.repository_full_name,
      headSha: row.head_sha,
      status: row.status,
      workspacePath: row.workspace_path ?? undefined,
      manifest: JSON.parse(row.manifest_json),
      indexedAt: row.indexed_at ?? undefined,
      error: row.error ?? undefined
    };
  }
}
