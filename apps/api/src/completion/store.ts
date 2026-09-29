/**
 * CompletionOutboxStore — durable SQLite outbox for terminal completion
 * notices (H15), mirroring the publish outbox's persistence discipline.
 *
 * Contract:
 *   - Idempotent enqueue: rows are keyed by the notice's wire idempotency key
 *     (UNIQUE). Enqueueing a notice whose key already exists — in ANY state —
 *     is a no-op, so repeated terminal triggers never create a second
 *     notification.
 *   - Persistence over delivery: a row is marked `delivered` only after the
 *     destination acknowledged it. Receiver errors (any non-2xx) and network
 *     failures leave the row in place (`pending`/`retrying`) — a destination
 *     outage never loses the task. Only after the bounded attempt budget is
 *     exhausted does the row move to `failed`, with the sanitized last error
 *     persisted for local visibility.
 *   - Backoff: `next_attempt_at` gates re-eligibility; a failed attempt
 *     schedules the next one with exponential backoff. Rows are never
 *     re-sent before their backoff elapsed.
 *   - No lease: delivery is event-driven and single-flight in this process
 *     (see CompletionSink) — there is no background poller competing for
 *     rows. Crash mid-delivery leaves the row claimable again; the wire-level
 *     Idempotency-Key lets the receiver deduplicate that at-least-once
 *     redelivery.
 *   - Redaction-before-persistence: the payload is sanitized through the
 *     shared structured sanitizer before the row is built, and re-validated
 *     against the strict notice schema on the read path (defense in depth).
 * Boundary: trusted host side, exactly like the publish outbox store. This is
 * DATA — it grants no capability and authorizes nothing.
 */

import type { ConsistencyDatabase } from "../db/connection";
import { sanitizeStructuredData } from "../security/redact";
import {
  completionNoticeSchema,
  newCompletionOutboxId,
  type CompletionNotice,
} from "./notices";

export const COMPLETION_OUTBOX_STATUSES = [
  "pending",
  "retrying",
  "delivered",
  "failed",
] as const;
export type CompletionOutboxStatus = (typeof COMPLETION_OUTBOX_STATUSES)[number];

export type CompletionOutboxItem = {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly target: string;
  readonly status: CompletionOutboxStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
  readonly payload: CompletionNotice;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CompletionOutboxStats = {
  readonly pending: number;
  readonly retrying: number;
  readonly delivered: number;
  readonly failed: number;
};

interface OutboxRow {
  id: string;
  idempotency_key: string;
  run_id: string;
  attempt_number: number;
  target: string;
  status: CompletionOutboxStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

export class CompletionOutboxStore {
  readonly #database: ConsistencyDatabase;

  constructor(database: ConsistencyDatabase) {
    this.#database = database;
  }

  /**
   * Persist a notice for delivery. Returns `enqueued: false` when a row with
   * the same idempotency key already exists (duplicate terminal trigger) —
   * the existing row and its delivery state are left untouched.
   */
  enqueue(notice: CompletionNotice): { enqueued: boolean } {
    const now = new Date().toISOString();
    // Redaction-before-persistence: the payload is sanitized again at the
    // store boundary, mirroring the execution-event ledger's doctrine.
    const payloadJson = JSON.stringify(sanitizeStructuredData(notice));
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO completion_outbox
           (id, idempotency_key, run_id, attempt_number, target, status,
            attempt_count, next_attempt_at, last_error, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, ?)`
      )
      .run(
        newCompletionOutboxId(),
        notice.idempotencyKey,
        notice.runId,
        notice.attempt,
        "supervisor",
        payloadJson,
        now,
        now,
      );
    return { enqueued: result.changes > 0 };
  }

  /**
   * Rows due for a delivery attempt: `pending` rows and `retrying` rows whose
   * backoff elapsed, oldest first. Bounded by `limit` (one drain batch).
   */
  claimDue(nowIso: string, limit: number): CompletionOutboxItem[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM completion_outbox
         WHERE status IN ('pending', 'retrying')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC, id ASC
         LIMIT ?`
      )
      .all(nowIso, limit) as OutboxRow[];
    const items: CompletionOutboxItem[] = [];
    for (const row of rows) {
      const item = this.#itemFromRow(row);
      if (item !== undefined) items.push(item);
    }
    return items;
  }

  markDelivered(id: string): boolean {
    const result = this.#database
      .prepare(
        `UPDATE completion_outbox
         SET status = 'delivered', next_attempt_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'retrying')`
      )
      .run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  /** Schedule the next attempt after `backoffMs` (bounded backoff gate). */
  markRetry(id: string, error: string, backoffMs: number, nowIso: string): boolean {
    const nextAttemptAt = new Date(Date.parse(nowIso) + backoffMs).toISOString();
    const result = this.#database
      .prepare(
        `UPDATE completion_outbox
         SET status = 'retrying', attempt_count = attempt_count + 1,
             next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'retrying')`
      )
      .run(nextAttemptAt, error, nowIso, id);
    return result.changes > 0;
  }

  /** Terminal local failure: attempts exhausted; the sanitized error stays visible. */
  markFailed(id: string, error: string): boolean {
    const result = this.#database
      .prepare(
        `UPDATE completion_outbox
         SET status = 'failed', attempt_count = attempt_count + 1,
             next_attempt_at = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'retrying')`
      )
      .run(error, new Date().toISOString(), id);
    return result.changes > 0;
  }

  /** Bounded status projection (health/capability reporting). */
  stats(): CompletionOutboxStats {
    const rows = this.#database
      .prepare(`SELECT status, COUNT(*) AS n FROM completion_outbox GROUP BY status`)
      .all() as Array<{ status: CompletionOutboxStatus; n: number }>;
    const counts: Record<CompletionOutboxStatus, number> = {
      pending: 0,
      retrying: 0,
      delivered: 0,
      failed: 0,
    };
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  /** Recently failed rows (local visibility of undeliverable notices). */
  listFailures(limit: number): CompletionOutboxItem[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM completion_outbox
         WHERE status = 'failed'
         ORDER BY updated_at DESC, id ASC
         LIMIT ?`
      )
      .all(limit) as OutboxRow[];
    const items: CompletionOutboxItem[] = [];
    for (const row of rows) {
      const item = this.#itemFromRow(row);
      if (item !== undefined) items.push(item);
    }
    return items;
  }

  /** Parse + re-validate a persisted row; a row that no longer round-trips is
   * failed locally (visible, never re-claimed) and reported as `undefined`. */
  #itemFromRow(row: OutboxRow): CompletionOutboxItem | undefined {
    let payload: CompletionNotice;
    try {
      payload = completionNoticeSchema.parse(JSON.parse(row.payload_json));
    } catch {
      // A row whose payload no longer round-trips must not loop forever in
      // the drain — fail it locally with an honest, secret-free reason.
      this.#database
        .prepare(
          `UPDATE completion_outbox
           SET status = 'failed', next_attempt_at = NULL, last_error = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'retrying')`
        )
        .run("completion notice payload failed validation", new Date().toISOString(), row.id);
      return undefined;
    }
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      runId: row.run_id,
      attemptNumber: row.attempt_number,
      target: row.target,
      status: row.status,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      payload,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
