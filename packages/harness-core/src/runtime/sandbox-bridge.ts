/**
 * SandboxAgentBridge — generic Kernel SandboxLifecycleBus ↔ KernelScheduler bridge.
 *
 * Maps Kernel Sandbox process terminal events (`session.failed`,
 * `session.timed_out`, `session.cancelled`) onto KernelScheduler Agent state
 * transitions (`failAgent` / `cancelAgent`).
 *
 * This ensures that when a child-process sandbox crashes, times out, or is
 * cancelled, the associated Agent process ACB state in KernelScheduler
 * immediately converges to a truthful terminal state (`FAILED` or `CANCELLED`)
 * instead of remaining `RUNNING` or `WAIT_*` indefinitely.
 */

import {
  asAgentId,
  type KernelScheduler,
  type SandboxLifecycleBus,
  type SandboxLifecycleEvent,
} from "@consistency/kernel";

export class SandboxAgentBridge {
  readonly #unsubscribe: () => void;

  constructor(bus: SandboxLifecycleBus, scheduler: KernelScheduler) {
    this.#unsubscribe = bus.subscribe((event: SandboxLifecycleEvent) => {
      if (!event.agentId) return;
      const agentId = asAgentId(event.agentId);
      try {
        if (event.type === "session.failed" || event.type === "session.timed_out") {
          scheduler.failAgent(agentId);
        } else if (event.type === "session.cancelled") {
          scheduler.cancelAgent(agentId);
        }
      } catch {
        // Idempotent: if agent is already in a terminal state, ignore
      }
    });
  }

  /** Stop listening to sandbox lifecycle events. */
  dispose(): void {
    this.#unsubscribe();
  }
}
