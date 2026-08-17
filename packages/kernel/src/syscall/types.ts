/**
 * Syscall types — the typed interface through which Kernel services are invoked.
 *
 * Every operation that crosses a privilege boundary (Ring 3 → Ring 1 → Ring 0)
 * is modelled as a Syscall. A Syscall carries:
 *  - `action`: what operation is requested (matches a Capability's action)
 *  - `resource`: what the operation targets
 *  - `effect`: the EffectClass, declared statically at syscall definition time
 */

import type { Action } from "../capability/types.js";
import type { Resource, ResourceScope } from "../identity/resource.js";

// ---------------------------------------------------------------------------
// EffectClass
// ---------------------------------------------------------------------------

/**
 * Classification of a syscall's side-effect profile.
 *
 * Used by the Kernel to route syscalls through appropriate safeguards:
 *
 * - **pure**: No I/O, fully deterministic. AST queries, in-memory
 *   computations. Ring 3 may call freely.
 * - **read**: Reads external state but does not mutate it. Repository reads,
 *   snapshot access. Ring 3 may call freely.
 * - **revertible**: Creates local side effects that can be cleaned up by
 *   Cordis `effect()` dispose. Temporary workspace files, in-process state.
 *   Ring 1 or Ring 3 with explicit capability.
 * - **commit**: Irreversible external side effects. GitHub comments, pushes,
 *   emails, paid API calls. These MUST flow through the Kernel's
 *   Outbox / CommitCoordinator — they are never directly dispatched. Ring 0
 *   authorisation required.
 */
export type EffectClass = "pure" | "read" | "revertible" | "commit";

// ---------------------------------------------------------------------------
// DispatchPolicy
// ---------------------------------------------------------------------------

/**
 * Orthogonal to {@link EffectClass}: how a syscall must be *dispatched*.
 *
 * - **direct**: The trusted handler runs inline through `SyscallGateway.invoke`
 *   after authorisation. This covers every non-commit syscall AND `llm.invoke`
 *   (a commit-class call whose trusted Ring 1 driver executes inline).
 * - **intent**: The syscall must NOT be dispatched inline. It is routed through
 *   the {@link CommitCoordinator}, which authorises the caller, records a
 *   durable CommitIntent, and hands off to the persistent Outbox. This covers
 *   `github.publish` and `repo.write` — irreversible external mutations.
 *
 * `SyscallGateway.invoke` hard-DENIES direct dispatch of any `intent` action,
 * even for trusted in-process callers (handler invocation count = 0).
 */
export type DispatchPolicy = "direct" | "intent";

// ---------------------------------------------------------------------------
// SyscallDefinition
// ---------------------------------------------------------------------------

/**
 * Declares a syscall's action, effect class, and dispatch policy.
 *
 * This registry is used by the Kernel to refuse `commit` calls that have not
 * been routed through the CommitCoordinator, and to record correct effect
 * annotations in the AuditJournal.
 */
export interface SyscallDefinition {
  readonly action: Action;
  readonly effect: EffectClass;
  readonly dispatch: DispatchPolicy;
  /**
   * Human-readable description. Not shown to Agents; used in documentation
   * and audit log enrichment.
   */
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Canonical syscall registry
// ---------------------------------------------------------------------------

export const SYSCALL_DEFINITIONS: readonly SyscallDefinition[] = [
  // --- pure ---
  { action: "ast.query",       effect: "pure",       dispatch: "direct", description: "Query an AST parse tree" },
  // --- read ---
  { action: "repo.read",       effect: "read",       dispatch: "direct", description: "Read repository file content" },
  { action: "repo.search",     effect: "read",       dispatch: "direct", description: "Search repository file paths or symbols" },
  { action: "repo.diff",       effect: "read",       dispatch: "direct", description: "Compute diff between two SHAs" },
  { action: "evidence.read",   effect: "read",       dispatch: "direct", description: "Read evidence records for a Run" },
  { action: "workspace.read",  effect: "read",       dispatch: "direct", description: "Read files from the run workspace" },
  { action: "audit.read",      effect: "read",       dispatch: "direct", description: "Read audit journal entries (Ring 0)" },
  // --- revertible ---
  { action: "workspace.write", effect: "revertible", dispatch: "direct", description: "Write temporary files to the run workspace" },
  { action: "evidence.write", effect: "revertible", dispatch: "direct", description: "Store a new Evidence record (protected internal state — undoable, NOT an external commit)" },
  // --- commit: direct (llm.invoke executes inline via trusted Ring 1 driver) ---
  { action: "llm.invoke",      effect: "commit",     dispatch: "direct", description: "Issue a paid LLM inference request" },
  // --- commit: intent (must route through CommitCoordinator, never inline) ---
  { action: "repo.write",      effect: "commit",     dispatch: "intent", description: "Write to a repository (push / patch)" },
  { action: "github.publish",  effect: "commit",     dispatch: "intent", description: "Publish a PR comment / status to GitHub" },
];

/** Look up a SyscallDefinition by action. Returns undefined if not registered. */
export function getSyscallDefinition(action: Action): SyscallDefinition | undefined {
  return SYSCALL_DEFINITIONS.find(d => d.action === action);
}
