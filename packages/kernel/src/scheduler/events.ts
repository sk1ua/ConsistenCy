/**
 * SchedulerEventBus — a tiny synchronous typed emitter (Cordis-free).
 *
 * No event-bus framework: a Set of listeners with idempotent unsubscribe is
 * enough. Payloads are immutable by construction (see scheduler/types.ts).
 */

import type { SchedulerEvent, SchedulerEventListener } from "./types.js";

export class SchedulerEventBus {
  readonly #listeners = new Set<SchedulerEventListener>();

  /** Subscribe. Returns an idempotent unsubscribe function. */
  subscribe(listener: SchedulerEventListener): () => void {
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }

  /** Deliver synchronously, in subscription order. */
  emit(event: SchedulerEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }
}
