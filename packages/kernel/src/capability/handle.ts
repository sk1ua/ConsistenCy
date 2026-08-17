/**
 * CapabilityHandle generation.
 *
 * Handles are 256 bits of cryptographically secure random data, hex-encoded
 * with a `cap_` prefix. The prefix makes them easy to grep in logs or error
 * messages without revealing any internal structure.
 */

import { randomBytes } from "node:crypto";
import { asCapabilityHandle, type CapabilityHandle } from "./types.js";

/**
 * Generate a fresh, unpredictable CapabilityHandle.
 *
 * Uses `node:crypto.randomBytes` which is CSPRNG-backed on all supported
 * platforms. The returned handle can only be resolved by the Kernel that
 * issued it — external parties cannot derive the associated CapabilityRecord
 * from the handle alone.
 */
export function generateCapabilityHandle(): CapabilityHandle {
  const bytes = randomBytes(32); // 256 bits
  return asCapabilityHandle(`cap_${bytes.toString("hex")}`);
}

/**
 * Return a one-way fingerprint of a CapabilityHandle safe to record in an
 * AuditJournal.
 *
 * Rule: **never log the raw handle**. Use this truncated hex prefix instead.
 * A 12-character prefix (6 bytes = 48 bits) is enough to correlate entries in
 * audit logs while making handle reconstruction computationally infeasible.
 */
export function auditFingerprint(handle: CapabilityHandle): string {
  // Strip the `cap_` prefix, take the first 12 hex chars (6 bytes).
  return handle.slice(4, 16);
}
