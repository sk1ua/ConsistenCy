/**
 * Sandbox lifecycle notifications — a minimal, dependency-free subscription
 * API (mirrors CapabilityChangeBus).
 *
 * The SandboxManager emits one event per terminal session transition so
 * runtime layers (e.g. an agent bridge) can map sandbox outcomes onto Agent
 * ACB states. Events carry identity and outcome metadata ONLY — never raw
 * capability handles, credentials, RPC payloads, or child diagnostics.
 *
 * SECURITY CONTRACT — a notification is NOT authorization. Authorization for
 * every operation performed inside a sandbox lives in CapabilityBroker
 * per-call authorisation; these events only report process lifecycle.
 */

import type {
  SandboxSessionId,
  SandboxSessionState,
  SandboxTerminationReason,
} from "./types.js";
import type { PrincipalId } from "../identity/principal.js";
import type { AgentId } from "../agent/types.js";
import type { RunId } from "../run/types.js";

interface SandboxLifecycleEventBase {
  readonly timestamp: number;
  readonly sessionId: SandboxSessionId;
  readonly state: SandboxSessionState;
  readonly principalId: PrincipalId;
  readonly runId?: RunId;
  readonly agentId?: AgentId;
  readonly terminationReason?: SandboxTerminationReason;
  /** Stable error code when the session ended abnormally. */
  readonly errorCode?: string;
}

export type SandboxLifecycleEvent =
  | (SandboxLifecycleEventBase & { readonly type: "session.launched" })
  | (SandboxLifecycleEventBase & { readonly type: "session.succeeded" })
  | (SandboxLifecycleEventBase & { readonly type: "session.failed" })
  | (SandboxLifecycleEventBase & { readonly type: "session.timed_out" })
  | (SandboxLifecycleEventBase & { readonly type: "session.cancelled" });

export type SandboxLifecycleListener = (event: SandboxLifecycleEvent) => void;

/** Tiny synchronous fan-out bus. Kernel owns the instance; runtimes subscribe. */
export class SandboxLifecycleBus {
  readonly #listeners = new Set<SandboxLifecycleListener>();

  subscribe(listener: SandboxLifecycleListener): () => void {
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }

  /** @internal — the SandboxManager emits; runtimes only subscribe. */
  emit(event: SandboxLifecycleEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }
}
