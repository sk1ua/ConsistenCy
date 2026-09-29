/**
 * Commit intent model — the durable authorisation record that precedes any
 * irreversible external mutation (GitHub publish, repository write).
 *
 * A CommitIntent is NOT a capability and never carries one. It is the Kernel's
 * own record that, for a specific (principal, action, resource, idempotencyKey),
 * authorisation was granted at acceptance time and the mutation was handed to
 * the persistent Outbox.
 *
 * SECURITY: an intent carries no raw CapabilityHandle, no credential, and no
 * payload body — only a SHA-256 `payloadHash` of the canonicalized trusted
 * payload. The payload body itself is consumed by the app-level sink (Outbox
 * adapter) at execution time; the Kernel never persists or logs it.
 */

import type { Action, CapabilityHandle } from "../capability/types.js";
import type { Principal } from "../identity/principal.js";
import type { PrincipalId } from "../identity/principal.js";
import type { Resource } from "../identity/resource.js";
import type { JsonValue } from "../evidence/types.js";
import type { RunId } from "../run/types.js";

/** Actions that must be routed through the CommitCoordinator (dispatch= intent). */
export type CommitAction = Extract<Action, "github.publish" | "repo.write">;

/** Branded, serializable commit intent identifier. */
export type CommitIntentId = string & { readonly __brand: "CommitIntentId" };

export function asCommitIntentId(raw: string): CommitIntentId {
  if (!raw || raw.trim() === "") {
    throw new TypeError("CommitIntentId must be non-empty");
  }
  return raw as CommitIntentId;
}

/** Immutable, capability-free, credential-free durable intent record. */
export interface CommitIntent {
  readonly id: CommitIntentId;
  /** The Run that produced the intent (undefined for host-level commits). */
  readonly runId?: RunId;
  readonly action: CommitAction;
  /** The authorising principal (id only — never a handle or secret). */
  readonly subject: PrincipalId;
  /** Typed resource descriptor (e.g. GitHubPublishResource). */
  readonly resource: Resource;
  /** Deterministic dedupe key — repeated submission yields no new intent. */
  readonly idempotencyKey: string;
  /** SHA-256 hex over the canonicalized trusted payload (body never stored). */
  readonly payloadHash: string;
  readonly createdAt: number;
}

export type CommitReceiptStatus = "accepted" | "duplicate";

export interface CommitReceipt {
  readonly intentId: CommitIntentId;
  readonly idempotencyKey: string;
  readonly acceptedAt: number;
  readonly status: CommitReceiptStatus;
}

/**
 * Durable persistence boundary for accepted intents. Implemented by the app
 * host (apps/api) as the existing Outbox transaction. The sink's terminal op
 * is persistence; the Kernel performs no external mutation.
 */
export interface CommitIntentSink {
  /**
   * Persist one accepted intent durably. Must be idempotent per
   * `idempotencyKey`; the coordinator also dedupes in-memory so a repeated
   * submission returns `duplicate` without re-invoking the sink.
   */
  persist(intent: CommitIntent): Promise<CommitReceipt>;
}

/** What the trusted host passes to `CommitCoordinator.accept`. */
export interface CommitAcceptRequest {
  readonly principal: Principal;
  /** Opaque handle presented for authorisation (never recorded on the intent). */
  readonly handle: CapabilityHandle;
  readonly action: CommitAction;
  readonly resource: Resource;
  readonly idempotencyKey: string;
  /** Canonicalizable trusted payload; only its SHA-256 hash is persisted. */
  readonly payload: JsonValue;
  readonly runId?: RunId;
}

/** Coordinator self-introspection (tests + host diagnostics only). */
export interface CommitCoordinatorSnapshot {
  readonly intents: readonly CommitIntent[];
}
