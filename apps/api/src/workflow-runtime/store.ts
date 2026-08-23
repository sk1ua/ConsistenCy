/**
 * WorkflowRuntimeStore — SQLite persistence for the CKPT3 Phase 2
 * workflow-runtime surface (definitions with append-only revisions + run
 * history).
 *
 * Canonical store pattern (mirrors SQLiteAuditDomainStore):
 *   - better-sqlite3 prepared statements;
 *   - `randomUUID` id prefixes (wfdef_ / wfrev_ / wfrun_);
 *   - typed WorkflowRuntimeStoreError carrying an HTTP status/code mapping;
 *   - bounded lists via LIMIT (runs list mirrors repositoryPulses' bounded
 *     LIMIT convention).
 *
 * Boundary: this store lives on the trusted host side, exactly like
 * WorkflowStore / SQLiteAuditDomainStore. It is NOT part of the agent
 * capability system — stored definitions are DATA (revision-pinned at
 * execution time), never authorization carriers.
 */

import { randomUUID } from "node:crypto";
import type { ConsistencyDatabase } from "../db/connection";
import {
  workflowRuntimeDefinitionSchema,
  type WorkflowRuntimeDefinition,
  type WorkflowRuntimeDefinitionRevision,
  type WorkflowRuntimeDefinitionSummary,
  type WorkflowRuntimeRun,
  type WorkflowRuntimeRunSummary,
  type WorkflowRuntimeValidationIssue,
} from "@consistency/schema";

export class WorkflowRuntimeStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 500,
  ) {
    super(message);
    this.name = "WorkflowRuntimeStoreError";
  }
}

/** Bounded runs list — follows the repositoryPulses bounded-LIMIT convention. */
export const DEFAULT_RUNS_LIMIT = 50;
export const MAX_RUNS_LIMIT = 200;
/** Append-only guard: revisions kept per definition (oldest pruned never —
 * append-only is absolute; the cap guards runaway growth at SAVE time). */
export const MAX_DEFINITIONS = 100;
/** Conservative per-repository binding cap (Phase 3 §4.1; no prior convention). */
export const MAX_BINDINGS_PER_REPOSITORY = 20;

interface DefinitionRow {
  definition_id: string;
  origin: "builtin" | "user";
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  id: string;
  definition_id: string;
  revision: number;
  status: "validated" | "draft_with_issues";
  definition_json: string;
  validation_issues_json: string;
  created_at: string;
}

interface RunRow {
  id: string;
  definition_id: string;
  revision_id: string;
  origin: "builtin" | "user";
  status: "running" | "succeeded" | "failed";
  repository: string;
  /** Canonical opaque repository id (NULL on rows persisted before 0018). */
  repository_id?: string | null;
  head_sha: string;
  created_at: string;
  finished_at: string | null;
  evidence_json: string;
  mini_report_json: string | null;
  error: string | null;
}

function parseDefinition(raw: string, definitionId: string): WorkflowRuntimeDefinition {
  try {
    const parsed = workflowRuntimeDefinitionSchema.parse(JSON.parse(raw));
    if (parsed.id !== definitionId) {
      throw new WorkflowRuntimeStoreError("Stored definition id mismatch", "WORKFLOW_RUNTIME_DATA_CORRUPT", 500);
    }
    return parsed;
  } catch (error) {
    if (error instanceof WorkflowRuntimeStoreError) throw error;
    throw new WorkflowRuntimeStoreError("Stored definition revision is corrupt", "WORKFLOW_RUNTIME_DATA_CORRUPT", 500);
  }
}

function revisionFromRow(row: RevisionRow): WorkflowRuntimeDefinitionRevision {
  return {
    revisionId: row.id,
    definitionId: row.definition_id,
    revision: row.revision,
    status: row.status,
    definition: parseDefinition(row.definition_json, row.definition_id),
    validationIssues: JSON.parse(row.validation_issues_json) as WorkflowRuntimeValidationIssue[],
    createdAt: row.created_at,
  };
}

export type PersistedRunInput = {
  runId: string;
  definitionId: string;
  revisionId: string;
  origin: "builtin" | "user";
  status: "running" | "succeeded" | "failed";
  repository: string;
  headSha: string;
  createdAt: string;
  finishedAt?: string;
  evidence: unknown[];
  miniReport?: unknown;
  error?: string;
};

export class WorkflowRuntimeStore {
  readonly #database: ConsistencyDatabase;

  constructor(database: ConsistencyDatabase) {
    this.#database = database;
  }

  // -------------------------------------------------------------------------
  // Definitions
  // -------------------------------------------------------------------------

  listDefinitions(): WorkflowRuntimeDefinitionSummary[] {
    const rows = this.#database
      .prepare(
        `SELECT d.definition_id, d.origin, d.created_at, d.updated_at,
                r.revision, r.status, r.id AS revision_id
         FROM workflow_runtime_definitions d
         LEFT JOIN workflow_runtime_revisions r
           ON r.id = (
             SELECT id FROM workflow_runtime_revisions
             WHERE definition_id = d.definition_id
             ORDER BY revision DESC LIMIT 1
           )
         ORDER BY d.definition_id ASC`,
      )
      .all() as (DefinitionRow & { revision: number | null; status: "validated" | "draft_with_issues" | null; revision_id: string | null })[];
    return rows.map((row) => ({
      definitionId: row.definition_id,
      origin: row.origin,
      latestRevision: row.revision ?? null,
      latestRevisionId: row.revision_id ?? null,
      status: row.status ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  definitionExists(definitionId: string): boolean {
    const row = this.#database
      .prepare("SELECT 1 FROM workflow_runtime_definitions WHERE definition_id = ?")
      .get(definitionId);
    return row !== undefined;
  }

  getLatestRevision(definitionId: string): WorkflowRuntimeDefinitionRevision | undefined {
    const row = this.#database
      .prepare("SELECT * FROM workflow_runtime_revisions WHERE definition_id = ? ORDER BY revision DESC LIMIT 1")
      .get(definitionId) as RevisionRow | undefined;
    return row ? revisionFromRow(row) : undefined;
  }

  getRevision(revisionId: string): WorkflowRuntimeDefinitionRevision | undefined {
    const row = this.#database
      .prepare("SELECT * FROM workflow_runtime_revisions WHERE id = ?")
      .get(revisionId) as RevisionRow | undefined;
    return row ? revisionFromRow(row) : undefined;
  }

  /**
   * Append a new revision (append-only: existing revisions are never
   * modified). Creates the definition record on first save. The builtin seed
   * definition is created once and can never be re-saved.
   */
  appendRevision(input: {
    definitionId: string;
    definition: WorkflowRuntimeDefinition;
    status: "validated" | "draft_with_issues";
    validationIssues: WorkflowRuntimeValidationIssue[];
    origin?: "builtin" | "user";
  }): WorkflowRuntimeDefinitionRevision {
    if (input.definition.id !== input.definitionId) {
      throw new WorkflowRuntimeStoreError(
        "definition.id does not match the target definitionId",
        "WORKFLOW_DEFINITION_ID_MISMATCH",
        400,
      );
    }
    const now = new Date().toISOString();
    const append = this.#database.transaction(() => {
      const existing = this.#database
        .prepare("SELECT origin FROM workflow_runtime_definitions WHERE definition_id = ?")
        .get(input.definitionId) as { origin: "builtin" | "user" } | undefined;

      if (existing) {
        if (existing.origin === "builtin") {
          throw new WorkflowRuntimeStoreError(
            "The built-in definition is immutable",
            "WORKFLOW_DEFINITION_IMMUTABLE",
            409,
          );
        }
        this.#database
          .prepare("UPDATE workflow_runtime_definitions SET updated_at = ? WHERE definition_id = ?")
          .run(now, input.definitionId);
      } else {
        const count = this.#database
          .prepare("SELECT COUNT(*) AS n FROM workflow_runtime_definitions")
          .get() as { n: number };
        if (count.n >= MAX_DEFINITIONS) {
          throw new WorkflowRuntimeStoreError(
            "Workflow definition limit reached",
            "WORKFLOW_DEFINITIONS_LIMIT_REACHED",
            409,
          );
        }
        this.#database
          .prepare(
            "INSERT INTO workflow_runtime_definitions (definition_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run(input.definitionId, input.origin ?? "user", now, now);
      }

      const latest = this.#database
        .prepare("SELECT MAX(revision) AS max FROM workflow_runtime_revisions WHERE definition_id = ?")
        .get(input.definitionId) as { max: number | null };
      const revision = (latest.max ?? 0) + 1;
      const revisionId = `wfrev_${randomUUID()}`;
      this.#database
        .prepare(
          `INSERT INTO workflow_runtime_revisions
             (id, definition_id, revision, status, definition_json, validation_issues_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revisionId,
          input.definitionId,
          revision,
          input.status,
          JSON.stringify(input.definition),
          JSON.stringify(input.validationIssues),
          now,
        );
      return {
        revisionId,
        definitionId: input.definitionId,
        revision,
        status: input.status,
        definition: input.definition,
        validationIssues: input.validationIssues,
        createdAt: now,
      } satisfies WorkflowRuntimeDefinitionRevision;
    });
    try {
      return append();
    } catch (error) {
      if (error instanceof WorkflowRuntimeStoreError) throw error;
      throw new WorkflowRuntimeStoreError("Failed to persist workflow definition", "WORKFLOW_RUNTIME_STORE_UNAVAILABLE", 503);
    }
  }

  /**
   * Delete semantics (chosen per §4.1 — no prior convention existed):
   * deleting a USER definition with run history is REFUSED (history must
   * stay traceable); without history it deletes definition + revisions.
   * Builtin definitions cannot be deleted.
   */
  deleteDefinition(definitionId: string): { deleted: boolean } {
    const del = this.#database.transaction(() => {
      const existing = this.#database
        .prepare("SELECT origin FROM workflow_runtime_definitions WHERE definition_id = ?")
        .get(definitionId) as { origin: "builtin" | "user" } | undefined;
      if (!existing) {
        throw new WorkflowRuntimeStoreError("Workflow definition not found", "WORKFLOW_DEFINITION_NOT_FOUND", 404);
      }
      if (existing.origin === "builtin") {
        throw new WorkflowRuntimeStoreError("The built-in definition cannot be deleted", "WORKFLOW_DEFINITION_IMMUTABLE", 409);
      }
      const runs = this.#database
        .prepare("SELECT COUNT(*) AS n FROM workflow_runtime_runs WHERE definition_id = ?")
        .get(definitionId) as { n: number };
      if (runs.n > 0) {
        throw new WorkflowRuntimeStoreError(
          "Workflow definition has run history and cannot be deleted (revisions are append-only)",
          "WORKFLOW_DEFINITION_HAS_RUN_HISTORY",
          409,
        );
      }
      this.#database.prepare("DELETE FROM workflow_runtime_revisions WHERE definition_id = ?").run(definitionId);
      this.#database.prepare("DELETE FROM workflow_runtime_definitions WHERE definition_id = ?").run(definitionId);
      return { deleted: true };
    });
    try {
      return del();
    } catch (error) {
      if (error instanceof WorkflowRuntimeStoreError) throw error;
      throw new WorkflowRuntimeStoreError("Failed to delete workflow definition", "WORKFLOW_RUNTIME_STORE_UNAVAILABLE", 503);
    }
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  insertRun(input: PersistedRunInput & { repositoryOpaqueId?: string }): void {
    this.#database
      .prepare(
        `INSERT INTO workflow_runtime_runs
           (id, definition_id, revision_id, origin, status, repository, repository_id, head_sha,
            created_at, finished_at, evidence_json, mini_report_json, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.definitionId,
        input.revisionId,
        input.origin,
        input.status,
        input.repository,
        input.repositoryOpaqueId ?? null,
        input.headSha,
        input.createdAt,
        input.finishedAt ?? null,
        JSON.stringify(input.evidence),
        input.miniReport === undefined ? null : JSON.stringify(input.miniReport),
        input.error ?? null,
      );
  }

  updateRunTerminal(input: {
    runId: string;
    status: "succeeded" | "failed";
    finishedAt: string;
    evidence: unknown[];
    miniReport?: unknown;
    error?: string;
  }): void {
    const result = this.#database
      .prepare(
        `UPDATE workflow_runtime_runs
         SET status = ?, finished_at = ?, evidence_json = ?, mini_report_json = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.finishedAt,
        JSON.stringify(input.evidence),
        input.miniReport === undefined ? null : JSON.stringify(input.miniReport),
        input.error ?? null,
        input.runId,
      );
    if (result.changes !== 1) {
      throw new WorkflowRuntimeStoreError("Workflow run not found for update", "WORKFLOW_RUN_NOT_FOUND", 404);
    }
  }

  /**
   * Startup recovery: any run still marked `running` after an API restart is
   * honestly marked FAILED(interrupted) — the process that was executing it
   * no longer exists and success must never be fabricated (§9.5).
   */
  recoverInterruptedRuns(): number {
    const now = new Date().toISOString();
    const interrupted = this.#database
      .prepare("SELECT id FROM workflow_runtime_runs WHERE status = 'running'")
      .all() as { id: string }[];
    const markFailed = this.#database.prepare(
      `UPDATE workflow_runtime_runs
       SET status = 'failed', finished_at = ?, error = ?
       WHERE id = ? AND status = 'running'`,
    );
    let recovered = 0;
    for (const row of interrupted) {
      recovered += markFailed.run(now, "run interrupted by API restart", row.id).changes;
    }
    return recovered;
  }

  getRun(runId: string): (PersistedRunInput & { run: Omit<PersistedRunInput, "origin"> }) | undefined {
    const row = this.#database
      .prepare("SELECT * FROM workflow_runtime_runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    if (!row) return undefined;
    const evidence = JSON.parse(row.evidence_json) as unknown[];
    const miniReport = row.mini_report_json === null ? undefined : JSON.parse(row.mini_report_json);
    return {
      runId: row.id,
      definitionId: row.definition_id,
      revisionId: row.revision_id,
      origin: row.origin,
      status: row.status,
      repository: row.repository,
      headSha: row.head_sha,
      createdAt: row.created_at,
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      evidence,
      ...(miniReport === undefined ? {} : { miniReport }),
      ...(row.error === null ? {} : { error: row.error }),
      run: {
        runId: row.id,
        definitionId: row.definition_id,
        revisionId: row.revision_id,
        status: row.status,
        repository: row.repository,
        headSha: row.head_sha,
        createdAt: row.created_at,
        ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
        evidence,
        ...(miniReport === undefined ? {} : { miniReport }),
        ...(row.error === null ? {} : { error: row.error }),
      },
    };
  }

  listRuns(limit = DEFAULT_RUNS_LIMIT): WorkflowRuntimeRunSummary[] {
    const normalized = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_RUNS_LIMIT) : DEFAULT_RUNS_LIMIT;
    const rows = this.#database
      .prepare(
        `SELECT id, definition_id, revision_id, origin, status, repository, head_sha,
                created_at, finished_at, mini_report_json, error
         FROM workflow_runtime_runs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(normalized) as (Omit<RunRow, "evidence_json"> & { mini_report_json: string | null })[];
    return rows.map((row) => {
      const report = row.mini_report_json === null ? null : (JSON.parse(row.mini_report_json) as { findings?: unknown[]; evidenceCount?: number });
      return {
        runId: row.id,
        definitionId: row.definition_id,
        revisionId: row.revision_id,
        status: row.status,
        createdAt: row.created_at,
        ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
        repository: row.repository,
        headSha: row.head_sha,
        findingCount: report?.findings?.length ?? 0,
        evidenceCount: report?.evidenceCount ?? 0,
        ...(row.error === null ? {} : { error: row.error }),
      };
    });
  }

  countRunsForDefinition(definitionId: string): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS n FROM workflow_runtime_runs WHERE definition_id = ?")
      .get(definitionId) as { n: number };
    return row.n;
  }

  // -------------------------------------------------------------------------
  // Repository bindings (Phase 3)
  // -------------------------------------------------------------------------

  /**
   * Bindings for a repository, joined with the CURRENT definition summary
   * (`definition: null` when the definition no longer exists — honest
   * unavailable, never silently hidden).
   */
  listBindings(repositoryId: string): Array<{
    repositoryId: string;
    definitionId: string;
    enabled: boolean;
    definition: WorkflowRuntimeDefinitionSummary | null;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.#database
      .prepare("SELECT * FROM workflow_runtime_bindings WHERE repository_id = ? ORDER BY definition_id ASC")
      .all(repositoryId) as Array<{ repository_id: string; definition_id: string; enabled: number; created_at: string; updated_at: string }>;
    if (rows.length === 0) return [];
    const summaries = new Map(this.listDefinitions().map((summary) => [summary.definitionId, summary]));
    return rows.map((row) => ({
      repositoryId: row.repository_id,
      definitionId: row.definition_id,
      enabled: row.enabled === 1,
      definition: summaries.get(row.definition_id) ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getBinding(repositoryId: string, definitionId: string): { enabled: boolean } | undefined {
    const row = this.#database
      .prepare("SELECT enabled FROM workflow_runtime_bindings WHERE repository_id = ? AND definition_id = ?")
      .get(repositoryId, definitionId) as { enabled: number } | undefined;
    return row ? { enabled: row.enabled === 1 } : undefined;
  }

  /** Idempotent enable/disable toggle (UPSERT — repeated calls never duplicate). */
  setBinding(input: { repositoryId: string; definitionId: string; enabled: boolean }): void {
    const now = new Date().toISOString();
    try {
      const count = this.#database
        .prepare("SELECT COUNT(*) AS n FROM workflow_runtime_bindings WHERE repository_id = ?")
        .get(input.repositoryId) as { n: number };
      const existing = this.getBinding(input.repositoryId, input.definitionId);
      if (!existing && count.n >= MAX_BINDINGS_PER_REPOSITORY) {
        throw new WorkflowRuntimeStoreError(
          "Repository workflow binding limit reached",
          "WORKFLOW_BINDINGS_LIMIT_REACHED",
          409,
        );
      }
      this.#database
        .prepare(
          `INSERT INTO workflow_runtime_bindings (repository_id, definition_id, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(repository_id, definition_id)
           DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
        )
        .run(input.repositoryId, input.definitionId, input.enabled ? 1 : 0, now, now);
    } catch (error) {
      if (error instanceof WorkflowRuntimeStoreError) throw error;
      throw new WorkflowRuntimeStoreError("Failed to persist workflow binding", "WORKFLOW_RUNTIME_STORE_UNAVAILABLE", 503);
    }
  }

  /** Latest VALIDATED revision of a definition (Phase 3 D2 resolution). */
  getLatestValidatedRevision(definitionId: string): WorkflowRuntimeDefinitionRevision | undefined {
    const row = this.#database
      .prepare("SELECT * FROM workflow_runtime_revisions WHERE definition_id = ? AND status = 'validated' ORDER BY revision DESC LIMIT 1")
      .get(definitionId) as RevisionRow | undefined;
    return row ? revisionFromRow(row) : undefined;
  }

  /** Per-repository run history (canonical repositoryId join — never names). */
  listRunsForRepository(repositoryId: string, limit = DEFAULT_RUNS_LIMIT): WorkflowRuntimeRunSummary[] {
    const normalized = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_RUNS_LIMIT) : DEFAULT_RUNS_LIMIT;
    const rows = this.#database
      .prepare(
        `SELECT id, definition_id, revision_id, status, repository, head_sha,
                created_at, finished_at, mini_report_json, error
         FROM workflow_runtime_runs WHERE repository_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(repositoryId, normalized) as Array<Omit<RunRow, "evidence_json"> & { mini_report_json: string | null }>;
    return rows.map((row) => {
      const report = row.mini_report_json === null ? null : (JSON.parse(row.mini_report_json) as { findings?: unknown[]; evidenceCount?: number });
      return {
        runId: row.id,
        definitionId: row.definition_id,
        revisionId: row.revision_id,
        status: row.status,
        createdAt: row.created_at,
        ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
        repository: row.repository,
        headSha: row.head_sha,
        findingCount: report?.findings?.length ?? 0,
        evidenceCount: report?.evidenceCount ?? 0,
        ...(row.error === null ? {} : { error: row.error }),
      };
    });
  }
}
