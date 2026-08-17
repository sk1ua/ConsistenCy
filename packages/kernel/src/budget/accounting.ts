/**
 * BudgetAccountant — two-phase reserve/commit/release accounting.
 *
 * The two-phase model prevents over-consumption by reserving budget before an
 * operation begins and only committing the actual consumption afterwards.
 * Uncommitted reservations are released automatically when the caller signals
 * failure.
 *
 *   authorize  →  reserve(calls=1, tokens=estimatedN)   → reservationId
 *   invoke LLM
 *   on success →  commit(reservationId, actualTokens)
 *   on failure →  release(reservationId)
 *
 * The Scheduler (PR-2+) consumes BudgetAccountant state to make admission
 * decisions before dispatching Agents.
 */

import { randomUUID } from "node:crypto";
import type {
  CapabilityBudget,
  BudgetState,
  ReserveRequest,
  ReserveResult,
} from "./types.js";

interface Reservation {
  calls: number;
  tokens: number;
  costUsdMicros: bigint;
}

export class BudgetAccountant {
  readonly #limits: CapabilityBudget;
  #usedCalls = 0;
  #usedTokens = 0;
  #usedCostUsdMicros = 0n;
  readonly #reservations = new Map<string, Reservation>();

  constructor(limits: CapabilityBudget) {
    this.#limits = limits;
  }

  reserve(req: ReserveRequest): ReserveResult {
    const pendingCalls    = this.#pendingCalls();
    const pendingTokens   = this.#pendingTokens();
    const pendingCost     = this.#pendingCost();

    if (
      this.#limits.maxCalls !== undefined &&
      this.#usedCalls + pendingCalls + req.calls > this.#limits.maxCalls
    ) {
      return { ok: false, reason: "calls" };
    }

    const tokens = req.tokens ?? 0;
    if (
      this.#limits.maxTokens !== undefined &&
      this.#usedTokens + pendingTokens + tokens > this.#limits.maxTokens
    ) {
      return { ok: false, reason: "tokens" };
    }

    const cost = req.costUsdMicros ?? 0n;
    if (
      this.#limits.maxCostUsdMicros !== undefined &&
      this.#usedCostUsdMicros + pendingCost + cost > this.#limits.maxCostUsdMicros
    ) {
      return { ok: false, reason: "cost" };
    }

    const id = randomUUID();
    this.#reservations.set(id, { calls: req.calls, tokens, costUsdMicros: cost });
    return { ok: true, reservationId: id };
  }

  commit(reservationId: string, actualTokens: number, actualCostUsdMicros = 0n): void {
    const r = this.#reservations.get(reservationId);
    if (!r) return; // idempotent — already committed or released
    this.#reservations.delete(reservationId);
    this.#usedCalls    += r.calls;
    this.#usedTokens   += actualTokens;
    this.#usedCostUsdMicros += actualCostUsdMicros;
  }

  release(reservationId: string): void {
    this.#reservations.delete(reservationId);
  }

  state(): BudgetState {
    return {
      usedCalls: this.#usedCalls,
      usedTokens: this.#usedTokens,
      usedCostUsdMicros: this.#usedCostUsdMicros,
      reservedCalls: this.#pendingCalls(),
      reservedTokens: this.#pendingTokens(),
    };
  }

  #pendingCalls(): number {
    let n = 0;
    for (const r of this.#reservations.values()) n += r.calls;
    return n;
  }

  #pendingTokens(): number {
    let n = 0;
    for (const r of this.#reservations.values()) n += r.tokens;
    return n;
  }

  #pendingCost(): bigint {
    let n = 0n;
    for (const r of this.#reservations.values()) n += r.costUsdMicros;
    return n;
  }
}
