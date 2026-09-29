/**
 * AuditJournal — the interface for append-only event recording.
 *
 * Every component that needs to record an audit event depends on this
 * interface, not on a concrete implementation. This allows tests to inject an
 * in-memory journal and production to wire a SQLite / remote journal.
 */

import type {
  AuditEvent,
  CapabilityIssuedEvent,
  CapabilityRevokedEvent,
  CommitIntentAcceptedEvent,
  CommitIntentDeniedEvent,
  SyscallAuthorisedEvent,
} from "./types.js";

/**
 * An AuditEvent where the `id` field is optional (not yet assigned by the
 * journal). We use a discriminated union of partials rather than
 * `Omit<AuditEvent, "id">` to preserve TypeScript's narrowing on the `type`
 * discriminant.
 */
export type AuditEventInput =
  | (Omit<CapabilityIssuedEvent,    "id"> & { id?: string })
  | (Omit<CapabilityRevokedEvent,   "id"> & { id?: string })
  | (Omit<SyscallAuthorisedEvent,   "id"> & { id?: string })
  | (Omit<CommitIntentAcceptedEvent, "id"> & { id?: string })
  | (Omit<CommitIntentDeniedEvent,   "id"> & { id?: string });

export interface AuditJournal {
  /**
   * Append a new event to the journal. The `id` field may be omitted;
   * the journal implementation assigns one.
   */
  record(event: AuditEventInput): void;

  /**
   * Return all recorded events, in insertion order.
   *
   * Only available for in-process consumers (tests, introspection). Production
   * journal implementations backed by SQLite expose a query API instead.
   */
  entries(): readonly AuditEvent[];
}
