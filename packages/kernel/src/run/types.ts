/**
 * Run — one concrete execution instance of a Job.
 *
 * The Run is a generic Kernel-tier concept. It deliberately carries NO
 * ReviewJob / workload fields; workloads map onto Runs later. A Run owns
 * budget policies and an optional deadline, and its state gates Scheduler
 * admission for all of its Agents.
 */

/** Branded, serializable Run identifier. */
export type RunId = string & { readonly __brand: "RunId" };

/** Cast a plain string to a RunId after validating it is non-empty. */
export function asRunId(raw: string): RunId {
  if (!raw || raw.trim() === "") {
    throw new TypeError("RunId must be non-empty");
  }
  return raw as RunId;
}

/**
 * Run lifecycle states. Terminal states are SUCCEEDED, FAILED, CANCELLED.
 */
export type RunState =
  | "CREATED"
  | "ACTIVE"
  | "SUSPENDED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export const RUN_STATES: readonly RunState[] = [
  "CREATED",
  "ACTIVE",
  "SUSPENDED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
];

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
];

/**
 * Kernel-internal Run record. The RunRegistry owns instances and REPLACES
 * them on every state transition; no mutable Run record ever leaks outside
 * the Kernel — callers receive frozen {@link RunSnapshot} copies.
 */
export interface Run {
  readonly id: RunId;
  state: RunState;
  readonly createdAt: number;
  /** Unix ms deadline. Scheduler admission denies work at `now >= deadline`. */
  readonly deadline?: number;
  /** Policy-level token budget for the whole Run (accounting stays in BudgetAccountant). */
  readonly tokenBudget?: number;
  /** Policy-level cost budget in micro-USD (accounting stays in BudgetAccountant). */
  readonly costBudgetUsdMicros?: bigint;
  /** Policy-level wall-time budget in ms. */
  readonly wallTimeBudgetMs?: number;
}

/** Immutable, frozen public view of a Run. */
export type RunSnapshot = Readonly<Run>;

export interface CreateRunRequest {
  readonly id: RunId;
  readonly deadline?: number;
  readonly tokenBudget?: number;
  readonly costBudgetUsdMicros?: bigint;
  readonly wallTimeBudgetMs?: number;
}

/** Explicit Run state-transition table. Terminal states have no exits. */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  CREATED: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["SUSPENDED", "SUCCEEDED", "FAILED", "CANCELLED"],
  SUSPENDED: ["ACTIVE", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

/** Typed error raised when an invalid Run state transition is attempted. */
export class RunStateTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;

  constructor(from: RunState, to: RunState) {
    super(`Invalid Run state transition: ${from} -> ${to}`);
    this.name = "RunStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/**
 * Return the successor state, or throw a typed error. Never silently mutates
 * an invalid transition.
 */
export function transitionRun(from: RunState, to: RunState): RunState {
  if (!canTransitionRun(from, to)) {
    throw new RunStateTransitionError(from, to);
  }
  return to;
}
