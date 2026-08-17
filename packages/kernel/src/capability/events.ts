/**
 * Capability change notifications — a minimal, Cordis-free subscription API.
 *
 * The CapabilityBroker emits lifecycle events (`capability.issued`,
 * `capability.revoked`) through this bus. Harnesses (e.g. the Cordis adapter
 * in `@consistency/harness-core`) subscribe to these events to keep *service
 * availability* in sync with Kernel capability state.
 *
 * SECURITY CONTRACT — a notification is NOT authorization:
 *
 * - Events never carry the raw capability handle (only the 12-hex-char
 *   `handleFingerprint`), and never expose the mutable CapabilityRecord.
 * - Subscribers may use events for lifecycle eligibility (e.g. "this Agent's
 *   ast facade should be unloaded"), but every actual operation is still
 *   authorized per-call by `CapabilityBroker.authorise()` via the
 *   `SyscallGateway`. A stale facade must always be denied by the Kernel,
 *   regardless of when (or whether) a listener reacts to these events.
 */

import type { Action } from "./types.js";
import type { PrincipalId } from "../identity/principal.js";
import type { ResourceKind } from "../identity/resource.js";

export type CapabilityChangeEvent =
  | CapabilityIssuedChangeEvent
  | CapabilityRevokedChangeEvent;

interface CapabilityChangeEventBase {
  /** Unix ms timestamp when the change happened. */
  readonly timestamp: number;
  /** The principal the capability belongs to. */
  readonly subject: PrincipalId;
  /** The action the capability covers. */
  readonly action: Action;
  /** The kind of resource the capability targets. */
  readonly resourceKind: ResourceKind;
  /**
   * 12-hex-char fingerprint of the capability handle. NEVER the raw handle.
   * Enough to correlate audit entries, not enough to reconstruct or use the
   * capability.
   */
  readonly handleFingerprint: string;
}

export interface CapabilityIssuedChangeEvent extends CapabilityChangeEventBase {
  readonly type: "capability.issued";
}

export interface CapabilityRevokedChangeEvent extends CapabilityChangeEventBase {
  readonly type: "capability.revoked";
}

export type CapabilityChangeListener = (event: CapabilityChangeEvent) => void;

/**
 * A tiny synchronous fan-out bus. The Kernel owns the bus instance and the
 * CapabilityBroker emits into it; harness layers subscribe.
 *
 * Deliberately minimal: no Cordis, no async delivery, no persistence. Any
 * richer lifecycle machinery belongs outside the Kernel.
 */
export class CapabilityChangeBus {
  readonly #listeners = new Set<CapabilityChangeListener>();

  /**
   * Subscribe to capability lifecycle events.
   *
   * @returns an idempotent unsubscribe function.
   */
  subscribe(listener: CapabilityChangeListener): () => void {
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }

  /**
   * Deliver an event to all current subscribers, synchronously, in
   * subscription order.
   *
   * @internal Kernel components (CapabilityBroker) call this; harness layers
   * should only subscribe. Note: a spoofed lifecycle event can only make a
   * harness unload a service — it can never authorize anything, because
   * authorization lives in the CapabilityBroker, not in these events.
   * (In-process this boundary is enforced by convention; hard process
   * isolation arrives with the execution-domain sandbox in a later PR.)
   */
  emit(event: CapabilityChangeEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }
}
