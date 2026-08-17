/**
 * Syscall authorisation gateway.
 *
 * `SyscallGateway` is the thin layer between a caller (Agent / Cordis Fiber)
 * and the `CapabilityBroker`. It:
 *
 * 1. Looks up the syscall's EffectClass in the registry.
 * 2. For `commit` syscalls, asserts that a CommitCoordinator is wired in
 *    (stubbed in PR-1; enforced from PR-5 when the Outbox migrates here).
 * 3. Delegates the actual authorisation check to `CapabilityBroker.authorise`.
 * 4. If authorised, calls the provided `handler` thunk.
 * 5. Returns the result and cleans up the budget reservation.
 *
 * IMPORTANT: The handler is only invoked AFTER a successful authorisation.
 * If authorisation fails, the handler is NEVER called. Tests must verify this.
 */

import type { CapabilityBroker } from "../capability/broker.js";
import type { AuthoriseRequest } from "../capability/broker.js";
import { getSyscallDefinition } from "./types.js";

export class SyscallGateway {
  readonly #broker: CapabilityBroker;

  constructor(broker: CapabilityBroker) {
    this.#broker = broker;
  }

  /**
   * Invoke a syscall.
   *
   * @param request  Authorisation parameters (principal, handle, action, resource…)
   * @param handler  The actual operation to execute. Only called on ALLOW.
   * @returns        The handler's return value.
   * @throws         {@link CapabilityError} on DENY (handler is never called).
   */
  async invoke<T>(
    request: AuthoriseRequest,
    handler: () => T | Promise<T>
  ): Promise<T> {
    const def = getSyscallDefinition(request.action);

    // Commit-class syscalls must eventually route through CommitCoordinator.
    // In PR-1 we warn but do not block — the hard guard lands in PR-5 when the
    // Outbox is migrated into the Kernel.
    if (def?.effect === "commit") {
      // TODO(PR-5): reject if no CommitCoordinator is registered.
    }

    // Authorise (throws CapabilityError on DENY).
    const reservation = this.#broker.authorise(request);

    try {
      const result = await handler();
      if (reservation) {
        // Caller should commit actual token count via commitTokens; we release
        // here as a safety net for callers that omit it.
        this.#broker.releaseTokens(reservation);
      }
      return result;
    } catch (err) {
      if (reservation) {
        this.#broker.releaseTokens(reservation);
      }
      throw err;
    }
  }
}
