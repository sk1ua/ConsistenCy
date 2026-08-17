/**
 * Principal — who is making a syscall.
 *
 * A Principal is the smallest unit of identity in the Kernel. It does NOT
 * represent a role. Authorization is purely capability-based: a Principal can
 * perform an operation if and only if it presents a valid, non-revoked
 * Capability that covers the requested action, resource, scope, and budget.
 */

export type PrincipalKind =
  | "kernel"    // the kernel itself issuing internal operations
  | "service"   // a long-lived Ring 1 protected service
  | "agent"     // a short-lived Agent process (ACB-backed)
  | "plugin"    // an analyzer / tool plugin (built-in or 3rd-party)
  | "user";     // a human operator acting through the API / CLI

export interface Principal {
  /** Globally unique, stable identifier. Format: `kind:name:runId?` e.g. `agent:security:run_42` */
  readonly id: PrincipalId;
  readonly kind: PrincipalKind;
  /**
   * The Run this Principal belongs to. Undefined for long-lived services and
   * kernel-level principals. Capability scope enforcement always checks that
   * the Principal's runId matches the Capability's runId when both are set.
   */
  readonly runId?: string;
}

/** Branded string for type-safe Principal IDs. */
export type PrincipalId = string & { readonly __brand: "PrincipalId" };

/** Cast a plain string to a PrincipalId. Prefer `makePrincipalId`. */
export function asPrincipalId(id: string): PrincipalId {
  if (!id || id.trim() === "") throw new TypeError("PrincipalId must be non-empty");
  return id as PrincipalId;
}

/**
 * Construct a canonical PrincipalId.
 *
 * @example
 *   makePrincipalId("agent", "security", "run_42")
 *   // → "agent:security:run_42"
 */
export function makePrincipalId(
  kind: PrincipalKind,
  name: string,
  runId?: string
): PrincipalId {
  const base = `${kind}:${name}`;
  return asPrincipalId(runId ? `${base}:${runId}` : base);
}
