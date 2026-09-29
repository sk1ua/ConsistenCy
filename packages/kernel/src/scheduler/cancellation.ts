/**
 * Cancellation causality (H13) — ONE causal identity per cancel request.
 *
 * Every cancel decision (user cancel, deadline expiry, run teardown, tree
 * propagation, shutdown) allocates a single `CancelCause`. The scheduler
 * stores it per Run/Agent, stamps it onto each cancelled ACB
 * (`cancelCauseId`), and hands the SAME instance to every descendant — so
 * observability can answer "what cancelled this subtree?" with one id, and a
 * late completion racing the cancel can be attributed deterministically.
 *
 * This module is DATA only: a cause authorizes nothing by itself.
 */

/** Monotonic allocation counter — ids are unique per process, stable, and
 * never derived from wall-clock time (deterministic tests, no collisions). */
let CANCEL_SEQUENCE = 0;

export type CancelReason =
  | "explicit"
  | "run_cancelled"
  | "parent_cancelled"
  | "deadline"
  | "shutdown";

/** The single causal identity of one cancel request. */
export interface CancelCause {
  readonly cancelId: string;
  readonly reason: CancelReason;
  readonly cancelledAt: number;
}

export interface CancelCauseOptions {
  /** Reuse an existing cause (propagation) instead of allocating a new one. */
  readonly cause?: CancelCause;
  /** Override the reason when propagating (e.g. run → agents). */
  readonly reason?: CancelReason;
}

/** Allocate (or reuse) the single causal identity for a cancel decision. */
export function createCancelCause(
  reason: CancelReason,
  clock: () => number,
  options: CancelCauseOptions = {},
): CancelCause {
  if (options.cause) {
    return options.reason === undefined || options.reason === options.cause.reason
      ? options.cause
      : { ...options.cause, reason: options.reason };
  }
  CANCEL_SEQUENCE += 1;
  return Object.freeze({
    cancelId: `cancel_${CANCEL_SEQUENCE.toString(16).padStart(8, "0")}`,
    reason,
    cancelledAt: clock(),
  });
}

/** Depth bound for tree propagation — cancellation walk is bounded by the
 * same invariant the AgentRegistry enforces on parent chains. */
export const MAX_CANCEL_TREE_DEPTH = 1000;
