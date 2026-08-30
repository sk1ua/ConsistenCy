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
import { containsSensitiveData, sanitizeExecutionError, sanitizeStructuredData, sanitizeValidationIssues } from "../security/redact";
import {
  workflowRuntimeDefinitionSchema,
  type WorkflowRuntimeDefinition,
  type WorkflowRuntimeDefinitionRevision,
  type WorkflowRuntimeDefinitionSummary,
  type WorkflowRuntimeRun,
  type WorkflowRuntimeRunSummary,
  type WorkflowRuntimeRunTrigger,
  type WorkflowRuntimeValidationIssue,
} from "@consistency/schema";

export type WorkflowRuntimeTriggerPlanStatus =
  | "pending"
  | "executing"
  | "succeeded"
  | "failed"
  | "skipped";

export interface WorkflowRuntimeTriggerPlan {
  id: string;
  repositoryId: string;
  definitionId: string;
  dedupeKey: string;
  sourceEventId: string;
  status: WorkflowRuntimeTriggerPlanStatus;
  runId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

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
const TRUSTED_BUILTIN_SEED = Symbol("trusted-builtin-seed");
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
  /** Trigger provenance (NULL on rows persisted before 0020). */
  trigger_source?: "manual" | "repository_change" | null;
  trigger_event_id?: string | null;
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
    validationIssues: sanitizeValidationIssues(JSON.parse(row.validation_issues_json) as WorkflowRuntimeValidationIssue[]) as WorkflowRuntimeValidationIssue[],
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
  /** How the run was created (NULL columns on pre-0020 rows). */
  trigger?: WorkflowRuntimeRunTrigger;
};

function runTriggerFromRow(row: Pick<RunRow, "trigger_source" | "trigger_event_id">): WorkflowRuntimeRunTrigger | undefined {
  if (row.trigger_source !== "manual" && row.trigger_source !== "repository_change") return undefined;
  return {
    source: row.trigger_source,
    ...(row.trigger_event_id == null ? {} : { eventId: row.trigger_event_id }),
  };
}

interface TriggerPlanRow {
  id: string;
  repository_id: string;
  definition_id: string;
  dedupe_key: string;
  source_event_id: string;
  status: WorkflowRuntimeTriggerPlanStatus;
  run_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

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
    /** Stable id used only by immutable runtime-native built-in seeds. */
    revisionId?: string;
    [TRUSTED_BUILTIN_SEED]?: true;
  }): WorkflowRuntimeDefinitionRevision {
    if (input.origin === "builtin" && input[TRUSTED_BUILTIN_SEED] !== true) {
      throw new WorkflowRuntimeStoreError(
        "Builtin definitions can only be seeded through the trusted host seed API",
        "WORKFLOW_BUILTIN_SEED_FORBIDDEN",
        403,
      );
    }
    if (input.definition.id !== input.definitionId) {
      throw new WorkflowRuntimeStoreError(
        "definition.id does not match the target definitionId",
        "WORKFLOW_DEFINITION_ID_MISMATCH",
        400,
      );
    }
    // User definitions are executable semantics: never sanitize them before
    // persistence. Reject sensitive keys/values and local paths instead.
    if (input[TRUSTED_BUILTIN_SEED] !== true && containsSensitiveData(input.definition)) {
      throw new WorkflowRuntimeStoreError(
        "Workflow definition contains sensitive data or a local absolute path",
        "WORKFLOW_DEFINITION_SENSITIVE_DATA",
        400,
      );
    }
    const persistedValidationIssues = sanitizeValidationIssues(input.validationIssues);
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
      const revisionId = input.revisionId ?? `wfrev_${randomUUID()}`;
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
          JSON.stringify(persistedValidationIssues),
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

  /** Trusted-only immutable builtin seed entry point. */
  appendBuiltinRevision(input: {
    definitionId: string;
    definition: WorkflowRuntimeDefinition;
    status: "validated" | "draft_with_issues";
    validationIssues: WorkflowRuntimeValidationIssue[];
    revisionId: string;
  }): WorkflowRuntimeDefinitionRevision {
    if (input.definition.id !== input.definitionId || input.status !== "validated") {
      throw new WorkflowRuntimeStoreError("Invalid builtin seed", "WORKFLOW_BUILTIN_SEED_INVALID", 500);
    }
    return this.appendRevision({ ...input, origin: "builtin", [TRUSTED_BUILTIN_SEED]: true });
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
      // Keep repository bindings as durable intent records so the UI can show
      // an honest unavailable definition after deletion; triggerBinding still
      // fails closed on the missing definition revision.
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
            created_at, finished_at, evidence_json, mini_report_json, error, trigger_source, trigger_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(sanitizeStructuredData(input.evidence)),
        input.miniReport === undefined ? null : JSON.stringify(sanitizeStructuredData(input.miniReport)),
        input.error === undefined ? null : sanitizeExecutionError(input.error),
        input.trigger?.source ?? null,
        input.trigger?.eventId ?? null,
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
        JSON.stringify(sanitizeStructuredData(input.evidence)),
        input.miniReport === undefined ? null : JSON.stringify(sanitizeStructuredData(input.miniReport)),
        input.error === undefined ? null : sanitizeExecutionError(input.error),
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
    const evidence = sanitizeStructuredData(JSON.parse(row.evidence_json) as unknown[]) as unknown[];
    const miniReport = row.mini_report_json === null ? undefined : sanitizeStructuredData(JSON.parse(row.mini_report_json));
    const trigger = runTriggerFromRow(row);
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
      ...(row.error === null ? {} : { error: sanitizeExecutionError(row.error) }),
      ...(trigger === undefined ? {} : { trigger }),
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
        ...(row.error === null ? {} : { error: sanitizeExecutionError(row.error) }),
        ...(trigger === undefined ? {} : { trigger }),
      },
    };
  }

  listRuns(limit = DEFAULT_RUNS_LIMIT): WorkflowRuntimeRunSummary[] {
    const normalized = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_RUNS_LIMIT) : DEFAULT_RUNS_LIMIT;
    const rows = this.#database
      .prepare(
        `SELECT id, definition_id, revision_id, origin, status, repository, head_sha,
                created_at, finished_at, mini_report_json, error, trigger_source, trigger_event_id
         FROM workflow_runtime_runs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(normalized) as (Omit<RunRow, "evidence_json"> & { mini_report_json: string | null })[];
    return rows.map((row) => {
      const report = row.mini_report_json === null ? null : (sanitizeStructuredData(JSON.parse(row.mini_report_json)) as { findings?: unknown[]; evidenceCount?: number });
      const trigger = runTriggerFromRow(row);
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
        ...(row.error === null ? {} : { error: sanitizeExecutionError(row.error) }),
        ...(trigger === undefined ? {} : { trigger }),
      };
    });
  }

  countRunsForDefinition(definitionId: string): number {
    const row = this.#database.prepare("SELECT COUNT(*) AS n FROM workflow_runtime_runs WHERE definition_id = ?").get(definitionId) as { n: number };
    return row.n;
  }

  /** A catalog verification receipt is derived only from a successful persisted run. */
  getLatestVerificationReceipt(definitionId: string, revisionId: string, checksum: string): { verified: true } | undefined {
    const rows = this.#database.prepare("SELECT revision_id, evidence_json, mini_report_json FROM workflow_runtime_runs WHERE definition_id = ? AND revision_id = ? AND status = 'succeeded' ORDER BY finished_at DESC").all(definitionId, revisionId) as Array<{ revision_id: string; evidence_json: string; mini_report_json: string | null }>;
    for (const row of rows) {
      try {
        const evidence = JSON.parse(row.evidence_json) as Array<{ id?: string; fingerprint?: string }>;
        const persistedEvidenceIds = new Set(evidence.map(item => item.id).filter((id): id is string => typeof id === "string" && id.length > 0));
        const report = row.mini_report_json ? JSON.parse(row.mini_report_json) as { status?: string; verifiedEvidenceCount?: number; findings?: Array<{ verified?: boolean; evidenceIds?: string[] }> } : undefined;
        const findings = report?.findings ?? [];
        const findingsGroundedInThisRun = findings.length > 0 && findings.every(finding =>
          finding.verified === true &&
          (finding.evidenceIds?.length ?? 0) > 0 &&
          finding.evidenceIds!.every(evidenceId => persistedEvidenceIds.has(evidenceId))
        );
        if (row.revision_id === revisionId && checksum.length === 64 && evidence.length > 0 && persistedEvidenceIds.size === evidence.length && evidence.every(item => Boolean(item.fingerprint)) && report?.status === "succeeded" && (report.verifiedEvidenceCount ?? 0) >= evidence.length && findingsGroundedInThisRun) return { verified: true };
      } catch { /* corrupt run is not evidence */ }
    }
    return undefined;
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
    triggerMode: "manual" | "on_change";
    definition: WorkflowRuntimeDefinitionSummary | null;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.#database
      .prepare("SELECT * FROM workflow_runtime_bindings WHERE repository_id = ? ORDER BY definition_id ASC")
      .all(repositoryId) as Array<{ repository_id: string; definition_id: string; enabled: number; trigger_mode: "manual" | "on_change"; created_at: string; updated_at: string }>;
    if (rows.length === 0) return [];
    const summaries = new Map(this.listDefinitions().map((summary) => [summary.definitionId, summary]));
    return rows.map((row) => ({
      repositoryId: row.repository_id,
      definitionId: row.definition_id,
      enabled: row.enabled === 1,
      triggerMode: row.trigger_mode,
      definition: summaries.get(row.definition_id) ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getBinding(repositoryId: string, definitionId: string): { enabled: boolean; triggerMode: "manual" | "on_change" } | undefined {
    const row = this.#database
      .prepare("SELECT enabled, trigger_mode FROM workflow_runtime_bindings WHERE repository_id = ? AND definition_id = ?")
      .get(repositoryId, definitionId) as { enabled: number; trigger_mode: "manual" | "on_change" } | undefined;
    return row ? { enabled: row.enabled === 1, triggerMode: row.trigger_mode } : undefined;
  }

  /** Idempotent enable/disable toggle (UPSERT — repeated calls never duplicate). */
  setBinding(input: { repositoryId: string; definitionId: string; enabled: boolean; triggerMode?: "manual" | "on_change" }): void {
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
      const triggerMode = input.triggerMode ?? existing?.triggerMode ?? "manual";
      this.#database
        .prepare(
          `INSERT INTO workflow_runtime_bindings (repository_id, definition_id, enabled, trigger_mode, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(repository_id, definition_id)
           DO UPDATE SET enabled = excluded.enabled, trigger_mode = excluded.trigger_mode, updated_at = excluded.updated_at`,
        )
        .run(input.repositoryId, input.definitionId, input.enabled ? 1 : 0, triggerMode, now, now);
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
                created_at, finished_at, mini_report_json, error, trigger_source, trigger_event_id
         FROM workflow_runtime_runs WHERE repository_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(repositoryId, normalized) as Array<Omit<RunRow, "evidence_json"> & { mini_report_json: string | null }>;
    return rows.map((row) => {
      const report = row.mini_report_json === null ? null : (sanitizeStructuredData(JSON.parse(row.mini_report_json)) as { findings?: unknown[]; evidenceCount?: number });
      const trigger = runTriggerFromRow(row);
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
        ...(row.error === null ? {} : { error: sanitizeExecutionError(row.error) }),
        ...(trigger === undefined ? {} : { trigger }),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Trigger plans (CKPT5 — durable ledger from repository change events to
  // at-most-one canonical run each). Plans are DATA: executing one goes
  // through the same binding-gated canonical path as a manual trigger.
  // -------------------------------------------------------------------------

  /**
   * Idempotent plan creation: the UNIQUE(repository, definition, dedupe_key)
   * constraint makes replays of the same repository event no-ops. Returns the
   * stored plan and whether this call created it.
   */
  insertTriggerPlan(input: {
    repositoryId: string;
    definitionId: string;
    dedupeKey: string;
    sourceEventId: string;
  }): { created: boolean; plan: WorkflowRuntimeTriggerPlan } {
    const now = new Date().toISOString();
    const id = "wfplan_" + randomUUID();
    try {
      const result = this.#database
        .prepare(
          `INSERT INTO workflow_runtime_trigger_plans
             (id, repository_id, definition_id, dedupe_key, source_event_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(repository_id, definition_id, dedupe_key) DO NOTHING`,
        )
        .run(id, input.repositoryId, input.definitionId, input.dedupeKey, input.sourceEventId, now, now);
      return { created: result.changes === 1, plan: this.getTriggerPlanById(id) ?? this.getTriggerPlan(input.repositoryId, input.definitionId, input.dedupeKey)! };
    } catch (error) {
      if (error instanceof WorkflowRuntimeStoreError) throw error;
      throw new WorkflowRuntimeStoreError("Failed to persist workflow trigger plan", "WORKFLOW_RUNTIME_STORE_UNAVAILABLE", 503);
    }
  }

  #triggerPlanFromRow(row: TriggerPlanRow): WorkflowRuntimeTriggerPlan {
    return {
      id: row.id,
      repositoryId: row.repository_id,
      definitionId: row.definition_id,
      dedupeKey: row.dedupe_key,
      sourceEventId: row.source_event_id,
      status: row.status,
      ...(row.run_id === null ? {} : { runId: row.run_id }),
      ...(row.error === null ? {} : { error: sanitizeExecutionError(row.error) }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getTriggerPlanById(id: string): WorkflowRuntimeTriggerPlan | undefined {
    const row = this.#database
      .prepare("SELECT * FROM workflow_runtime_trigger_plans WHERE id = ?")
      .get(id) as TriggerPlanRow | undefined;
    return row ? this.#triggerPlanFromRow(row) : undefined;
  }

  getTriggerPlan(repositoryId: string, definitionId: string, dedupeKey: string): WorkflowRuntimeTriggerPlan | undefined {
    const row = this.#database
      .prepare("SELECT * FROM workflow_runtime_trigger_plans WHERE repository_id = ? AND definition_id = ? AND dedupe_key = ?")
      .get(repositoryId, definitionId, dedupeKey) as TriggerPlanRow | undefined;
    return row ? this.#triggerPlanFromRow(row) : undefined;
  }

  /** Oldest-first pending plans (bounded — the executor is single-flight). */
  listPendingTriggerPlans(limit = 5): WorkflowRuntimeTriggerPlan[] {
    const rows = this.#database
      .prepare("SELECT * FROM workflow_runtime_trigger_plans WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?")
      .all(limit) as TriggerPlanRow[];
    return rows.map((row) => this.#triggerPlanFromRow(row));
  }

  /**
   * Claim a pending plan for execution. The guarded UPDATE (WHERE status =
   * 'pending') is the fencing point: exactly one claimant transitions a plan
   * to `executing`, and a lost claim returns undefined.
   */
  claimTriggerPlan(id: string): WorkflowRuntimeTriggerPlan | undefined {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare("UPDATE workflow_runtime_trigger_plans SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(now, id);
    if (result.changes !== 1) return undefined;
    return this.getTriggerPlanById(id);
  }

  /** Terminal transition for a claimed plan (run id + honest sanitized error). */
  completeTriggerPlan(input: {
    id: string;
    status: "succeeded" | "failed" | "skipped";
    runId?: string;
    error?: string;
  }): WorkflowRuntimeTriggerPlan | undefined {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `UPDATE workflow_runtime_trigger_plans
         SET status = ?, run_id = ?, error = ?, updated_at = ?
         WHERE id = ? AND status = 'executing'`,
      )
      .run(input.status, input.runId ?? null, input.error == null ? null : sanitizeExecutionError(input.error), now, input.id);
    if (result.changes !== 1) return undefined;
    return this.getTriggerPlanById(input.id);
  }

  /**
   * Startup recovery: a plan still `executing` after an API restart belongs to
   * a process that no longer exists — mark it FAILED(interrupted) honestly,
   * mirroring `recoverInterruptedRuns`. The UNIQUE dedupe key keeps the same
   * repository event from ever silently re-executing.
   */
  recoverInterruptedTriggerPlans(): number {
    const now = new Date().toISOString();
    const interrupted = this.#database
      .prepare("SELECT id FROM workflow_runtime_trigger_plans WHERE status = 'executing'")
      .all() as { id: string }[];
    const markFailed = this.#database.prepare(
      `UPDATE workflow_runtime_trigger_plans
       SET status = 'failed', error = ?, updated_at = ?
       WHERE id = ? AND status = 'executing'`,
    );
    let recovered = 0;
    for (const row of interrupted) {
      recovered += markFailed.run("trigger execution interrupted by API restart", now, row.id).changes;
    }
    return recovered;
  }
}
