/**
 * Capability types — the core of ConsistenCy's security model.
 *
 * A Capability is a structured, time-bounded, scope-limited authorisation
 * token issued by the Kernel. Agents never construct Capabilities themselves;
 * they receive opaque handles and present them at each syscall.
 */

import type { PrincipalId } from "../identity/principal.js";
import type { Resource, ResourceScope } from "../identity/resource.js";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Every action that can appear in a Capability.
 *
 * Naming convention: `<noun>.<verb>` where verb is the minimal permission
 * required. E.g. `repo.write` does NOT imply `repo.read`; callers must hold
 * both if they need both.
 */
export type Action =
  // Repository access
  | "repo.read"
  | "repo.search"
  | "repo.diff"
  | "repo.write"
  // Evidence store
  | "evidence.read"
  | "evidence.write"
  // AST / static analysis
  | "ast.query"
  // LLM invocation
  | "llm.invoke"
  // GitHub publication (Ring 0 only)
  | "github.publish"
  // Workspace (temporary files, revertible)
  | "workspace.read"
  | "workspace.write"
  // Audit log (Ring 0 read; write is always internal)
  | "audit.read";

// Budget constraints are canonical in budget/types.ts to avoid circular deps.
import type { CapabilityBudget } from "../budget/types.js";
export type { CapabilityBudget };


// ---------------------------------------------------------------------------
// Capability record (Kernel-internal)
// ---------------------------------------------------------------------------

/**
 * The full Capability record stored inside the Kernel.
 *
 * Agents never see this struct — they only ever hold an opaque
 * {@link CapabilityHandle}. The Kernel maps handle → CapabilityRecord at each
 * syscall.
 */
export interface CapabilityRecord {
  /** Internal unique ID (not the handle). */
  readonly id: string;

  /** The opaque handle that the Capability subject uses to reference this. */
  readonly handle: CapabilityHandle;

  /** Who this Capability was issued to. */
  readonly subject: PrincipalId;

  /** The action this Capability authorises. One Capability = one action. */
  readonly action: Action;

  /**
   * The resource on which the action is authorised.
   * The Kernel matches the caller's requested resource against this field
   * before allowing the operation.
   */
  readonly resource: Resource;

  /**
   * Additional constraints narrowing the resource (SHA pin, path globs, etc.)
   * See {@link ResourceScope}.
   */
  readonly scope?: ResourceScope;

  readonly issuedAt: number;
  readonly expiresAt?: number;

  readonly budget?: CapabilityBudget;

  /**
   * Whether this Capability has been explicitly revoked by the issuer.
   * Once true, it can never return to false.
   */
  revoked: boolean;
}

// ---------------------------------------------------------------------------
// Opaque handle (what Agents carry)
// ---------------------------------------------------------------------------

/**
 * An opaque, 256-bit capability handle.
 *
 * Agents only ever see this string. They cannot inspect or forge a
 * CapabilityRecord from it — the Kernel is the sole authority that resolves
 * handle → CapabilityRecord.
 *
 * Format: `cap_<hex-encoded 32 bytes>` (prefix makes handles
 * grep-able in logs without exposing structure).
 */
export type CapabilityHandle = string & { readonly __brand: "CapabilityHandle" };

/** Cast a raw string to a CapabilityHandle after validating its format. */
export function asCapabilityHandle(raw: string): CapabilityHandle {
  if (!/^cap_[0-9a-f]{64}$/i.test(raw)) {
    throw new TypeError(`Invalid CapabilityHandle format: ${raw}`);
  }
  return raw as CapabilityHandle;
}
