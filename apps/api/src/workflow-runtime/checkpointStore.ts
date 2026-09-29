/**
 * WorkflowRuntimeCheckpointStore — durable checkpoint storage for H14
 * restart recovery (migration 0027).
 *
 * Division of truth:
 *   - the append-only H11 execution-event ledger (0025) stays the FACT source
 *     for step outcomes (started / succeeded / failed / sent-but-unresulted);
 *   - THIS store holds only REUSABLE step results: the payloads a successor
 *     run needs to reuse a completed READ-ONLY step without re-executing it
 *     (deterministic evidence inputs; fingerprint-keyed model verdicts).
 *     Result payloads are sanitized before persistence (same discipline as
 *     the event ledger) and re-sanitized on read (defense in depth).
 *
 * Idempotency: every write is an UPSERT keyed on (run_id) / (run_id, step_id)
 * — replayed step events never duplicate rows. A row is only reusable when it
 * fully validates (Wave 3 / R2): readable JSON, fingerprints that are all
 * non-empty strings, and a result payload satisfying the schema its node kind /
 * serviceRef / envelope promise. Anything else reads back `corrupt: true` with
 * the reason, and the recovery planner turns it into an explicit blocker
 * instead of silently reusing — or silently re-executing — bad data. A second
 * write of the same key with a DIFFERENT input identity is refused (409), never
 * absorbed.
 *
 * Boundary: trusted host side, exactly like WorkflowRuntimeStore. This store
 * is DATA — it grants no capability and authorizes nothing.
 */

import type { ConsistencyDatabase } from "../db/connection";
import { sanitizeStructuredData } from "../security/redact";
import type { WorkflowNodeKind } from "@consistency/schema";
import { validateCheckpointResult } from "./checkpointValidation";

/** Typed store error mirroring WorkflowRuntimeStoreError's shape. */
export class WorkflowRuntimeCheckpointStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 500,
  ) {
    super(message);
    this.name = "WorkflowRuntimeCheckpointStoreError";
  }
}

export interface CheckpointStepResult {
  readonly stepId: string;
  readonly serviceRef: string;
  readonly nodeKind: WorkflowNodeKind;
  /** H11 ledger seq of the terminal step event (traceability reference). */
  readonly eventSeq?: number;
  /**
   * Restart-stable references of the step's outputs: evidence FINGERPRINTS
   * for analyzer results, judged fingerprints for model verdicts (evidence
   * row ids are not restart-stable, so they are never used as references).
   */
  readonly evidenceFingerprints: readonly string[];
  /** Reusable result payload (evidence inputs / model verdict). */
  readonly result: unknown;
}

/** A read checkpoint step plus its validation verdict (Wave 3 / R2). */
export type ValidatedCheckpointStepResult = CheckpointStepResult & {
  /**
   * True when the row cannot be reused: unreadable JSON, fingerprints that are
   * not non-empty strings, or a result payload that fails the full schema the
   * row's node kind / serviceRef / envelope require.
   */
  readonly corrupt: boolean;
  /** Why the row is corrupt (surfaced in the recovery blocker message). */
  readonly invalidReason?: string;
};

export interface CheckpointHeader {
  readonly runId: string;
  readonly definitionId: string;
  readonly revisionId: string;
  readonly repository: string;
  readonly headSha: string;
  readonly snapshotFingerprint: string;
  readonly definitionChecksum: string;
  readonly recoveryState: "active" | "interrupted";
  readonly resumedFromRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CheckpointRecord {
  readonly header: CheckpointHeader;
  readonly steps: readonly ValidatedCheckpointStepResult[];
}

interface CheckpointRow {
  run_id: string;
  definition_id: string;
  revision_id: string;
  repository: string;
  head_sha: string;
  snapshot_fingerprint: string;
  definition_checksum: string;
  recovery_state: "active" | "interrupted";
  resumed_from_run_id: string | null;
  created_at: string;
  updated_at: string;
}

interface CheckpointStepRow {
  run_id: string;
  step_id: string;
  service_ref: string;
  node_kind: string;
  event_seq: number | null;
  evidence_ids_json: string;
  result_json: string;
  created_at: string;
  updated_at: string;
}

export interface RecordStepResultInput {
  readonly runId: string;
  readonly definitionId: string;
  readonly revisionId: string;
  readonly repository: string;
  readonly headSha: string;
  /** Stable fingerprint over repository + head + selected paths (H14). */
  readonly snapshotFingerprint: string;
  /** Checksum of the pinned definition revision (H14 reuse gate). */
  readonly definitionChecksum: string;
  /** Lineage: set on the SUCCESSOR run created by `continue`. */
  readonly resumedFromRunId?: string;
  readonly step: CheckpointStepResult;
}

export class WorkflowRuntimeCheckpointStore {
  readonly #database: ConsistencyDatabase;

  constructor(database: ConsistencyDatabase) {
    this.#database = database;
  }

  /**
   * Idempotently record one reusable step result. The first write for a run
   * creates the header (fingerprint + checksum captured from the live run);
   * later writes only upsert the step row and refresh `updated_at`.
   *
   * Wave 3 / R2 fail-closed gates, both BEFORE anything is persisted:
   *   - the result must satisfy the FULL schema its nodeKind / serviceRef /
   *     envelope promise (a shape-less payload is refused instead of being
   *     stored as a reuse licence);
   *   - the header identity (definition / revision / repository / headSha /
   *     snapshotFingerprint / definitionChecksum) must MATCH the existing row:
   *     two different input sets sharing one run id can never be silently
   *     absorbed, they are rejected with a typed conflict.
   */
  recordStepResult(input: RecordStepResultInput): void {
    const sanitizedResult = sanitizeStructuredData(input.step.result);
    const validation = validateCheckpointResult(input.step.nodeKind, input.step.serviceRef, sanitizedResult);
    if (!validation.ok) {
      throw new WorkflowRuntimeCheckpointStoreError(
        `Refused to persist an unusable checkpoint for step '${input.step.stepId}': ${validation.reason}`,
        "WORKFLOW_CHECKPOINT_RESULT_INVALID",
        409,
      );
    }
    const existingHeader = this.#database
      .prepare(
        `SELECT definition_id, revision_id, repository, head_sha, snapshot_fingerprint, definition_checksum
         FROM workflow_runtime_checkpoints WHERE run_id = ?`,
      )
      .get(input.runId) as Pick<CheckpointRow, "definition_id" | "revision_id" | "repository" | "head_sha" | "snapshot_fingerprint" | "definition_checksum"> | undefined;
    if (existingHeader) {
      // An empty string is the "not captured yet" sentinel (markInterrupted /
      // pre-H14 rows); a captured value is never allowed to change.
      const identity: readonly (readonly [string, string, string])[] = [
        ["definitionId", existingHeader.definition_id, input.definitionId],
        ["revisionId", existingHeader.revision_id, input.revisionId],
        ["repository", existingHeader.repository, input.repository],
        ["headSha", existingHeader.head_sha, input.headSha],
        ["snapshotFingerprint", existingHeader.snapshot_fingerprint, input.snapshotFingerprint],
        ["definitionChecksum", existingHeader.definition_checksum, input.definitionChecksum],
      ];
      for (const [field, stored, incoming] of identity) {
        if (stored !== "" && incoming !== "" && stored !== incoming) {
          throw new WorkflowRuntimeCheckpointStoreError(
            `Refused to reuse run '${input.runId}': checkpoint ${field} was captured as '${stored}' but the live run reports '${incoming}'`,
            "WORKFLOW_CHECKPOINT_IDENTITY_MISMATCH",
            409,
          );
        }
      }
    }
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO workflow_runtime_checkpoints
           (run_id, definition_id, revision_id, repository, head_sha, snapshot_fingerprint,
            definition_checksum, recovery_state, resumed_from_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           updated_at = excluded.updated_at,
           resumed_from_run_id = coalesce(workflow_runtime_checkpoints.resumed_from_run_id, excluded.resumed_from_run_id)`,
      )
      .run(
        input.runId,
        input.definitionId,
        input.revisionId,
        input.repository,
        input.headSha,
        input.snapshotFingerprint,
        input.definitionChecksum,
        input.resumedFromRunId ?? null,
        now,
        now,
      );
    this.#database
      .prepare(
        `INSERT INTO workflow_runtime_checkpoint_steps
           (run_id, step_id, service_ref, node_kind, event_seq, evidence_ids_json, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, step_id) DO UPDATE SET
           service_ref = excluded.service_ref,
           node_kind = excluded.node_kind,
           event_seq = excluded.event_seq,
           evidence_ids_json = excluded.evidence_ids_json,
           result_json = excluded.result_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.runId,
        input.step.stepId,
        input.step.serviceRef,
        input.step.nodeKind,
        input.step.eventSeq ?? null,
        JSON.stringify(sanitizeStructuredData([...input.step.evidenceFingerprints])),
        JSON.stringify(sanitizedResult),
        now,
        now,
      );
  }

  /**
   * Startup-scan marker: flip (or create) the run's recovery header to
   * `interrupted`. Never overwrites an already-captured fingerprint or
   * checksum — the scan runs after a crash and must not clobber facts the
   * live process recorded.
   */
  markInterrupted(input: {
    readonly runId: string;
    readonly definitionId: string;
    readonly revisionId: string;
    readonly repository: string;
    readonly headSha: string;
  }): void {
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO workflow_runtime_checkpoints
           (run_id, definition_id, revision_id, repository, head_sha, snapshot_fingerprint,
            definition_checksum, recovery_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', '', 'interrupted', ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           recovery_state = 'interrupted',
           updated_at = excluded.updated_at`,
      )
      .run(input.runId, input.definitionId, input.revisionId, input.repository, input.headSha, now, now);
  }

  /**
   * H14 lineage: eagerly create (or leave intact) the successor run's header
   * when a `continue` recovery launches it, so the resumed-from reference
   * exists even if the successor crashes before its first step result.
   */
  ensureHeader(input: {
    readonly runId: string;
    readonly definitionId: string;
    readonly revisionId: string;
    readonly repository: string;
    readonly headSha: string;
    readonly snapshotFingerprint: string;
    readonly definitionChecksum: string;
    readonly resumedFromRunId: string;
  }): void {
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO workflow_runtime_checkpoints
           (run_id, definition_id, revision_id, repository, head_sha, snapshot_fingerprint,
            definition_checksum, recovery_state, resumed_from_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           resumed_from_run_id = coalesce(workflow_runtime_checkpoints.resumed_from_run_id, excluded.resumed_from_run_id),
           updated_at = excluded.updated_at`,
      )
      .run(
        input.runId,
        input.definitionId,
        input.revisionId,
        input.repository,
        input.headSha,
        input.snapshotFingerprint,
        input.definitionChecksum,
        input.resumedFromRunId,
        now,
        now,
      );
  }

  /**
   * One-shot recovery claim. The guarded transition fences concurrent callers
   * BEFORE either may create a successor or dispatch a paid step. A crash after
   * claiming strands the action (fail closed); it must never reset the claim
   * and silently replay a possibly billed call.
   */
  claimInterruptedContinue(runId: string): boolean {
    const claimed = this.#database.prepare(
      `UPDATE workflow_runtime_checkpoints SET recovery_state = 'active', updated_at = ?
       WHERE run_id = ? AND recovery_state = 'interrupted'`,
    ).run(new Date().toISOString(), runId);
    return claimed.changes === 1;
  }

  /** Whole checkpoint record for a run, or undefined when none exists. */
  getCheckpoint(runId: string): CheckpointRecord | undefined {
    const header = this.#database
      .prepare("SELECT * FROM workflow_runtime_checkpoints WHERE run_id = ?")
      .get(runId) as CheckpointRow | undefined;
    if (!header) return undefined;
    const stepRows = this.#database
      .prepare("SELECT * FROM workflow_runtime_checkpoint_steps WHERE run_id = ? ORDER BY step_id ASC")
      .all(runId) as CheckpointStepRow[];
    return {
      header: this.#headerFromRow(header),
      steps: stepRows.map((row) => this.#stepFromRow(row)),
    };
  }

  /** One reusable step result, or undefined when absent. */
  getStepResult(runId: string, stepId: string): ValidatedCheckpointStepResult | undefined {
    const row = this.#database
      .prepare("SELECT * FROM workflow_runtime_checkpoint_steps WHERE run_id = ? AND step_id = ?")
      .get(runId, stepId) as CheckpointStepRow | undefined;
    return row ? this.#stepFromRow(row) : undefined;
  }

  #headerFromRow(row: CheckpointRow): CheckpointHeader {
    return {
      runId: row.run_id,
      definitionId: row.definition_id,
      revisionId: row.revision_id,
      repository: row.repository,
      headSha: row.head_sha,
      snapshotFingerprint: row.snapshot_fingerprint,
      definitionChecksum: row.definition_checksum,
      recoveryState: row.recovery_state,
      ...(row.resumed_from_run_id === null ? {} : { resumedFromRunId: row.resumed_from_run_id }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Wave 3 / R2 read projection: a row is reusable ONLY when every part of it
   * validates — fingerprints are all non-empty strings and the result payload
   * satisfies the full schema its node kind / serviceRef / envelope require.
   * Anything else comes back `corrupt: true` with the reason, so the recovery
   * planner turns it into an explicit blocker instead of letting a successor
   * silently re-execute (and re-bill) the step.
   */
  #stepFromRow(row: CheckpointStepRow): ValidatedCheckpointStepResult {
    let invalidReason: string | undefined;
    let evidenceFingerprints: unknown = [];
    try {
      evidenceFingerprints = sanitizeStructuredData(JSON.parse(row.evidence_ids_json));
      if (!Array.isArray(evidenceFingerprints)) {
        invalidReason = "evidence fingerprint column is not an array";
      } else {
        const malformed = (evidenceFingerprints as unknown[]).findIndex(
          (entry) => typeof entry !== "string" || entry === "",
        );
        if (malformed >= 0) {
          invalidReason = `evidence fingerprint #${malformed + 1} is not a non-empty string`;
        }
      }
    } catch {
      invalidReason = "evidence fingerprint column is not valid JSON";
    }
    let result: unknown;
    try {
      result = sanitizeStructuredData(JSON.parse(row.result_json));
    } catch {
      result = undefined;
      invalidReason ??= "result payload is not valid JSON";
    }
    if (invalidReason === undefined) {
      const validation = validateCheckpointResult(row.node_kind, row.service_ref, result);
      if (!validation.ok) invalidReason = validation.reason;
    }
    const corrupt = invalidReason !== undefined;
    return {
      stepId: row.step_id,
      serviceRef: row.service_ref,
      nodeKind: row.node_kind as WorkflowNodeKind,
      ...(row.event_seq === null ? {} : { eventSeq: row.event_seq }),
      evidenceFingerprints: corrupt ? [] : (evidenceFingerprints as string[]),
      result,
      corrupt,
      ...(invalidReason === undefined ? {} : { invalidReason }),
    };
  }
}
