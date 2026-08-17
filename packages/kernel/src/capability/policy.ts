/**
 * Capability issuance policy.
 *
 * Two distinct concepts are tracked here — they are NOT the same:
 *
 *   SERVICE_RING      = the privilege ring of the **backing service** that
 *                       actually executes the syscall. The LLM Driver runs at
 *                       Ring 1; it holds provider credentials and raw network
 *                       access. An Agent never reaches the driver directly.
 *
 *   CAPABILITY_ISSUABLE_RING = the minimum ring a **principal** must operate at
 *                       to be issued a capability for this action. For mediated
 *                       syscalls (e.g. llm.invoke), the Agent stays Ring 3 but
 *                       the Kernel routes the call through the Ring 1 driver
 *                       without exposing the driver, API key, or socket.
 *
 * Example — llm.invoke:
 *   SERVICE_RING["llm.invoke"]            = 1  (LLM Driver is Ring 1)
 *   CAPABILITY_ISSUABLE_RING["llm.invoke"]= 3  (Agent CAN hold this capability)
 *
 *   The Agent gets:          capability(llm.invoke, budget=…)
 *   The Agent never gets:    OpenAI API key | RawLLMDriver | network socket
 *
 * NOTE: The Ring number describes a *logical trust domain*, not a physical
 * process boundary. Untrusted Ring 3 code also requires a separate execution
 * domain (child process / sandbox). Both dimensions must be tracked; Ring
 * alone is not sufficient to infer isolation strength.
 */

import type { Action } from "./types.js";
import type { PrincipalKind } from "../identity/principal.js";

/** Logical privilege ring. */
export type PrivilegeRing = 0 | 1 | 3;

/**
 * The ring of the **backing service** that performs the action.
 * Used by PR-2+ Cordis adapter to wire the service at the correct ring level.
 */
export const SERVICE_RING: Record<Action, PrivilegeRing> = {
  "repo.read":       3,
  "repo.search":     3,
  "repo.diff":       3,
  "repo.write":      0,
  "evidence.read":   3,
  "evidence.write":  3,
  "ast.query":       3,
  "llm.invoke":      1,   // LLM Driver is a Ring 1 protected service
  "github.publish":  0,   // via Outbox / CommitCoordinator, Ring 0
  "workspace.read":  3,
  "workspace.write": 3,
  "audit.read":      0,
};

/**
 * The minimum ring a **principal** must operate at to be issued a capability
 * for this action.
 *
 * For mediated syscalls, this is LOWER than SERVICE_RING: an Agent (Ring 3)
 * CAN hold `llm.invoke` because the Kernel mediates every call to the Ring 1
 * driver. The Agent never gains direct access to the driver.
 *
 * Ring 0 actions (repo.write, github.publish, audit.read) cannot be issued
 * to any principal outside the kernel itself — they are exclusively routed
 * through the Outbox / CommitCoordinator.
 */
export const CAPABILITY_ISSUABLE_RING: Record<Action, PrivilegeRing> = {
  "repo.read":       3,
  "repo.search":     3,
  "repo.diff":       3,
  "repo.write":      0,   // kernel only — via Outbox
  "evidence.read":   3,
  "evidence.write":  3,
  "ast.query":       3,
  "llm.invoke":      3,   // mediated: agent can hold, kernel routes to R1 driver
  "github.publish":  0,   // kernel only — via Outbox
  "workspace.read":  3,
  "workspace.write": 3,
  "audit.read":      0,   // kernel only
};

/**
 * Which PrincipalKind may hold a capability at a given issuable ring.
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

/**
 * @deprecated Use CAPABILITY_ISSUABLE_RING for issuance checks.
 * ACTION_RINGS is kept for backward compatibility during the PR-1.1 transition;
 * it will be removed in PR-2.
 */
export const ACTION_RINGS = CAPABILITY_ISSUABLE_RING;
