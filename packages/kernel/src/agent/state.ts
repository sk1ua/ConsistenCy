/**
 * Agent state machine — explicit transition semantics.
 *
 * No arbitrary mutation. Every transition is validated against
 * {@link AGENT_TRANSITIONS}; invalid transitions throw
 * {@link AgentStateTransitionError}. Terminal states never return to
 * executable states.
 *
 * NOTE: these states are a Kernel/Scheduler dimension. They are NOT derived
 * from Cordis Fiber state — a fiber can be ACTIVE while the agent is
 * WAIT_LLM, and vice versa.
 */

import type { AgentState } from "./types.js";

/**
 * Explicit transition table.
 *
 * - NEW → READY (and NEW → CANCELLED for never-started agents).
 * - READY → RUNNING via scheduler admission; READY → SUSPENDED/CANCELLED.
 * - RUNNING → WAIT_* is a cooperative yield (releases execution capacity).
 * - WAIT_* → READY (wake); WAIT_* → SUSPENDED/CANCELLED.
 * - RUNNING → SUCCEEDED/FAILED; any non-terminal → CANCELLED.
 * - SUSPENDED → READY.
 * - Terminal states (SUCCEEDED, FAILED, CANCELLED) have NO exits.
 */
export const AGENT_TRANSITIONS: Readonly<Record<AgentState, readonly AgentState[]>> = {
  NEW: ["READY", "FAILED", "CANCELLED"],
  READY: ["RUNNING", "SUSPENDED", "FAILED", "CANCELLED"],
  RUNNING: [
    "WAIT_LLM",
    "WAIT_TOOL",
    "WAIT_IO",
    "WAIT_AGENT",
    "WAIT_HUMAN",
    "SUSPENDED",
    "SUCCEEDED",
    "FAILED",
    "CANCELLED",
  ],
  WAIT_LLM: ["READY", "SUSPENDED", "FAILED", "CANCELLED"],
  WAIT_TOOL: ["READY", "SUSPENDED", "FAILED", "CANCELLED"],
  WAIT_IO: ["READY", "SUSPENDED", "FAILED", "CANCELLED"],
  WAIT_AGENT: ["READY", "SUSPENDED", "FAILED", "CANCELLED"],
  WAIT_HUMAN: ["READY", "SUSPENDED", "FAILED", "CANCELLED"],
  SUSPENDED: ["READY", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

/** Typed error raised when an invalid Agent state transition is attempted. */
export class AgentStateTransitionError extends Error {
  readonly from: AgentState;
  readonly to: AgentState;

  constructor(from: AgentState, to: AgentState) {
    super(`Invalid Agent state transition: ${from} -> ${to}`);
    this.name = "AgentStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionAgent(from: AgentState, to: AgentState): boolean {
  return AGENT_TRANSITIONS[from].includes(to);
}

/** Return the successor state, or throw a typed error. */
export function transitionAgent(from: AgentState, to: AgentState): AgentState {
  if (!canTransitionAgent(from, to)) {
    throw new AgentStateTransitionError(from, to);
  }
  return to;
}
