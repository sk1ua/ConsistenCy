/**
 * WorkflowRuntimeEventStore — append-only SQLite execution-event ledger for
 * workflow-runtime runs (H11).
 *
 * Contract (H11):
 *   - append-only: events are never updated or deleted; `seq` is a per-run
 *     monotonic counter enforced by UNIQUE(run_id, seq) (migration 0025);
 *   - transactional coupling: when an event is recorded together with a run
 *     state mutation (insertRun / updateRunTerminal), both happen in ONE
 *     transaction — a failed event write rolls the run row back to its
 *     previous state, and a failed run mutation leaves no orphan event;
 *   - redaction-before-persistence: payloads and error strings pass the shared
 *     sanitizers (security/redact) BEFORE a row is built, so suspected
 *     token/key material never reaches the database;
 *   - schema reuse: every persisted row validates against the shared
 *     executionLifecycleEventSchema (packages/schema/src/runtime.ts) on the
 *     write path and again on the read path, so the ledger always round-trips;
 *   - restart-safe reads: listEvents(runId) reads the durable SQLite rows in
 *     seq order — the fact source for downstream projections (H12) and
 *     recovery (H14). Startup running→failed semantics are NOT touched here.
 * Boundary: trusted host side, exactly like WorkflowRuntimeStore. This ledger
 * is DATA — it grants no capability and authorizes nothing.
 */

import { randomUUID } from "node:crypto";
import {
  executionLifecycleEventSchema,
  executionLifecycleStateSchema,
  isTerminalReason,
  projectRunTerminal,
  terminalReasonSchema,
  type ExecutionLifecycleState,
  type TerminalReason,
} from "@consistency/schema";
import type { ConsistencyDatabase } from "../db/connection";
import { sanitizeStructuredData } from "../security/redact";
import { WorkflowRuntimeStoreError } from "./store";

/** Emitted lifecycle facts. Run-level types are recorded transactionally with
 * the corresponding run-state mutation; step-level types are best-effort
 * observations emitted by the executor. */
export const WORKFLOW_RUNTIME_EVENT_TYPES = [
  "run_started",
  "run_succeeded",
  "run_failed",
  "step_started",
  "step_succeeded",
  "step_failed",
] as const;
export type WorkflowRuntimeEventType = (typeof WORKFLOW_RUNTIME_EVENT_TYPES)[number];

/**
 * Reserved payload key carrying the EXPLICIT lifecycle triple of a run-level
 * terminal fact (Wave 3 / R3). The events table has no lifecycle columns, so
 * the authoritative values the run row was written with ride inside the
 * (append-only) payload and are projected back out on read — never re-derived
 * from a coarse status. Reserved keys are stripped from the public payload
 * projection, exactly like `error` is projected onto the event's error field.
 */
const LIFECYCLE_PAYLOAD_KEY = "__workflowLifecycle";

/**
 * Lifecycle projection per event type — the DETERMINISTIC DEFAULT for events
 * that do not carry an explicit terminal triple. Run-level terminals are
 * written from the shared `projectRunTerminal` mapping (the single source used
 * by the run row), so this table can never disagree with the run row.
 */
const EVENT_LIFECYCLE: Readonly<
  Record<WorkflowRuntimeEventType, {
    readonly fromState?: ExecutionLifecycleState;
    readonly toState: ExecutionLifecycleState;
    readonly terminalReason?: TerminalReason;
  }>
> = (() => {
  const succeeded = projectRunTerminal({ lifecycleState: "succeeded" });
  const failed = projectRunTerminal({ lifecycleState: "failed" });
  return {
    run_started: { toState: "running" },
    run_succeeded: { fromState: "running", toState: succeeded.lifecycleState, terminalReason: succeeded.terminalReason },
    run_failed: { fromState: "running", toState: failed.lifecycleState, terminalReason: failed.terminalReason },
    step_started: { toState: "running" },
    step_succeeded: { fromState: "running", toState: "succeeded" },
    step_failed: { fromState: "running", toState: "failed" },
  };
})();

export interface WorkflowRuntimeEventInput {
  readonly eventType: WorkflowRuntimeEventType;
  readonly runId: string;
  /** Correlation id shared by every event of one run (the persisted run id —
   * stable across restarts, so projections can regroup events after a crash). */
  readonly correlationId: string;
  readonly stepId?: string;
  readonly attemptNumber?: number;
  readonly error?: string;
  readonly payload?: Record<string, unknown>;
  /**
   * Wave 3 / R3: the AUTHORITATIVE lifecycle triple of a run-level terminal
   * fact — the exact values the coupled run row was written with. Absent ⇒ the
   * deterministic per-event-type default above applies (step facts, legacy
   * callers). A degraded/cancelled/interrupted run therefore reads back with
   * its real state and reason instead of a hardcoded failed/fatal_error.
   */
  readonly fromState?: ExecutionLifecycleState;
  readonly toState?: ExecutionLifecycleState;
  readonly terminalReason?: TerminalReason;
}

export interface PersistedWorkflowRuntimeEvent {
  readonly eventId: string;
  readonly seq: number;
  readonly eventType: WorkflowRuntimeEventType;
  readonly runId: string;
  readonly correlationId: string;
  readonly stepId?: string;
  readonly attemptNumber?: number;
  readonly fromState?: ExecutionLifecycleState;
  readonly toState: ExecutionLifecycleState;
  readonly terminalReason?: TerminalReason;
  readonly timestamp: string;
  readonly error?: string;
  readonly payload: Record<string, unknown>;
}

interface EventRow {
  id: string;
  run_id: string;
  correlation_id: string;
  step_id: string | null;
  attempt_number: number | null;
  event_type: WorkflowRuntimeEventType;
  seq: number;
  payload_json: string;
  created_at: string;
}

/** Typed store error mirroring WorkflowRuntimeStoreError's shape. */
export class WorkflowRuntimeEventStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 500,
  ) {
    super(message);
    this.name = "WorkflowRuntimeEventStoreError";
  }
}

export class WorkflowRuntimeEventStore {
  readonly #database: ConsistencyDatabase;

  constructor(database: ConsistencyDatabase) {
    this.#database = database;
  }

  /**
   * Append one event. When `options.applyRunUpdate` is given (a run-state
   * mutation such as insertRun / updateRunTerminal), it runs FIRST inside the
   * SAME transaction: if the event append then fails, the run mutation rolls
   * back (the existing run row is never left half-updated); if the run
   * mutation itself fails (e.g. unknown run), no event is appended.
   */
  recordEvent(
    input: WorkflowRuntimeEventInput,
    options: { readonly applyRunUpdate?: () => void } = {},
  ): PersistedWorkflowRuntimeEvent {
    const write = this.#database.transaction((): PersistedWorkflowRuntimeEvent => {
      options.applyRunUpdate?.();
      return this.#append(input);
    });
    try {
      return write.immediate();
    } catch (error) {
      if (error instanceof WorkflowRuntimeEventStoreError || error instanceof WorkflowRuntimeStoreError) {
        // Both typed domain errors keep their semantics (the run update may
        // legitimately fail e.g. WORKFLOW_RUN_NOT_FOUND — nothing was written).
        throw error;
      }
      // Deliberately unannotated: store errors never leak DB internals.
      throw new WorkflowRuntimeEventStoreError(
        "Failed to persist workflow runtime execution event",
        "WORKFLOW_RUNTIME_EVENT_STORE_UNAVAILABLE",
        503,
      );
    }
  }

  /**
   * Ordered read of one run's events (seq ASC). Reads the durable rows —
   * valid after process restart — and re-validates each against the shared
   * schema, re-sanitizing payloads on the way out (read-path defense in
   * depth, mirroring the audit store's event projection).
   */
  listEvents(runId: string): PersistedWorkflowRuntimeEvent[] {
    const rows = this.#database
      .prepare("SELECT * FROM workflow_runtime_events WHERE run_id = ? ORDER BY seq ASC")
      .all(runId) as EventRow[];
    return rows.map((row) => this.#eventFromRow(row));
  }

  /** Number of persisted events for a run (bounded ledger introspection). */
  countEvents(runId: string): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS n FROM workflow_runtime_events WHERE run_id = ?")
      .get(runId) as { n: number };
    return row.n;
  }

  // ---------------------------------------------------------------------------

  #append(input: WorkflowRuntimeEventInput): PersistedWorkflowRuntimeEvent {
    const lifecycle = EVENT_LIFECYCLE[input.eventType];
    if (!lifecycle) {
      throw new WorkflowRuntimeEventStoreError(
        "Unknown workflow runtime event type",
        "WORKFLOW_RUNTIME_EVENT_TYPE_INVALID",
        400,
      );
    }
    // seq is allocated inside the caller's transaction: UNIQUE(run_id, seq)
    // makes the append order the read order, monotonically per run.
    const seqRow = this.#database
      .prepare("SELECT coalesce(max(seq), 0) + 1 AS seq FROM workflow_runtime_events WHERE run_id = ?")
      .get(input.runId) as { seq: number };
    const timestamp = new Date().toISOString();
    // Wave 3 / R3: an explicit lifecycle triple (run-level terminal facts
    // written from the shared projectRunTerminal mapping) is authoritative and
    // persisted with the row; step facts and legacy callers keep the
    // deterministic per-event-type default.
    const explicitLifecycle = input.toState !== undefined
      ? {
          ...(input.fromState === undefined ? {} : { fromState: input.fromState }),
          toState: input.toState,
          ...(input.terminalReason === undefined ? {} : { terminalReason: input.terminalReason }),
        }
      : undefined;
    const fromState = explicitLifecycle?.fromState ?? lifecycle.fromState;
    const toState = explicitLifecycle?.toState ?? lifecycle.toState;
    const terminalReason = explicitLifecycle?.terminalReason ?? lifecycle.terminalReason;
    // Redact BEFORE persistence: sensitive keys, credential-shaped strings,
    // bearer tokens, and absolute paths are sanitized by the shared helpers.
    // The redacted terminal error rides in payload_json under the reserved
    // `error` key (the table has no separate error column) and is projected
    // back onto the shared schema's error field on read; the lifecycle triple
    // rides under the reserved lifecycle key the same way.
    const payload = sanitizeStructuredData({
      ...(input.payload ?? {}),
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(explicitLifecycle === undefined ? {} : { [LIFECYCLE_PAYLOAD_KEY]: explicitLifecycle }),
    });
    const error = typeof payload.error === "string" ? payload.error : undefined;
    const event = executionLifecycleEventSchema.parse({
      eventId: "wfevt_" + randomUUID(),
      correlationId: input.correlationId,
      runId: input.runId,
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
      ...(input.attemptNumber === undefined ? {} : { attemptNumber: input.attemptNumber }),
      ...(fromState === undefined ? {} : { fromState }),
      toState,
      ...(terminalReason === undefined ? {} : { terminalReason }),
      timestamp,
      ...(error === undefined ? {} : { error }),
      payload,
    });
    this.#database
      .prepare(
        `INSERT INTO workflow_runtime_events
           (id, run_id, correlation_id, step_id, attempt_number, event_type, seq, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.runId,
        event.correlationId,
        event.stepId ?? null,
        event.attemptNumber ?? null,
        input.eventType,
        seqRow.seq,
        JSON.stringify(event.payload),
        event.timestamp,
      );
    return {
      eventId: event.eventId,
      seq: seqRow.seq,
      eventType: input.eventType,
      runId: event.runId,
      correlationId: event.correlationId,
      ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
      ...(event.attemptNumber === undefined ? {} : { attemptNumber: event.attemptNumber }),
      ...(fromState === undefined ? {} : { fromState }),
      toState,
      ...(terminalReason === undefined ? {} : { terminalReason }),
      timestamp: event.timestamp,
      ...(event.error === undefined ? {} : { error: event.error }),
      payload: projectPayload(event.payload as Record<string, unknown>),
    };
  }

  #eventFromRow(row: EventRow): PersistedWorkflowRuntimeEvent {
    const lifecycle = EVENT_LIFECYCLE[row.event_type];
    if (!lifecycle) {
      throw new WorkflowRuntimeEventStoreError(
        "Stored workflow runtime event has an unknown event type",
        "WORKFLOW_RUNTIME_DATA_CORRUPT",
        500,
      );
    }
    const payload = sanitizeStructuredData(parseJsonObject(row.payload_json));
    const error = typeof payload.error === "string" ? payload.error : undefined;
    // Wave 3 / R3: the persisted authoritative triple wins over the
    // per-event-type default; a malformed stored triple fails closed back to
    // the default instead of surfacing an invalid lifecycle value.
    const stored = readStoredLifecycle(payload);
    const fromState = stored?.fromState ?? lifecycle.fromState;
    const toState = stored?.toState ?? lifecycle.toState;
    const terminalReason = stored?.terminalReason ?? lifecycle.terminalReason;
    const event = executionLifecycleEventSchema.parse({
      eventId: row.id,
      correlationId: row.correlation_id,
      runId: row.run_id,
      ...(row.step_id === null ? {} : { stepId: row.step_id }),
      ...(row.attempt_number === null ? {} : { attemptNumber: row.attempt_number }),
      ...(fromState === undefined ? {} : { fromState }),
      toState,
      ...(terminalReason === undefined ? {} : { terminalReason }),
      timestamp: row.created_at,
      ...(error === undefined ? {} : { error }),
      payload,
    });
    return {
      eventId: event.eventId,
      seq: row.seq,
      eventType: row.event_type,
      runId: event.runId,
      correlationId: event.correlationId,
      ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
      ...(event.attemptNumber === undefined ? {} : { attemptNumber: event.attemptNumber }),
      ...(fromState === undefined ? {} : { fromState }),
      toState,
      ...(terminalReason === undefined ? {} : { terminalReason }),
      timestamp: event.timestamp,
      ...(event.error === undefined ? {} : { error: event.error }),
      payload: projectPayload(event.payload as Record<string, unknown>),
    };
  }
}

/** Public payload projection: reserved lifecycle key removed (it is surfaced
 * as first-class event fields, never duplicated inside `payload`). */
function projectPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!(LIFECYCLE_PAYLOAD_KEY in payload)) return payload;
  const { [LIFECYCLE_PAYLOAD_KEY]: _reserved, ...rest } = payload;
  return rest;
}

/** Validated read of the persisted lifecycle triple, or undefined when absent/corrupt. */
function readStoredLifecycle(
  payload: Record<string, unknown>,
): { fromState?: ExecutionLifecycleState; toState: ExecutionLifecycleState; terminalReason?: TerminalReason } | undefined {
  const raw = payload[LIFECYCLE_PAYLOAD_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as { fromState?: unknown; toState?: unknown; terminalReason?: unknown };
  const toState = executionLifecycleStateSchema.safeParse(candidate.toState);
  if (!toState.success) return undefined;
  const fromState = candidate.fromState === undefined ? undefined : executionLifecycleStateSchema.safeParse(candidate.fromState);
  const terminalReason = typeof candidate.terminalReason === "string" && isTerminalReason(candidate.terminalReason)
    ? terminalReasonSchema.parse(candidate.terminalReason)
    : undefined;
  return {
    ...(fromState?.success === true ? { fromState: fromState.data } : {}),
    toState: toState.data,
    ...(terminalReason === undefined ? {} : { terminalReason }),
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
