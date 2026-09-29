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
import { compileWorkflowRuntimeDefinition } from "./compile";
import { runtimeBuiltinChecksum } from "./definition";
import { getWorkflowServiceByRef } from "./registry";
import {
  isLegacyTerminalReason,
  isTerminalReason,
  tryToExecutionLifecycleState,
  workflowRuntimeRunCoverageSchema,
  workflowRuntimeDefinitionSchema,
  workflowRuntimeExecutablePlanSchema,
  workflowRuntimeNodeIdSchema,
  type WorkflowRuntimeExecutablePlan,
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

/** H24 persists an intent label, never a free-form prompt or executable instruction. */
const HANDOFF_INTENTS = new Set(["review-evidence", "verify-findings"]);
type HandoffIdentity = { readonly runId: string; readonly parentStepId: string; readonly childStepId: string };
type HandoffStatus = "delegated" | "accepted";
interface HandoffRow { id: string; instruction: string; status: HandoffStatus; created_at: string }

/** A plan revision only extends an approval-paused tail; no free-form agent definition is accepted. */
export interface PersistedPlanRevision {
  readonly runId: string;
  readonly revision: number;
  readonly baseDefinitionChecksum: string;
  readonly parentStepId: string;
  readonly appendedNodeId: string;
  readonly plan: WorkflowRuntimeExecutablePlan;
}
interface PlanRevisionRow {
  run_id: string; revision: number; base_definition_checksum: string;
  parent_step_id: string; appended_node_id: string; plan_json: string;
}

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
  /** H14 refined lifecycle (NULL on rows persisted before 0027). */
  lifecycle_state?: string | null;
  terminal_reason?: string | null;
  /**
   * Wave 3 / R3 precise terminal reason (NULL on rows persisted before 0028).
   * Reasons the 0027 CHECK constraint cannot express (interrupted /
   * result_unavailable) live here; the read path is `terminal_detail ??
   * terminal_reason`, so the run row never lies about why it ended.
   */
  terminal_detail?: string | null;
  /** H17 coverage disclosure JSON (NULL on rows persisted before 0027). */
  coverage_json?: string | null;
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
  /** H14 refined lifecycle (NULL columns on pre-0027 rows). */
  lifecycleState?: string;
  terminalReason?: string;
  /** H17 coverage disclosure (NULL column on pre-0027 rows). */
  coverage?: unknown;
  /** Canonical opaque repository binding (read back for H14 recovery). */
  repositoryId?: string;
};

function runTriggerFromRow(row: Pick<RunRow, "trigger_source" | "trigger_event_id">): WorkflowRuntimeRunTrigger | undefined {
  if (row.trigger_source !== "manual" && row.trigger_source !== "repository_change") return undefined;
  return {
    source: row.trigger_source,
    ...(row.trigger_event_id == null ? {} : { eventId: row.trigger_event_id }),
  };
}

/** H14/H17 row projection: refined lifecycle + coverage disclosure (validated). */
function runLifecycleFromRow(
  row: Pick<RunRow, "lifecycle_state" | "terminal_reason" | "coverage_json"> & { terminal_detail?: string | null },
): { lifecycleState?: WorkflowRuntimeRunSummary["lifecycleState"]; terminalReason?: WorkflowRuntimeRunSummary["terminalReason"]; coverage?: WorkflowRuntimeRunSummary["coverage"] } {
  // Fail-closed read projection: an unrecognized lifecycle value or a corrupt
  // coverage payload surfaces as ABSENT, never as fabricated data.
  const lifecycleState = tryToExecutionLifecycleState(row.lifecycle_state ?? "");
  let coverage: WorkflowRuntimeRunSummary["coverage"];
  if (row.coverage_json != null) {
    try {
      const parsed = workflowRuntimeRunCoverageSchema.safeParse(JSON.parse(row.coverage_json));
      if (parsed.success) coverage = parsed.data;
    } catch {
      coverage = undefined;
    }
  }
  // Wave 3 / R3: the PRECISE reason wins over the legacy-capped column (0028);
  // an unrecognized stored value is dropped rather than surfaced as a lie.
  const storedReason = row.terminal_detail ?? row.terminal_reason;
  const terminalReason = storedReason != null && isTerminalReason(storedReason) ? storedReason : undefined;
  return {
    ...(lifecycleState === undefined ? {} : { lifecycleState }),
    ...(terminalReason === undefined ? {} : { terminalReason }),
    ...(coverage === undefined ? {} : { coverage }),
  };
}

/**
 * Wave 3 / R3 write split: a reason the pre-0028 CHECK constraint accepts goes
 * into `terminal_reason` (legacy readers keep working); any other reason goes
 * into `terminal_detail` with `terminal_reason` left NULL — never coerced into
 * a false legacy value such as fatal_error.
 */
function splitTerminalReason(reason: string | undefined): { terminalReason: string | null; terminalDetail: string | null } {
  if (reason === undefined) return { terminalReason: null, terminalDetail: null };
  return isTerminalReason(reason) && isLegacyTerminalReason(reason)
    ? { terminalReason: reason, terminalDetail: null }
    : { terminalReason: null, terminalDetail: reason };
}

/** Canonical opaque repository binding of a run (H14 recovery re-trigger). */
function runRepositoryIdFromRow(row: Pick<RunRow, "repository_id">): { repositoryId?: string } {
  return row.repository_id ? { repositoryId: row.repository_id } : {};
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
    // Same reason split as updateRunTerminal (0028): a precise reason outside
    // the 0027 CHECK vocabulary is stored in terminal_detail, never coerced.
    const reason = splitTerminalReason(input.terminalReason);
    this.#database
      .prepare(
        `INSERT INTO workflow_runtime_runs
           (id, definition_id, revision_id, origin, status, repository, repository_id, head_sha,
            created_at, finished_at, evidence_json, mini_report_json, error, trigger_source, trigger_event_id,
            lifecycle_state, terminal_reason, terminal_detail, coverage_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.lifecycleState ?? null,
        reason.terminalReason,
        reason.terminalDetail,
        input.coverage === undefined ? null : JSON.stringify(sanitizeStructuredData(input.coverage)),
      );
  }

  /**
   * Terminal run-state update. Wave 3 / R3 contract:
   *   - a run that is STILL `running` is updated atomically (the SQL gate
   *     `WHERE status = 'running'` makes a concurrent terminal write win once);
   *   - repeating the SAME terminal facts is idempotent (a replay never
   *     rewrites history);
   *   - a DIFFERENT terminal verdict is refused with a typed 409 conflict —
   *     a late `succeeded` can never reverse an already-recorded failure;
   *   - the precise reason is split across `terminal_reason` (reasons the 0027
   *     CHECK accepts) and `terminal_detail` (everything else), never coerced.
   */
  updateRunTerminal(input: {
    runId: string;
    status: "succeeded" | "failed";
    finishedAt: string;
    evidence: unknown[];
    miniReport?: unknown;
    error?: string;
    /** H14: refined lifecycle persisted beside the coarse status. */
    lifecycleState?: string;
    terminalReason?: string;
  }): void {
    const reason = splitTerminalReason(input.terminalReason);
    const existing = this.#database
      .prepare("SELECT status, lifecycle_state, terminal_reason, terminal_detail FROM workflow_runtime_runs WHERE id = ?")
      .get(input.runId) as Pick<RunRow, "status" | "lifecycle_state" | "terminal_reason" | "terminal_detail"> | undefined;
    if (!existing) {
      throw new WorkflowRuntimeStoreError("Workflow run not found for update", "WORKFLOW_RUN_NOT_FOUND", 404);
    }
    if (existing.status !== "running") {
      const sameFacts = existing.status === input.status
        && (existing.lifecycle_state ?? null) === (input.lifecycleState ?? null)
        && (existing.terminal_detail ?? null) === reason.terminalDetail
        && (existing.terminal_reason ?? null) === reason.terminalReason;
      if (sameFacts) return; // idempotent replay — history is not rewritten
      throw new WorkflowRuntimeStoreError(
        `Workflow run already reached terminal state '${existing.status}'`
          + ` (lifecycle '${existing.lifecycle_state ?? "unknown"}', reason '${existing.terminal_detail ?? existing.terminal_reason ?? "unknown"}');`
          + ` a later '${input.status}' verdict is refused — a terminal state is never reversed`,
        "WORKFLOW_RUN_TERMINAL_CONFLICT",
        409,
      );
    }
    const result = this.#database
      .prepare(
        `UPDATE workflow_runtime_runs
         SET status = ?, finished_at = ?, evidence_json = ?, mini_report_json = ?, error = ?,
             lifecycle_state = ?, terminal_reason = ?, terminal_detail = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        input.status,
        input.finishedAt,
        JSON.stringify(sanitizeStructuredData(input.evidence)),
        input.miniReport === undefined ? null : JSON.stringify(sanitizeStructuredData(input.miniReport)),
        input.error === undefined ? null : sanitizeExecutionError(input.error),
        input.lifecycleState ?? null,
        reason.terminalReason,
        reason.terminalDetail,
        input.runId,
      );
    if (result.changes !== 1) {
      // Raced by another terminal write between the check and the update: the
      // winner's facts stand, this caller is told rather than silently losing.
      throw new WorkflowRuntimeStoreError(
        "Workflow run reached a terminal state concurrently; this terminal write was refused",
        "WORKFLOW_RUN_TERMINAL_CONFLICT",
        409,
      );
    }
  }

  /**
   * Startup recovery: any run still marked `running` after an API restart is
   * honestly marked FAILED(interrupted) — the process that was executing it
   * no longer exists and success must never be fabricated (§9.5). H14: the
   * refined lifecycle is persisted too; the checkpoint recovery plan is built
   * separately by the host (this method stays the no-ledger fallback path).
   *
   * Wave 3 / R3: the reason is `interrupted`, NOT `fatal_error` — nothing
   * failed, the run was cut off, and the precise reason rides in
   * `terminal_detail` (outside the 0027 vocabulary).
   */
  recoverInterruptedRuns(): number {
    const now = new Date().toISOString();
    const interrupted = this.#database
      .prepare("SELECT id FROM workflow_runtime_runs WHERE status = 'running' AND coalesce(lifecycle_state, '') != 'awaiting_input'")
      .all() as { id: string }[];
    const markFailed = this.#database.prepare(
      `UPDATE workflow_runtime_runs
       SET status = 'failed', finished_at = ?, error = ?, lifecycle_state = 'failed',
           terminal_reason = NULL, terminal_detail = 'interrupted'
       WHERE id = ? AND status = 'running'`,
    );
    let recovered = 0;
    for (const row of interrupted) {
      recovered += markFailed.run(now, "run interrupted by API restart", row.id).changes;
    }
    return recovered;
  }

  /** H14: ids of runs still marked `running` (the startup-scan input). */
  listRunningRunIds(): string[] {
    return (this.#database
      .prepare("SELECT id FROM workflow_runtime_runs WHERE status = 'running' ORDER BY created_at ASC")
      .all() as { id: string }[]).map((row) => row.id);
  }

  getRun(runId: string): (PersistedRunInput & { run: Omit<PersistedRunInput, "origin"> }) | undefined {
    const row = this.#database
      .prepare("SELECT * FROM workflow_runtime_runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    if (!row) return undefined;
    const evidence = sanitizeStructuredData(JSON.parse(row.evidence_json) as unknown[]) as unknown[];
    const miniReport = row.mini_report_json === null ? undefined : sanitizeStructuredData(JSON.parse(row.mini_report_json));
    const trigger = runTriggerFromRow(row);
    const lifecycle = runLifecycleFromRow(row);
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
      ...lifecycle,
      ...runRepositoryIdFromRow(row),
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
        ...lifecycle,
      },
    };
  }

  listRuns(limit = DEFAULT_RUNS_LIMIT): WorkflowRuntimeRunSummary[] {
    const normalized = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_RUNS_LIMIT) : DEFAULT_RUNS_LIMIT;
    const rows = this.#database
      .prepare(
        `SELECT id, definition_id, revision_id, origin, status, repository, head_sha,
                created_at, finished_at, mini_report_json, error, trigger_source, trigger_event_id,
                lifecycle_state, terminal_reason, terminal_detail, coverage_json
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
        ...runLifecycleFromRow(row),
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
                created_at, finished_at, mini_report_json, error, trigger_source, trigger_event_id,
                lifecycle_state, terminal_reason, terminal_detail, coverage_json
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
        ...runLifecycleFromRow(row),
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

  /**
   * H18: persist a human-wait request before the step is considered waiting.
   * Same key is idempotent. A different expiry on the same key is a conflict.
   */
  requestApproval(input: { readonly runId: string; readonly stepId: string; readonly expiresAt: string }): { readonly requestedAt: string; readonly expiresAt: string } {
    const now = new Date().toISOString();
    const existing = this.#database
      .prepare("SELECT requested_at, expires_at, decision FROM workflow_runtime_approvals WHERE run_id = ? AND step_id = ?")
      .get(input.runId, input.stepId) as { requested_at: string; expires_at: string; decision: string | null } | undefined;
    if (existing) {
      if (existing.expires_at !== input.expiresAt) {
        throw new WorkflowRuntimeStoreError("Approval request identity does not match the stored wait", "WORKFLOW_APPROVAL_CONFLICT", 409);
      }
      return { requestedAt: existing.requested_at, expiresAt: existing.expires_at };
    }
    this.#database.prepare(
      `INSERT INTO workflow_runtime_approvals (run_id, step_id, decision, requested_at, expires_at, decided_at)
       VALUES (?, ?, NULL, ?, ?, NULL)`,
    ).run(input.runId, input.stepId, now, input.expiresAt);
    return { requestedAt: now, expiresAt: input.expiresAt };
  }

  /**
   * Decide a waiting step. Expired, repeated, or mismatched decisions fail
   * closed and do not authorize anything.
   */
  decideApproval(input: {
    readonly runId: string;
    readonly stepId: string;
    readonly decision: "approved" | "rejected";
    readonly now?: string;
  }): { readonly decision: "approved" | "rejected"; readonly decidedAt: string } {
    const now = input.now ?? new Date().toISOString();
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare("SELECT decision, expires_at FROM workflow_runtime_approvals WHERE run_id = ? AND step_id = ?")
        .get(input.runId, input.stepId) as { decision: string | null; expires_at: string } | undefined;
      if (!row) {
        throw new WorkflowRuntimeStoreError("No approval request exists for this step", "WORKFLOW_APPROVAL_NOT_FOUND", 404);
      }
      if (row.decision) {
        throw new WorkflowRuntimeStoreError("Approval was already decided; a repeat click does not authorize again", "WORKFLOW_APPROVAL_REPLAY", 409);
      }
      if (now > row.expires_at) {
        throw new WorkflowRuntimeStoreError("Approval expired and does not authorize the step", "WORKFLOW_APPROVAL_EXPIRED", 409);
      }
      // A request is not itself authority: the run must still be at its
      // durable human-wait boundary. A cancelled/failed run cannot be approved.
      const updated = this.#database.prepare(
        `UPDATE workflow_runtime_approvals
         SET decision = ?, decided_at = ?
         WHERE run_id = ? AND step_id = ? AND decision IS NULL
           AND EXISTS (SELECT 1 FROM workflow_runtime_runs
                       WHERE id = ? AND status = 'running' AND lifecycle_state = 'awaiting_input')`,
      ).run(input.decision, now, input.runId, input.stepId, input.runId);
      if (updated.changes !== 1) {
        throw new WorkflowRuntimeStoreError("Run is not awaiting approval", "WORKFLOW_APPROVAL_RUN_NOT_WAITABLE", 409);
      }
      return { decision: input.decision, decidedAt: now };
    })();
  }

  /**
   * Consume one approved wait as the single dispatch claim. The guarded
   * lifecycle transition is the fence: a repeated decision, a second caller,
   * or a process restart cannot turn the stored approval into another claim.
   */
  claimApprovedContinuation(input: { readonly runId: string; readonly stepId: string }): boolean {
    const claimed = this.#database.prepare(
      `UPDATE workflow_runtime_runs SET lifecycle_state = 'running', error = NULL
       WHERE id = ? AND status = 'running' AND lifecycle_state = 'awaiting_input'
         AND EXISTS (SELECT 1 FROM workflow_runtime_approvals
                     WHERE run_id = ? AND step_id = ? AND decision = 'approved')`,
    ).run(input.runId, input.runId, input.stepId);
    return claimed.changes === 1;
  }

  /** Rebuild every H19 revision from the pinned base; a stored plan is an integrity check, never authority. */
  getPlanRevision(runId: string): PersistedPlanRevision | undefined {
    const rows = this.#database.prepare(
      "SELECT run_id, revision, base_definition_checksum, parent_step_id, appended_node_id, plan_json FROM workflow_runtime_plan_revisions WHERE run_id = ? ORDER BY revision ASC",
    ).all(runId) as PlanRevisionRow[];
    if (rows.length === 0) return undefined;
    const run = this.getRun(runId);
    const base = run && this.getRevision(run.revisionId);
    if (!run || !base || base.definitionId !== run.definitionId || base.status !== "validated") {
      throw new WorkflowRuntimeStoreError("Runtime plan base revision unavailable", "WORKFLOW_PLAN_REVISION_CORRUPT", 409);
    }
    const checksum = runtimeBuiltinChecksum(base.definition);
    const compiled = compileWorkflowRuntimeDefinition(base.definition, (definitionId, revisionId) => {
      if (!revisionId) return undefined;
      const child = this.getRevision(revisionId);
      return child && child.definitionId === definitionId && child.status === "validated"
        ? { definition: child.definition, revisionId: child.revisionId } : undefined;
    });
    if (!compiled.ok || !compiled.plan) {
      throw new WorkflowRuntimeStoreError("Runtime plan base no longer compiles", "WORKFLOW_PLAN_REVISION_CORRUPT", 409);
    }
    let plan = compiled.plan;
    const service = getWorkflowServiceByRef("persisted-evidence.verifier");
    if (!service || service.kind !== "persisted-evidence-verifier") {
      throw new WorkflowRuntimeStoreError("Runtime verifier service unavailable", "WORKFLOW_PLAN_REVISION_CORRUPT", 409);
    }
    for (const [index, row] of rows.entries()) {
      if (row.revision !== index + 1 || index >= 4 || row.base_definition_checksum !== checksum
        || row.run_id !== runId || row.parent_step_id !== plan.agentSpecs.at(-1)?.nodeId
        || !workflowRuntimeNodeIdSchema.max(128).safeParse(row.appended_node_id).success
        || plan.agentSpecs.some(spec => spec.nodeId === row.appended_node_id)) {
        throw new WorkflowRuntimeStoreError("Runtime plan revision identity is corrupt", "WORKFLOW_PLAN_REVISION_CORRUPT", 409);
      }
      plan = {
        ...plan,
        agentSpecs: [...plan.agentSpecs, {
          nodeId: row.appended_node_id, serviceRef: service.serviceRef,
          order: plan.agentSpecs.length, dependsOn: [row.parent_step_id],
          coeffects: [...service.coeffects], capabilityRequirements: [...service.capabilityRequirements], parameters: {},
        }],
      };
      let stored: unknown;
      try { stored = JSON.parse(row.plan_json); } catch { /* invalid plans fail below */ }
      const parsed = workflowRuntimeExecutablePlanSchema.safeParse(stored);
      if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(plan)) {
        throw new WorkflowRuntimeStoreError("Stored runtime plan differs from pinned graph", "WORKFLOW_PLAN_REVISION_CORRUPT", 409);
      }
    }
    const last = rows.at(-1)!;
    return { runId, revision: last.revision, baseDefinitionChecksum: checksum,
      parentStepId: last.parent_step_id, appendedNodeId: last.appended_node_id, plan };
  }

  /** CAS append, including the human-wait and dispatch-ledger guards, in ONE SQLite transaction. */
  appendWaitingPlanRevision(input: { runId: string; stepId: string; nodeId: string; expectedRevision: number }): PersistedPlanRevision {
    const conflict = (reason: string): never => { throw new WorkflowRuntimeStoreError(reason, "WORKFLOW_PLAN_REVISION_CONFLICT", 409); };
    return this.#database.transaction(() => {
      if (!workflowRuntimeNodeIdSchema.max(128).safeParse(input.nodeId).success
        || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= 4) {
        return conflict("Runtime plan revision budget or node id invalid");
      }
      const run = this.getRun(input.runId);
      if (!run || run.status !== "running" || run.lifecycleState !== "awaiting_input") return conflict("Run is not paused for approval");
      const approval = this.getApproval(input.runId, input.stepId);
      if (!approval || approval.decision !== null || approval.expiresAt <= new Date().toISOString()) return conflict("Approval wait is not pending");
      const current = this.getPlanRevision(input.runId);
      if ((current?.revision ?? 0) !== input.expectedRevision) return conflict("Runtime plan revision CAS lost");
      const base = this.getRevision(run.revisionId);
      if (!base || base.definitionId !== run.definitionId || base.status !== "validated") return conflict("Pinned definition unavailable");
      const compiled = compileWorkflowRuntimeDefinition(base.definition, (definitionId, revisionId) => {
        if (!revisionId) return undefined;
        const child = this.getRevision(revisionId);
        return child && child.definitionId === definitionId && child.status === "validated"
          ? { definition: child.definition, revisionId: child.revisionId } : undefined;
      });
      if (!compiled.ok || !compiled.plan || compiled.plan.agentSpecs.length + input.expectedRevision >= 32) return conflict("Pinned plan invalid or node budget exceeded");
      const originalTail = compiled.plan.agentSpecs.at(-1);
      if (originalTail?.nodeId !== input.stepId || !originalTail.approval) return conflict("Only an undispatched approval tail may be revised");
      const plan = current?.plan ?? compiled.plan;
      const parentStepId = plan.agentSpecs.at(-1)!.nodeId;
      if (plan.agentSpecs.some(spec => spec.nodeId === input.nodeId)) return conflict("Node id already exists in the pinned graph");
      // No step may start after the approval gate; this includes skipped steps
      // and the new tail. The approval step itself is intentionally unstarted.
      const dispatched = this.#database.prepare(
        "SELECT 1 FROM workflow_runtime_events WHERE run_id = ? AND step_id = ? LIMIT 1",
      ).get(input.runId, input.stepId);
      const rogue = this.#database.prepare(
        "SELECT 1 FROM workflow_runtime_events WHERE run_id = ? AND step_id = ? LIMIT 1",
      ).get(input.runId, input.nodeId);
      if (dispatched || rogue) return conflict("Approval tail or proposed node already has ledger facts");
      const service = getWorkflowServiceByRef("persisted-evidence.verifier");
      if (!service || service.kind !== "persisted-evidence-verifier") return conflict("Runtime verifier unavailable");
      const revision = input.expectedRevision + 1;
      const next: WorkflowRuntimeExecutablePlan = {
        ...plan, agentSpecs: [...plan.agentSpecs, {
          nodeId: input.nodeId, serviceRef: service.serviceRef,
          order: plan.agentSpecs.length, dependsOn: [parentStepId],
          coeffects: [...service.coeffects], capabilityRequirements: [...service.capabilityRequirements], parameters: {},
        }],
      };
      const parsed = workflowRuntimeExecutablePlanSchema.parse(next);
      this.#database.prepare(
        `INSERT INTO workflow_runtime_plan_revisions
         (run_id, revision, base_definition_checksum, parent_step_id, appended_node_id, plan_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.runId, revision, runtimeBuiltinChecksum(base.definition), parentStepId, input.nodeId, JSON.stringify(parsed), new Date().toISOString());
      return this.getPlanRevision(input.runId)!;
    })();
  }

  /** H24 read projection: persisted facts survive host restart, but confer no dispatch authority. */
  getHandoff(input: HandoffIdentity): { readonly id: string; readonly instruction: string; readonly status: HandoffStatus; readonly createdAt: string } | undefined {
    const row = this.#database.prepare(
      "SELECT id, instruction, status, created_at FROM workflow_runtime_handoffs WHERE run_id = ? AND parent_step_id = ? AND child_step_id = ?",
    ).get(input.runId, input.parentStepId, input.childStepId) as HandoffRow | undefined;
    return row ? { id: row.id, instruction: row.instruction, status: row.status, createdAt: row.created_at } : undefined;
  }

  /**
   * Validate against the SAME run's saved, validated revision and execution
   * ledger. In particular, a caller cannot invent step ids, select an unrelated
   * child, or claim a handoff while the child has already begun work. Neither
   * this check nor the handoff row authorizes an agent or a provider invocation.
   */
  #handoffEligible(input: HandoffIdentity): boolean {
    const run = this.#database.prepare(
      "SELECT definition_id, revision_id, status, lifecycle_state FROM workflow_runtime_runs WHERE id = ?",
    ).get(input.runId) as Pick<RunRow, "definition_id" | "revision_id" | "status" | "lifecycle_state"> | undefined;
    if (!run || run.status !== "running" || run.lifecycle_state !== "running") return false;
    const revision = this.getRevision(run.revision_id);
    if (!revision || revision.definitionId !== run.definition_id || revision.status !== "validated") return false;
    // A stored revision must have pinned child revisions; never resolve a
    // mutable 'latest' while evaluating the ownership of an in-flight run.
    const compiled = compileWorkflowRuntimeDefinition(revision.definition, (definitionId, revisionId) => {
      if (!revisionId) return undefined;
      const child = this.getRevision(revisionId);
      return child && child.definitionId === definitionId && child.status === "validated"
        ? { definition: child.definition, revisionId: child.revisionId } : undefined;
    });
    const child = compiled.plan?.agentSpecs.find((spec) => spec.nodeId === input.childStepId);
    if (!compiled.ok || !compiled.plan?.agentSpecs.some((spec) => spec.nodeId === input.parentStepId)
      || !child?.dependsOn?.includes(input.parentStepId)) return false;
    const parentFact = this.#database.prepare(
      `SELECT event_type, attempt_number, seq FROM workflow_runtime_events
       WHERE run_id = ? AND step_id = ? AND event_type IN ('step_started', 'step_succeeded', 'step_failed')
       ORDER BY seq DESC LIMIT 1`,
    ).get(input.runId, input.parentStepId) as { event_type: string; attempt_number: number | null; seq: number } | undefined;
    if (parentFact?.event_type !== "step_succeeded" || parentFact.attempt_number === null) return false;
    const parentStarted = this.#database.prepare(
      `SELECT attempt_number FROM workflow_runtime_events
       WHERE run_id = ? AND step_id = ? AND event_type = 'step_started' AND seq < ?
       ORDER BY seq DESC LIMIT 1`,
    ).get(input.runId, input.parentStepId, parentFact.seq) as { attempt_number: number | null } | undefined;
    if (!parentStarted || parentStarted.attempt_number !== parentFact.attempt_number) return false;
    const childFact = this.#database.prepare(
      "SELECT 1 FROM workflow_runtime_events WHERE run_id = ? AND step_id = ? LIMIT 1",
    ).get(input.runId, input.childStepId);
    return childFact === undefined;
  }

  /**
   * Persist one bounded public intent, not a free-form prompt. The immediate
   * SQLite transaction fences eligibility, competing handoffs and replay with
   * the terminal run/step writes. This records a fact, never dispatches work.
   */
  delegateHandoff(input: HandoffIdentity & { readonly instruction: string }): { readonly id: string; readonly status: HandoffStatus } {
    if (input.parentStepId === input.childStepId || !HANDOFF_INTENTS.has(input.instruction)) {
      throw new WorkflowRuntimeStoreError("Handoff is outside the bounded contract", "WORKFLOW_HANDOFF_INVALID", 400);
    }
    try {
      return this.#database.transaction(() => {
        if (!this.#handoffEligible(input)) {
          throw new WorkflowRuntimeStoreError("Handoff steps are not eligible in this active run", "WORKFLOW_HANDOFF_NOT_ELIGIBLE", 409);
        }
        const existing = this.getHandoff(input);
        if (existing) {
          if (existing.instruction !== input.instruction) {
            throw new WorkflowRuntimeStoreError("Handoff identity does not match the stored instruction", "WORKFLOW_HANDOFF_CONFLICT", 409);
          }
          return { id: existing.id, status: existing.status };
        }
        const id = `handoff_${randomUUID()}`;
        this.#database.prepare(
          `INSERT INTO workflow_runtime_handoffs (id, run_id, parent_step_id, child_step_id, instruction, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'delegated', ?)`,
        ).run(id, input.runId, input.parentStepId, input.childStepId, input.instruction, new Date().toISOString());
        return { id, status: "delegated" as const };
      }).immediate();
    } catch (error) {
      if (error instanceof WorkflowRuntimeStoreError) throw error;
      throw new WorkflowRuntimeStoreError("Failed to persist workflow handoff", "WORKFLOW_RUNTIME_STORE_UNAVAILABLE", 503);
    }
  }

  /** One-shot state transition; a started child or terminal run cannot accept. */
  acceptHandoff(input: HandoffIdentity): boolean {
    try {
      return this.#database.transaction(() => {
        if (!this.getHandoff(input) || !this.#handoffEligible(input)) return false;
        const updated = this.#database.prepare(
          `UPDATE workflow_runtime_handoffs SET status = 'accepted'
           WHERE run_id = ? AND parent_step_id = ? AND child_step_id = ? AND status = 'delegated'`,
        ).run(input.runId, input.parentStepId, input.childStepId);
        return updated.changes === 1;
      }).immediate();
    } catch (error) {
      if (error instanceof WorkflowRuntimeStoreError) throw error;
      throw new WorkflowRuntimeStoreError("Failed to accept workflow handoff", "WORKFLOW_RUNTIME_STORE_UNAVAILABLE", 503);
    }
  }

  /** The single undecided, unexpired gate for a waiting run, if one exists. */
  pendingApprovalStepId(runId: string, now = new Date().toISOString()): string | undefined {
    const row = this.#database.prepare(
      `SELECT step_id FROM workflow_runtime_approvals
       WHERE run_id = ? AND decision IS NULL AND expires_at >= ?
       ORDER BY requested_at ASC LIMIT 1`,
    ).get(runId, now) as { step_id: string } | undefined;
    return row?.step_id;
  }

  getApproval(runId: string, stepId: string): { readonly decision: "approved" | "rejected" | null; readonly expiresAt: string } | undefined {
    const row = this.#database
      .prepare("SELECT decision, expires_at FROM workflow_runtime_approvals WHERE run_id = ? AND step_id = ?")
      .get(runId, stepId) as { decision: string | null; expires_at: string } | undefined;
    if (!row) return undefined;
    const decision = row.decision === "approved" || row.decision === "rejected" ? row.decision : null;
    return { decision, expiresAt: row.expires_at };
  }

  /**
   * Publish the approval request and waiting state in ONE transaction, before
   * returning control to the executor. A crash between these writes must not
   * leave a 'running' row which startup incorrectly classifies as interrupted.
   */
  requestApprovalAndWait(input: { readonly runId: string; readonly stepId: string; readonly expiresAt: string }): void {
    this.#database.transaction(() => {
      const run = this.#database.prepare(
        "SELECT status, lifecycle_state FROM workflow_runtime_runs WHERE id = ?",
      ).get(input.runId) as { status: string; lifecycle_state: string | null } | undefined;
      if (!run || run.status !== "running" || (run.lifecycle_state !== null && run.lifecycle_state !== "running" && run.lifecycle_state !== "awaiting_input")) {
        throw new WorkflowRuntimeStoreError("Run is not eligible for an approval wait", "WORKFLOW_APPROVAL_RUN_NOT_WAITABLE", 409);
      }
      // One run can wait on ONE step only. Otherwise a second gate could
      // replace the displayed wait while leaving the first approval valid.
      // Repeating the identical request is idempotent; it cannot extend TTL.
      const waiting = this.#database.prepare(
        "SELECT step_id, expires_at FROM workflow_runtime_approvals WHERE run_id = ?",
      ).all(input.runId) as { step_id: string; expires_at: string }[];
      if (waiting.some((request) => request.step_id !== input.stepId) ||
          (run.lifecycle_state === "awaiting_input" && !waiting.some((request) => request.step_id === input.stepId))) {
        throw new WorkflowRuntimeStoreError("Run is already awaiting a different approval", "WORKFLOW_APPROVAL_CONFLICT", 409);
      }
      this.requestApproval(input);
      const updated = this.#database.prepare(
        `UPDATE workflow_runtime_runs
         SET lifecycle_state = 'awaiting_input', error = ?
         WHERE id = ? AND status = 'running' AND (lifecycle_state IS NULL OR lifecycle_state = 'running' OR lifecycle_state = 'awaiting_input')`,
      ).run("waiting for approval of step " + input.stepId, input.runId);
      if (updated.changes !== 1) {
        throw new WorkflowRuntimeStoreError("Approval wait could not be persisted", "WORKFLOW_APPROVAL_WAIT_UNAVAILABLE", 503);
      }
    })();
  }
}
