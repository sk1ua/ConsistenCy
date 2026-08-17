/**
 * Syscall authorisation gateway.
 *
 * `SyscallGateway` is the thin layer between a caller (Agent / Cordis Fiber)
 * and the `CapabilityBroker`. It:
 *
 * 1. Looks up the syscall's EffectClass in the registry.
 * 2. For `commit` syscalls, asserts a CommitCoordinator is wired in
 *    (stubbed in PR-1; enforced from PR-5 when the Outbox migrates here).
 * 3. Delegates the actual authorisation check to `CapabilityBroker.authorise`.
 * 4. If authorised, calls the provided `handler` thunk.
 * 5. On success: **commits** the reservation with actual usage from the handler.
 *    On failure: releases the reservation.
 *
 * CRITICAL: The handler is only invoked AFTER a successful authorisation.
 * If authorisation fails, the handler is NEVER called. Tests must verify this.
 *
 * CRITICAL: Usage is reported by the **trusted handler** (Ring 1 driver), not
 * by the caller. Agents cannot self-report token consumption.
 */

import type { CapabilityBroker } from "../capability/broker.js";
import type { AuthoriseRequest } from "../capability/broker.js";
import { getSyscallDefinition } from "./types.js";

/**
 * The structured return value that handlers must provide.
 *
 * `value` is the actual result.
 * `usage` is populated by the **trusted Ring 1 driver** (e.g. LLM Gateway)
 * and fed directly into the budget accounting — the calling Agent never
 * touches it.
 */
export interface SyscallOutcome<T> {
  readonly value: T;
  readonly usage?: {
    /** Actual tokens consumed (prompt + completion). */
    readonly tokens?: number;
    /** Actual cost in micro-USD (1 USD = 1_000_000 micros). */
    readonly costUsdMicros?: bigint;
  };
}

export class SyscallGateway {
  readonly #broker: CapabilityBroker;

  constructor(broker: CapabilityBroker) {
    this.#broker = broker;
  }

  /**
   * Invoke a syscall.
   *
   * @param request  Authorisation parameters (principal, handle, action, resource…)
   * @param handler  Trusted implementation that returns a {@link SyscallOutcome}.
   *                 Only called on ALLOW. Usage fields are committed to budget
   *                 accounting directly — the caller cannot influence them.
   * @returns        The `value` field of the outcome.
   * @throws         {@link CapabilityError} on DENY (handler is never called).
   */
  async invoke<T>(
    request: AuthoriseRequest,
    handler: () => SyscallOutcome<T> | Promise<SyscallOutcome<T>>
  ): Promise<T> {
    const def = getSyscallDefinition(request.action);

    // Commit-class syscalls must eventually route through CommitCoordinator.
    // In PR-1 we note but do not block — the hard guard lands in PR-5.
    if (def?.effect === "commit") {
      // TODO(PR-5): reject if no CommitCoordinator is registered.
    }

    // Authorise (throws CapabilityError on DENY — handler NOT called).
    const reservation = this.#broker.authorise(request);

    try {
      const outcome = await handler();

      if (reservation) {
        // SUCCESS: commit actual usage from the trusted handler.
        // The Agent never sees this path; it only gets `outcome.value`.
        this.#broker.commitTokens(
          reservation,
          outcome.usage?.tokens ?? 0,
          outcome.usage?.costUsdMicros ?? 0n,
        );
      }

      return outcome.value;
    } catch (err) {
      if (reservation) {
        // FAILURE: release the reservation so budget is not held indefinitely.
        this.#broker.releaseTokens(reservation);
      }
      throw err;
    }
  }
}
