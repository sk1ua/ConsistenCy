/**
 * MemoryJournal — in-process, synchronous AuditJournal implementation.
 *
 * Used in:
 *  - Tests (injected into CapabilityBroker)
 *  - Development / fast-path scenarios where persistence is not required
 *
 * This implementation is intentionally trivial. Production will replace it
 * with a SQLite-backed journal in PR-4.
 */

import { randomUUID } from "node:crypto";
import type { AuditJournal, AuditEventInput } from "./journal.js";
import type { AuditEvent } from "./types.js";

export class MemoryJournal implements AuditJournal {
  readonly #events: AuditEvent[] = [];

  record(event: AuditEventInput): void {
    this.#events.push({ id: randomUUID(), ...event } as AuditEvent);
  }

  entries(): readonly AuditEvent[] {
    return this.#events;
  }

  /** Convenience: return only events of a given type (for test assertions). */
  ofType<T extends AuditEvent["type"]>(
    type: T
  ): readonly Extract<AuditEvent, { type: T }>[] {
    return this.#events.filter(
      (e): e is Extract<AuditEvent, { type: T }> => e.type === type
    );
  }

  /** Clear all events. Useful between test cases. */
  clear(): void {
    this.#events.length = 0;
  }
}
