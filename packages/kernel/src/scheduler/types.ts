/**
 * Scheduler types — cooperative admission control, NOT CPU-style preemption.
 *
 * The Scheduler decides WHO may execute local Agent logic next. Remote LLM
 * inference (WAIT_LLM) is submitted work that cannot be preempted: yielding
 * frees local execution capacity, but provider compute already dispatched
 * may not be recoverable.
 */

import type { RunId, RunSnapshot, RunState } from "../run/types.js";
import type {
  AgentId,
  AgentSnapshot,
  AgentState,
  PendingOperation,
} from "../agent/types.js";

export interface SchedulerConfig {
  /**
   * Global concurrency admission limit: how many Agents may be RUNNING
   * (executing local logic) at once.
   */
  readonly maxRunningAgents: number;
}

/** What an Agent is waiting on when it cooperatively yields. */
export type WaitDetails =
  | { readonly kind: "llm"; readonly provider?: string }
  | { readonly kind: "tool"; readonly toolName: string }
  | { readonly kind: "io"; readonly description: string }
  | { readonly kind: "agent"; readonly target: AgentId }
  | { readonly kind: "human"; readonly prompt: string };

/** Maps a wait kind to the corresponding WAIT_* Agent state. */
export const WAIT_STATE_BY_KIND: Readonly<Record<WaitDetails["kind"], AgentState>> = {
  llm: "WAIT_LLM",
  tool: "WAIT_TOOL",
  io: "WAIT_IO",
  agent: "WAIT_AGENT",
  human: "WAIT_HUMAN",
};

/**
 * Build the PendingOperation recorded on the ACB while the Agent waits.
 */
export function pendingOperationFor(
  details: WaitDetails,
  startedAt: number,
): PendingOperation {
  switch (details.kind) {
    case "llm":
      return { kind: "llm", startedAt, provider: details.provider };
    case "tool":
      return { kind: "tool", startedAt, toolName: details.toolName };
    case "io":
      return { kind: "io", startedAt, description: details.description };
    case "agent":
      return { kind: "agent", startedAt, target: details.target };
    case "human":
      return { kind: "human", startedAt, prompt: details.prompt };
  }
}

/** Typed, immutable Scheduler lifecycle events (feed observability later). */
export type SchedulerEvent =
  | { readonly type: "run.registered"; readonly timestamp: number; readonly run: RunSnapshot }
  | {
      readonly type: "run.stateChanged";
      readonly timestamp: number;
      readonly runId: RunId;
      readonly from: RunState;
      readonly to: RunState;
    }
  | { readonly type: "run.cancelled"; readonly timestamp: number; readonly runId: RunId }
  | {
      readonly type: "agent.registered";
      readonly timestamp: number;
      readonly agent: AgentSnapshot;
    }
  | {
      readonly type: "agent.stateChanged";
      readonly timestamp: number;
      readonly agentId: AgentId;
      readonly from: AgentState;
      readonly to: AgentState;
    }
  | {
      readonly type: "agent.admitted";
      readonly timestamp: number;
      readonly agentId: AgentId;
      readonly runId: RunId;
    }
  | {
      readonly type: "agent.cancelled";
      readonly timestamp: number;
      readonly agentId: AgentId;
      readonly reason: "run_cancelled" | "deadline" | "explicit";
    };

export type SchedulerEventListener = (event: SchedulerEvent) => void;
