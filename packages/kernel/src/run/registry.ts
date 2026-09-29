/**
 * RunRegistry — Kernel-owned store of Run records.
 *
 * The registry validates creation requests, enforces the explicit Run state
 * machine ({@link transitionRun}), and only ever returns frozen snapshots.
 * Mutable Run records never leave the Kernel.
 *
 * OWNERSHIP CONTRACT: in a running system the KernelScheduler is the only
 * component that should transition Runs (it keeps Agent admission, the ready
 * queue, and events consistent). Direct registry use is intended for
 * composition and tests — a caller that transitions Runs directly owns the
 * resulting scheduler-consistency obligations.
 */

import {
  asRunId,
  transitionRun,
  type CreateRunRequest,
  type Run,
  type RunId,
  type RunSnapshot,
  type RunState,
} from "./types.js";

export class RunRegistry {
  readonly #runs = new Map<RunId, Run>();
  readonly #clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  /**
   * Create a Run in state CREATED.
   *
   * @throws {Error} on duplicate RunId.
   * @throws {RangeError} when `deadline` is not strictly in the future.
   */
  create(request: CreateRunRequest): RunSnapshot {
    if (this.#runs.has(request.id)) {
      throw new Error(`Run already exists: ${request.id}`);
    }
    const createdAt = this.#clock();
    if (request.deadline !== undefined && request.deadline <= createdAt) {
      throw new RangeError("Run deadline must be strictly in the future");
    }

    const run: Run = {
      id: request.id,
      state: "CREATED",
      createdAt,
      deadline: request.deadline,
      tokenBudget: request.tokenBudget,
      costBudgetUsdMicros: request.costBudgetUsdMicros,
      wallTimeBudgetMs: request.wallTimeBudgetMs,
    };
    this.#runs.set(run.id, run);
    return this.#snapshot(run);
  }

  get(id: RunId): RunSnapshot | undefined {
    const run = this.#runs.get(id);
    return run ? this.#snapshot(run) : undefined;
  }

  list(): readonly RunSnapshot[] {
    return [...this.#runs.values()].map((run) => this.#snapshot(run));
  }

  /**
   * Apply a validated Run state transition. Replaces the internal record and
   * returns the new snapshot. Invalid transitions throw
   * {@link RunStateTransitionError} — nothing is mutated silently.
   */
  transition(id: RunId, to: RunState): RunSnapshot {
    const run = this.#runs.get(id);
    if (!run) {
      throw new Error(`Unknown Run: ${id}`);
    }
    transitionRun(run.state, to);
    const next: Run = { ...run, state: to };
    this.#runs.set(id, next);
    return this.#snapshot(next);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  #snapshot(run: Run): RunSnapshot {
    return Object.freeze({ ...run });
  }
}

/** Convenience re-export so callers can construct validated ids. */
export { asRunId };
