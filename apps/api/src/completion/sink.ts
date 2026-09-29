/**
 * CompletionSink — the narrow terminal completion channel (H15).
 *
 * Delivery model (deliberately NOT a poller):
 *   - There is NO background loop, NO interval timer, and NO self-rescheduling
 *     retry timer. Delivery attempts happen only when something triggers a
 *     drain: a newly recorded terminal notice, a one-shot startup recovery
 *     replay, or an explicit `flushOnce()` call.
 *   - A destination must be EXPLICITLY configured; the sink is only
 *     constructed when one exists. Unconfigured ⇒ the feature is silently
 *     off (no outbox writes, no sends, no timers) and honestly reported as
 *     disabled in the health capability payload.
 *   - Bounded backoff: a failed attempt schedules the row's next eligibility
 *     with `min(base·2^attempt, cap)`; after `maxAttempts` the row settles in
 *     `failed` with a sanitized error — visible locally (stats + listFailures),
 *     never retried again. Receiver errors never delete the task: until the
 *     attempt budget is exhausted the row stays persistent and deliverable.
 *   - Recovery replay: rows left pending/retrying by a previous process (or by
 *     an outage) are delivered once connectivity and the next trigger coincide.
 *     At-least-once redelivery is made safe by the wire-level
 *     `Idempotency-Key` header, so a receiver that already accepted the notice
 *     can deduplicate.
 *   - Secrets: the Authorization credential (when configured) exists only
 *     inside the outbound request; delivery errors are sanitized through the
 *     shared redact helpers (with the token split out) before persistence.
 * Boundary: trusted host side. This module is a notification sink — it grants
 * no capability and authorizes nothing.
 */

import { sanitizePublicError } from "../security/redact";
import {
  buildCompletionNotice,
  type CompletionNotice,
  type CompletionTerminalInput,
} from "./notices";
import type { CompletionOutboxItem, CompletionOutboxStats, CompletionOutboxStore } from "./store";

export const COMPLETION_MAX_ATTEMPTS = 5;
export const COMPLETION_BACKOFF_BASE_MS = 1_000;
export const COMPLETION_BACKOFF_CAP_MS = 60_000;
export const COMPLETION_TIMEOUT_MS = 10_000;
export const COMPLETION_BATCH_SIZE = 20;

export type CompletionDeliveryRequest = {
  readonly url: string;
  /** Pre-serialized, redacted notice payload. */
  readonly payload: string;
  readonly idempotencyKey: string;
  readonly token?: string;
  readonly signal: AbortSignal;
};

export type CompletionDeliveryOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status?: number; readonly error: string };

export type CompletionDeliverer = (request: CompletionDeliveryRequest) => Promise<CompletionDeliveryOutcome>;

/** Default HTTP deliverer (Node 22 global fetch). The response body is never
 * echoed into the outcome — only the status code — so receiver reflections
 * cannot smuggle content into the outbox. */
export const defaultCompletionDeliverer: CompletionDeliverer = async (request) => {
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": request.idempotencyKey,
        ...(request.token === undefined ? {} : { Authorization: `Bearer ${request.token}` }),
      },
      body: request.payload,
      signal: request.signal,
    });
    if (response.ok) return { ok: true };
    return { ok: false, status: response.status, error: `completion destination responded with HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export type CompletionFlushSummary = {
  readonly attempted: number;
  readonly delivered: number;
  readonly retried: number;
  readonly failed: number;
  /** True when this call joined an already-running drain. */
  readonly joined: boolean;
};

const EMPTY_SUMMARY: CompletionFlushSummary = {
  attempted: 0,
  delivered: 0,
  retried: 0,
  failed: 0,
  joined: false,
};

/** Mutable drain accumulator; CompletionFlushSummary is the readonly surface. */
type DrainSummary = {
  attempted: number;
  delivered: number;
  retried: number;
  failed: number;
};

export type CompletionSinkOptions = {
  readonly store: CompletionOutboxStore;
  /** Explicitly configured supervision destination (never defaulted). */
  readonly destination: { readonly url: string; readonly token?: string };
  readonly deliver?: CompletionDeliverer;
  readonly maxAttempts?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  readonly timeoutMs?: number;
  readonly batchSize?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, item: CompletionOutboxItem | undefined) => void;
};

export class CompletionSink {
  readonly #store: CompletionOutboxStore;
  readonly #destination: { url: string; token?: string };
  readonly #deliver: CompletionDeliverer;
  readonly #maxAttempts: number;
  readonly #backoffBaseMs: number;
  readonly #backoffCapMs: number;
  readonly #timeoutMs: number;
  readonly #batchSize: number;
  readonly #now: () => Date;
  readonly #onError: (error: unknown, item: CompletionOutboxItem | undefined) => void;

  #inFlight?: Promise<CompletionFlushSummary>;
  #stopped = false;

  constructor(options: CompletionSinkOptions) {
    this.#store = options.store;
    this.#destination = options.destination;
    this.#deliver = options.deliver ?? defaultCompletionDeliverer;
    this.#maxAttempts = options.maxAttempts ?? COMPLETION_MAX_ATTEMPTS;
    this.#backoffBaseMs = options.backoffBaseMs ?? COMPLETION_BACKOFF_BASE_MS;
    this.#backoffCapMs = options.backoffCapMs ?? COMPLETION_BACKOFF_CAP_MS;
    this.#timeoutMs = options.timeoutMs ?? COMPLETION_TIMEOUT_MS;
    this.#batchSize = options.batchSize ?? COMPLETION_BATCH_SIZE;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => {});
    if (this.#maxAttempts < 1) throw new Error("maxAttempts must be at least 1");
  }

  /**
   * Record a run terminal transition and trigger a delivery drain for the
   * newly enqueued notice. NEVER throws and NEVER blocks the run's
   * finalization path: persistence failures are reported through onError and
   * the durable run record is unaffected. Duplicate terminal triggers are
   * deduplicated by the outbox's idempotency key — they do not enqueue a
   * second notice and do not accelerate pending backoffs.
   */
  recordTerminal(input: CompletionTerminalInput): { enqueued: boolean } {
    try {
      const notice = buildCompletionNotice(input, { now: this.#now().toISOString() });
      const result = this.#store.enqueue(notice);
      if (result.enqueued && !this.#stopped) {
        // Event-driven delivery — fire-and-forget so run finalization never
        // waits on the network. The drain is single-flight and error-contained.
        void this.flushOnce().catch((error) => this.#onError(error, undefined));
      }
      return result;
    } catch (error) {
      try {
        this.#onError(error, undefined);
      } catch {
        // Error reporting must never create a second failure.
      }
      return { enqueued: false };
    }
  }

  /**
   * One bounded drain of due outbox rows. Concurrent callers join the
   * in-flight drain instead of starting a second one. This is the ONLY
   * delivery trigger — call it from a completion event, a one-shot startup
   * recovery, or an operator action; never from a timer.
   */
  flushOnce(): Promise<CompletionFlushSummary> {
    if (this.#stopped) return Promise.resolve({ ...EMPTY_SUMMARY });
    if (this.#inFlight) {
      // Join the in-flight drain, then re-check ONCE: a row enqueued after the
      // running drain's final claim would otherwise sit until the next
      // trigger. Each joiner causes at most one extra (usually empty) pass —
      // no timers, no loops.
      return this.#inFlight.then((summary) => {
        if (this.#stopped) return summary;
        return this.flushOnce().then((followUp) => ({
          attempted: summary.attempted + followUp.attempted,
          delivered: summary.delivered + followUp.delivered,
          retried: summary.retried + followUp.retried,
          failed: summary.failed + followUp.failed,
          joined: true,
        }));
      });
    }
    const drain = this.#drain().finally(() => {
      if (this.#inFlight === drain) this.#inFlight = undefined;
    });
    this.#inFlight = drain;
    return drain;
  }

  /**
   * Stop accepting new drains and settle the in-flight one. Rows left
   * undelivered stay persistent and are replayed by the next trigger (e.g.
   * the next process's startup recovery).
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    try {
      await this.#inFlight;
    } catch {
      // The drain never rejects (per-item errors are contained), but a stop
      // must never propagate a drain failure into shutdown.
    }
  }

  status(): { enabled: true; outbox: CompletionOutboxStats } {
    return { enabled: true, outbox: this.#store.stats() };
  }

  /** Bounded exponential backoff: base·2^attempt, capped. Deterministic. */
  #backoffMs(attemptCount: number): number {
    return Math.min(this.#backoffBaseMs * 2 ** attemptCount, this.#backoffCapMs);
  }

  /** Delivery errors are sanitized with the outbound credential split out, so
   * a misconfigured URL or provider-style message cannot leak it locally. */
  #sanitizeDeliveryError(raw: string): string {
    const token = this.#destination.token;
    const withoutToken = token === undefined ? raw : raw.split(token).join("[REDACTED]");
    return sanitizePublicError(withoutToken).slice(0, 500) || "completion delivery failed";
  }

  async #drain(): Promise<CompletionFlushSummary> {
    // Mutable accumulator; the public summary type is readonly.
    const summary = { attempted: 0, delivered: 0, retried: 0, failed: 0 };
    // Terminates: every processed row leaves `due` (delivered/failed) or
    // schedules a FUTURE next_attempt_at (retrying), so claimDue eventually
    // returns nothing. Rows enqueued during the drain are picked up by the
    // same loop; nothing is lost and nothing spins.
    while (true) {
      const due = this.#store.claimDue(this.#now().toISOString(), this.#batchSize);
      if (due.length === 0) break;
      for (const item of due) {
        summary.attempted += 1;
        await this.#attemptDelivery(item, summary);
      }
    }
    return { ...summary, joined: false };
  }

  async #attemptDelivery(item: CompletionOutboxItem, summary: DrainSummary): Promise<void> {
    try {
      const outcome = await this.#deliver({
        url: this.#destination.url,
        payload: JSON.stringify(item.payload),
        idempotencyKey: item.idempotencyKey,
        ...(this.#destination.token === undefined ? {} : { token: this.#destination.token }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (outcome.ok) {
        this.#store.markDelivered(item.id);
        summary.delivered += 1;
        return;
      }
      const errorMessage = this.#sanitizeDeliveryError(outcome.error);
      if (item.attemptCount + 1 >= this.#maxAttempts) {
        // Attempt budget exhausted: settle as locally visible failure. The
        // task is not silently dropped — the row, its run id, and the
        // sanitized error persist for operators.
        this.#store.markFailed(item.id, errorMessage);
        summary.failed += 1;
        return;
      }
      this.#store.markRetry(item.id, errorMessage, this.#backoffMs(item.attemptCount), this.#now().toISOString());
      summary.retried += 1;
    } catch (error) {
      // One broken item must never break the drain (or the run that
      // triggered it). The row stays claimable; the error is reported.
      try {
        this.#onError(error, item);
      } catch {
        // Error reporting must never create a second failure.
      }
    }
  }
}

export type { CompletionNotice };
