/**
 * Budget types — resource accounting for Capability budgets.
 */

export interface CapabilityBudget {
  /** Maximum number of authorised calls. */
  readonly maxCalls?: number;
  /** Maximum LLM tokens (prompt + completion) across all calls. */
  readonly maxTokens?: number;
  /**
   * Maximum cost in micro-USD. Uses bigint to avoid floating-point errors.
   * 1 USD = 1_000_000 micros.
   */
  readonly maxCostUsdMicros?: bigint;
}

export interface BudgetState {
  readonly usedCalls: number;
  readonly usedTokens: number;
  readonly usedCostUsdMicros: bigint;
  /** How many calls are currently reserved (in-flight). */
  readonly reservedCalls: number;
  /** How many tokens are currently reserved (in-flight). */
  readonly reservedTokens: number;
}

export interface ReserveRequest {
  readonly calls: number;
  readonly tokens?: number;
  readonly costUsdMicros?: bigint;
}

export type ReserveResult =
  | { readonly ok: true; readonly reservationId: string }
  | { readonly ok: false; readonly reason: "calls" | "tokens" | "cost" };
