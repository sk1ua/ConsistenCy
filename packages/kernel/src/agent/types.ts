/**
 * Agent process model — AgentId, AgentState, and the AgentControlBlock (ACB).
 *
 * An Agent is a LOGICAL PROCESS (Kernel tier). Its state is managed by the
 * Kernel state machine and the Scheduler — it is an independent dimension
 * from any Cordis Fiber lifecycle. A Cordis fiber may be ACTIVE while the
 * Agent's scheduler state is WAIT_LLM; the two are never derived from each
 * other.
 */

import type { Action } from "../capability/types.js";
import type { PrivilegeRing } from "../capability/policy.js";
import type { ResourceKind } from "../identity/resource.js";
import type { ContextImageId } from "../identity/context-image.js";
import type { RunId } from "../run/types.js";

/** Branded, serializable Agent identifier. NOT coupled to any fiber identity. */
export type AgentId = string & { readonly __brand: "AgentId" };

/** Cast a plain string to an AgentId after validating it is non-empty. */
export function asAgentId(raw: string): AgentId {
  if (!raw || raw.trim() === "") {
    throw new TypeError("AgentId must be non-empty");
  }
  return raw as AgentId;
}

/**
 * Kernel scheduler states for an Agent process.
 *
 * Semantics:
 * - `RUNNING`       — executing local logic (occupies concurrency capacity).
 * - `WAIT_LLM`      — a remote inference call has been SUBMITTED and the
 *                     Agent is waiting. The Kernel cannot preempt provider
 *                     compute; cancellation may propagate an AbortSignal but
 *                     spent provider cost is not recoverable.
 * - `WAIT_TOOL/IO/AGENT/HUMAN` — cooperative waits on external/tool/child/
 *                     human input.
 * - Terminal: `SUCCEEDED`, `FAILED`, `CANCELLED` — never executable again.
 */
export type AgentState =
  | "NEW"
  | "READY"
  | "RUNNING"
  | "WAIT_LLM"
  | "WAIT_TOOL"
  | "WAIT_IO"
  | "WAIT_AGENT"
  | "WAIT_HUMAN"
  | "SUSPENDED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export const AGENT_STATES: readonly AgentState[] = [
  "NEW",
  "READY",
  "RUNNING",
  "WAIT_LLM",
  "WAIT_TOOL",
  "WAIT_IO",
  "WAIT_AGENT",
  "WAIT_HUMAN",
  "SUSPENDED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
];

export const TERMINAL_AGENT_STATES: readonly AgentState[] = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
];

export const WAIT_AGENT_STATES: readonly AgentState[] = [
  "WAIT_LLM",
  "WAIT_TOOL",
  "WAIT_IO",
  "WAIT_AGENT",
  "WAIT_HUMAN",
];

/** Physical execution domain. Logical ring and execution domain are separate. */
export type ExecutionDomain = "in-process" | "worker-thread" | "child-process";

/**
 * Capability metadata recorded on an ACB — a DESCRIPTOR, never a credential
 * and never an authorization decision. Authorization still happens per-call
 * through SyscallGateway → CapabilityBroker.authorise(). Presence of a ref in
 * this array grants nothing.
 */
export interface CapabilityRef {
  /** 12-hex-char fingerprint — correlation only, never the raw handle. */
  readonly handleFingerprint: string;
  readonly action: Action;
  readonly resourceKind: ResourceKind;
}

/**
 * The operation an Agent is currently waiting on. Mirrors WAIT_* states;
 * set on yield, cleared on wake.
 */
export type PendingOperation =
  | { readonly kind: "llm"; readonly startedAt: number; readonly provider?: string }
  | { readonly kind: "tool"; readonly startedAt: number; readonly toolName: string }
  | { readonly kind: "io"; readonly startedAt: number; readonly description: string }
  | { readonly kind: "agent"; readonly startedAt: number; readonly target: AgentId }
  | { readonly kind: "human"; readonly startedAt: number; readonly prompt: string };

/** Minimal generic model policy — no workload-specific fields. */
export interface ModelPolicy {
  readonly provider?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

/**
 * AgentControlBlock — Kernel-owned process metadata (analogous to a PCB).
 *
 * The AgentRegistry owns instances and replaces them on every change; no
 * mutable ACB ever leaves the Kernel — callers receive frozen
 * {@link AgentSnapshot} copies.
 */
export interface AgentControlBlock {
  readonly id: AgentId;
  readonly runId: RunId;

  state: AgentState;
  readonly priority: number;

  readonly parent?: AgentId;
  readonly children: readonly AgentId[];

  /** Opaque ContextImage reference only — the Context VM arrives in PR-3. */
  readonly contextImage?: ContextImageId;

  /** Capability descriptors. Metadata only — NOT authorization. */
  readonly capabilities: readonly CapabilityRef[];

  readonly logicalRing: PrivilegeRing;
  readonly executionDomain: ExecutionDomain;

  readonly modelPolicy?: ModelPolicy;

  readonly tokenBudget?: number;
  readonly costBudgetUsdMicros?: bigint;
  readonly wallTimeBudgetMs?: number;

  pendingOperation?: PendingOperation;

  readonly createdAt: number;
  readonly deadline?: number;
}

/** Immutable, frozen public view of an ACB. */
export type AgentSnapshot = Readonly<AgentControlBlock>;

export interface RegisterAgentRequest {
  readonly id: AgentId;
  readonly runId: RunId;
  readonly priority: number;
  readonly parent?: AgentId;
  readonly contextImage?: ContextImageId;
  readonly capabilities?: readonly CapabilityRef[];
  readonly logicalRing?: PrivilegeRing;
  readonly executionDomain: ExecutionDomain;
  readonly modelPolicy?: ModelPolicy;
  readonly tokenBudget?: number;
  readonly costBudgetUsdMicros?: bigint;
  readonly wallTimeBudgetMs?: number;
  readonly deadline?: number;
}

/** Typed error raised when Agent registration violates tree invariants. */
export class AgentTreeInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTreeInvariantError";
  }
}
