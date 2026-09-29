/**
 * Capability errors.
 *
 * All errors are tagged with a `reason` field so that callers and the
 * AuditJournal can record the precise denial cause without inspecting error
 * messages (which are locale-sensitive and change over time).
 */

/** Every distinct way the Kernel can deny a syscall. */
export type DenyReason =
  | "unknown_capability"   // handle not found in the broker registry
  | "revoked"              // capability was explicitly revoked
  | "expired"              // expiresAt is in the past
  | "subject_mismatch"     // caller's principal ≠ capability's subject
  | "run_mismatch"         // caller's runId ≠ capability's runId
  | "action_mismatch"      // requested action ≠ capability's action
  | "resource_mismatch"    // requested resource does not match capability's resource
  | "scope_violation"      // requested path / SHA falls outside the scope
  | "budget_exhausted";    // token / call / cost budget is fully consumed

export class CapabilityError extends Error {
  readonly reason: DenyReason;

  constructor(reason: DenyReason, detail?: string) {
    super(detail ? `Capability denied [${reason}]: ${detail}` : `Capability denied [${reason}]`);
    this.name = "CapabilityError";
    this.reason = reason;
  }
}
