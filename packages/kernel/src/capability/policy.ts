/**
 * Capability issuance policy.
 *
 * A Policy governs which (principal, action, resource, scope) combinations the
 * CapabilityBroker is permitted to issue. PR-1 provides a minimal, composable
 * policy interface; full ABAC / OPA integration comes in a later PR.
 */

import type { Action } from "./types.js";
import type { PrincipalKind } from "../identity/principal.js";

/**
 * Logical privilege ring.
 *
 * - **Ring 0 (Kernel)**: Kernel-internal operations only. Never exposed to
 *   Agent or Plugin principals.
 * - **Ring 1 (Protected)**: Long-lived system services. Accessible by
 *   `service` principals with explicit issuance.
 * - **Ring 3 (Userland)**: Agent and plugin principals. Broadest population;
 *   most constrained capabilities.
 *
 * NOTE: The Ring number describes a *logical trust domain*, not a physical
 * process boundary. Untrusted Ring 3 code also requires a separate execution
 * domain (child process / sandbox). Both dimensions must be tracked; Ring
 * alone is not sufficient to infer isolation strength.
 */
export type PrivilegeRing = 0 | 1 | 3;

/**
 * Declares which actions belong to which privilege ring.
 *
 * The Broker enforces: a principal of `kind K` can only be issued a Capability
 * if K is permitted for the action's ring.
 */
export const ACTION_RINGS: Record<Action, PrivilegeRing> = {
  "repo.read":       3,
  "repo.search":     3,
  "repo.diff":       3,
  "repo.write":      0,
  "evidence.read":   3,
  "evidence.write":  3,
  "ast.query":       3,
  "llm.invoke":      1,
  "github.publish":  0,
  "workspace.read":  3,
  "workspace.write": 1,
  "audit.read":      0,
};

/**
 * Which PrincipalKind can hold a Capability at a given Ring.
 *
 * Ring 0: only kernel itself
 * Ring 1: kernel + service
 * Ring 3: all kinds
 */
export const RING_ALLOWED_KINDS: Record<PrivilegeRing, readonly PrincipalKind[]> = {
  0: ["kernel"],
  1: ["kernel", "service"],
  3: ["kernel", "service", "agent", "plugin", "user"],
};
