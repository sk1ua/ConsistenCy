/**
 * CommitCoordinator — the Kernel's sole entry point for irreversible external
 * mutations (`github.publish`, `repo.write`).
 *
 * It sits UPSTREAM of the persistent Outbox:
 *
 *   1. Validate the action is commit-intent routable (github.publish/repo.write).
 *   2. Dedupe by `idempotencyKey` (in-memory, concurrency-safe).
 *   3. Authorise the caller through the CapabilityBroker (default-deny).
 *   4. Derive a SHA-256 `payloadHash` from the canonicalized trusted payload.
 *   5. Record an audit event (no handle, no payload body).
 *   6. Hand the capability-free, credential-free intent to the durable sink.
 *
 * Authorization happens at INTENT ACCEPTANCE. A later revocation does NOT
 * erase already-accepted intents — durability is the point. The coordinator
 * performs NO external mutation itself; the sink's terminal op is persistence
 * and the PublishWorker fetches credentials at execution time.
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { CapabilityBroker } from "../capability/broker.js";
import { CapabilityError } from "../capability/errors.js";
import type { AuditJournal } from "../audit/journal.js";
import { canonicalizeJson } from "../evidence/fingerprint.js";
import {
  CommitIntentRejectedError,
  CommitSinkError,
} from "./errors.js";
import type {
  CommitAcceptRequest,
  CommitIntent,
  CommitIntentId,
  CommitIntentSink,
  CommitReceipt,
} from "./types.js";
import { asCommitIntentId } from "./types.js";

const COMMIT_INTENT_ACTIONS = new Set(["github.publish", "repo.write"] as const);

export interface CommitCoordinatorOptions {
  readonly sink: CommitIntentSink;
  readonly clock?: () => number;
}

export class CommitCoordinator {
  readonly #broker: CapabilityBroker;
  readonly #journal: AuditJournal;
  readonly #sink: CommitIntentSink;
  readonly #clock: () => number;
  readonly #intents = new Map<CommitIntentId, CommitIntent>();
  /** idempotencyKey → in-flight acceptance (concurrency-safe dedupe). */
  readonly #inFlight = new Map<string, Promise<CommitReceipt>>();
  /** idempotencyKey → resolved receipt (repeat → status "duplicate"). */
  readonly #receipts = new Map<string, CommitReceipt>();

  constructor(
    broker: CapabilityBroker,
    journal: AuditJournal,
    options: CommitCoordinatorOptions,
  ) {
    this.#broker = broker;
    this.#journal = journal;
    this.#sink = options.sink;
    this.#clock = options.clock ?? Date.now;
  }

  /**
   * Accept a commit intent. Returns a receipt; on repeat submission of the same
   * `idempotencyKey`, returns the existing receipt (`status: "duplicate"`)
   * without re-invoking the sink.
   *
   * @throws {CommitIntentRejectedError} for a non-commit action.
   * @throws {CapabilityError} on authorisation DENY (no intent, no sink call).
   * @throws {CommitSinkError} when the durable sink fails (intent not accepted).
   */
  async accept(request: CommitAcceptRequest): Promise<CommitReceipt> {
    if (!COMMIT_INTENT_ACTIONS.has(request.action)) {
      throw new CommitIntentRejectedError(request.action);
    }

    // Already resolved → duplicate (never re-persist).
    const resolved = this.#receipts.get(request.idempotencyKey);
    if (resolved) {
      return { ...resolved, status: "duplicate" };
    }

    // In-flight → return the same acceptance promise (concurrent caller).
    const inFlight = this.#inFlight.get(request.idempotencyKey);
    if (inFlight) return inFlight;

    const promise = this.#acceptInternal(request);
    this.#inFlight.set(request.idempotencyKey, promise);
    try {
      const receipt = await promise;
      this.#receipts.set(request.idempotencyKey, receipt);
      return receipt;
    } catch (err) {
      // Allow retry after a failed acceptance.
      this.#inFlight.delete(request.idempotencyKey);
      throw err;
    }
  }

  async #acceptInternal(request: CommitAcceptRequest): Promise<CommitReceipt> {
    const now = this.#clock();
    const payloadHash = createHash("sha256")
      .update(canonicalizeJson(request.payload), "utf8")
      .digest("hex");

    // Authorise at intent acceptance. DENY → no intent, no sink call.
    let reservation: ReturnType<CapabilityBroker["authorise"]>;
    try {
      reservation = this.#broker.authorise({
        principal: request.principal,
        handle: request.handle,
        action: request.action,
        resource: request.resource,
      });
    } catch (err) {
      if (err instanceof CapabilityError) {
        this.#journal.record({
          type: "commit.intent_denied",
          timestamp: now,
          action: request.action,
          resourceKind: request.resource.kind,
          subject: request.principal.id,
          idempotencyKey: request.idempotencyKey,
          reason: err.reason,
        });
      }
      throw err;
    }

    const intent: CommitIntent = Object.freeze({
      id: asCommitIntentId(`commit_${randomUUID()}`),
      runId: request.runId,
      action: request.action,
      subject: request.principal.id,
      resource: Object.freeze({ ...request.resource }),
      idempotencyKey: request.idempotencyKey,
      payloadHash,
      createdAt: now,
    });

    // No budget is reserved for intent acceptance (no token accounting for an
    // external mutation); release defensively if the capability carried one.
    if (reservation) this.#broker.releaseTokens(reservation);

    try {
      const receipt = await this.#sink.persist(intent);
      this.#intents.set(intent.id, intent);
      this.#journal.record({
        type: "commit.intent_accepted",
        timestamp: now,
        intentId: intent.id,
        action: intent.action,
        resourceKind: intent.resource.kind,
        subject: intent.subject,
        idempotencyKey: intent.idempotencyKey,
        payloadHash: intent.payloadHash,
      });
      return receipt;
    } catch (err) {
      throw new CommitSinkError(err);
    }
  }

  /** @internal — test/diagnostic introspection of accepted intents. */
  listIntents(): readonly CommitIntent[] {
    return Array.from(this.#intents.values());
  }

  /** @internal — look up one accepted intent by id. */
  getIntent(id: CommitIntentId): CommitIntent | undefined {
    return this.#intents.get(id);
  }

  /** @internal — has this idempotency key already been accepted? */
  hasIdempotencyKey(key: string): boolean {
    return this.#receipts.has(key) || this.#inFlight.has(key);
  }
}
