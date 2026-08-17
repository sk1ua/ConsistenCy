/**
 * KernelScheduler — admission control + cooperative scheduling.
 *
 * This is NOT a CPU scheduler. Remote LLM inference is not preemptable;
 * WAIT_LLM means "async inference already submitted". The Scheduler decides:
 *
 *  - who may execute local Agent logic next (READY → RUNNING admission),
 *  - how many Agents may run concurrently (global limit),
 *  - priority ordering (higher number = higher priority),
 *  - deterministic FIFO fairness among equal priorities,
 *  - cooperative yield/wake (RUNNING → WAIT_* → READY),
 *  - deadline enforcement (an expired Agent/Run is never admitted),
 *  - Run/Agent cancellation,
 *  - read-only process snapshots (no raw records, no capability credentials).
 *
 * Cordis-free: the Kernel knows nothing about fibers, injection, or Cordis
 * lifecycle. The harness bridges Scheduler state to fiber runtime later.
 */

import {
  TERMINAL_AGENT_STATES,
  WAIT_AGENT_STATES,
  type AgentId,
  type AgentSnapshot,
  type AgentState,
  type RegisterAgentRequest,
} from "../agent/types.js";
import { AgentStateTransitionError } from "../agent/state.js";
import { AgentRegistry } from "../agent/registry.js";
import {
  TERMINAL_RUN_STATES,
  type CreateRunRequest,
  type RunId,
  type RunSnapshot,
} from "../run/types.js";
import { RunStateTransitionError } from "../run/types.js";
import { RunRegistry } from "../run/registry.js";
import { SchedulerEventBus } from "./events.js";
import {
  pendingOperationFor,
  WAIT_STATE_BY_KIND,
  type SchedulerConfig,
  type SchedulerEventListener,
  type WaitDetails,
} from "./types.js";

export interface KernelSchedulerOptions {
  readonly clock?: () => number;
  readonly runs?: RunRegistry;
  readonly agents?: AgentRegistry;
  readonly bus?: SchedulerEventBus;
}

export class KernelScheduler {
  readonly #runs: RunRegistry;
  readonly #agents: AgentRegistry;
  readonly #bus: SchedulerEventBus;
  readonly #clock: () => number;
  readonly #maxRunningAgents: number;

  /** READY agents, in enqueue order (FIFO within equal priority). */
  readonly #readyQueue: AgentId[] = [];
  #runningCount = 0;

  constructor(config: SchedulerConfig, options: KernelSchedulerOptions = {}) {
    if (!Number.isInteger(config.maxRunningAgents) || config.maxRunningAgents < 1) {
      throw new RangeError("maxRunningAgents must be a positive integer");
    }
    this.#clock = options.clock ?? Date.now;
    this.#runs = options.runs ?? new RunRegistry(this.#clock);
    this.#agents = options.agents ?? new AgentRegistry(this.#clock);
    this.#bus = options.bus ?? new SchedulerEventBus();
    this.#maxRunningAgents = config.maxRunningAgents;
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  registerRun(request: CreateRunRequest): RunSnapshot {
    const run = this.#runs.create(request);
    this.#bus.emit({ type: "run.registered", timestamp: this.#clock(), run });
    return run;
  }

  getRun(id: RunId): RunSnapshot | undefined {
    return this.#runs.get(id);
  }

  listRuns(): readonly RunSnapshot[] {
    return this.#runs.list();
  }

  /** CREATED → ACTIVE (or SUSPENDED → ACTIVE). */
  activateRun(id: RunId): RunSnapshot {
    const before = this.#runs.get(id);
    if (!before) {
      throw new Error(`Unknown Run: ${id}`);
    }
    if (before.state !== "CREATED" && before.state !== "SUSPENDED") {
      throw new RunStateTransitionError(before.state, "ACTIVE");
    }
    const after = this.#runs.transition(id, "ACTIVE");
    this.#bus.emit({
      type: "run.stateChanged",
      timestamp: this.#clock(),
      runId: id,
      from: before.state,
      to: after.state,
    });
    return after;
  }

  /** Non-terminal → SUCCEEDED (terminal). */
  succeedRun(id: RunId): RunSnapshot {
    const before = this.#runs.get(id);
    if (!before) {
      throw new Error(`Unknown Run: ${id}`);
    }
    if (TERMINAL_RUN_STATES.includes(before.state)) {
      throw new RunStateTransitionError(before.state, "SUCCEEDED");
    }
    const after = this.#runs.transition(id, "SUCCEEDED");
    this.#bus.emit({
      type: "run.stateChanged",
      timestamp: this.#clock(),
      runId: id,
      from: before.state,
      to: after.state,
    });
    return after;
  }

  /** Non-terminal → FAILED (terminal). */
  failRun(id: RunId): RunSnapshot {
    const before = this.#runs.get(id);
    if (!before) {
      throw new Error(`Unknown Run: ${id}`);
    }
    if (TERMINAL_RUN_STATES.includes(before.state)) {
      throw new RunStateTransitionError(before.state, "FAILED");
    }
    const after = this.#runs.transition(id, "FAILED");
    this.#bus.emit({
      type: "run.stateChanged",
      timestamp: this.#clock(),
      runId: id,
      from: before.state,
      to: after.state,
    });
    return after;
  }

  /**
   * Cancel a Run and every non-terminal Agent in it.
   *
   * Idempotent when the Run is already CANCELLED. Throws a typed transition
   * error when the Run already finished (SUCCEEDED/FAILED). Cancelled Agents
   * are removed from the ready queue and can never be scheduled again;
   * already-dispatched external work is NOT rolled back.
   */
  cancelRun(id: RunId): void {
    const run = this.#runs.get(id);
    if (!run) {
      throw new Error(`Unknown Run: ${id}`);
    }
    if (run.state === "CANCELLED") return;
    if (run.state === "SUCCEEDED" || run.state === "FAILED") {
      throw new RunStateTransitionError(run.state, "CANCELLED");
    }
    const from = run.state;
    this.#runs.transition(id, "CANCELLED");

    for (const agent of this.#agents.list()) {
      if (agent.runId === id && !TERMINAL_AGENT_STATES.includes(agent.state)) {
        this.#cancelAgentInternal(agent.id, "run_cancelled");
      }
    }

    const timestamp = this.#clock();
    this.#bus.emit({ type: "run.stateChanged", timestamp, runId: id, from, to: "CANCELLED" });
    this.#bus.emit({ type: "run.cancelled", timestamp, runId: id });
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  registerAgent(request: RegisterAgentRequest): AgentSnapshot {
    const run = this.#runs.get(request.runId);
    if (!run) {
      throw new Error(`Unknown Run: ${request.runId}`);
    }
    if (TERMINAL_RUN_STATES.includes(run.state)) {
      throw new Error(`Cannot register Agent into terminal Run (${run.state})`);
    }
    const agent = this.#agents.register(request);
    this.#bus.emit({ type: "agent.registered", timestamp: this.#clock(), agent });
    return agent;
  }

  getAgent(id: AgentId): AgentSnapshot | undefined {
    return this.#agents.get(id);
  }

  listAgents(): readonly AgentSnapshot[] {
    return this.#agents.list();
  }

  /** NEW → READY and enqueue. */
  ready(agentId: AgentId): AgentSnapshot {
    this.#assertState(agentId, "NEW", "READY");
    const snapshot = this.#changeState(agentId, "READY");
    this.#enqueue(agentId);
    return snapshot;
  }

  /**
   * Admit the next eligible READY agent: highest priority first, FIFO among
   * equal priorities, subject to the global concurrency limit, active Run,
   * and unexpired deadlines. Expired candidates are cancelled (never
   * admitted). Returns the admitted snapshot, or undefined when nothing is
   * eligible right now.
   */
  admit(): AgentSnapshot | undefined {
    const now = this.#clock();

    // Pass 1 — deadline enforcement: an expired agent must never start.
    for (const id of [...this.#readyQueue]) {
      const agent = this.#agents.get(id);
      if (!agent || agent.state !== "READY") {
        this.#dequeue(id);
        continue;
      }
      const run = this.#runs.get(agent.runId);
      if (!run || run.state !== "ACTIVE") continue; // keep queued; run not active
      const deadline = agent.deadline ?? run.deadline;
      if (deadline !== undefined && now >= deadline) {
        this.#cancelAgentInternal(id, "deadline");
      }
    }

    // Pass 2 — concurrency admission.
    if (this.#runningCount >= this.#maxRunningAgents) return undefined;

    // Pass 3 — priority ordering with deterministic FIFO among equals.
    let bestId: AgentId | undefined;
    let bestPriority = Number.NEGATIVE_INFINITY;
    for (const id of this.#readyQueue) {
      const agent = this.#agents.get(id);
      if (!agent || agent.state !== "READY") continue;
      const run = this.#runs.get(agent.runId);
      if (!run || run.state !== "ACTIVE") continue;
      if (agent.priority > bestPriority) {
        bestId = id;
        bestPriority = agent.priority;
      }
    }
    if (bestId === undefined) return undefined;

    this.#dequeue(bestId);
    const snapshot = this.#changeState(bestId, "RUNNING");
    this.#runningCount += 1;
    this.#bus.emit({
      type: "agent.admitted",
      timestamp: this.#clock(),
      agentId: bestId,
      runId: snapshot.runId,
    });
    return snapshot;
  }

  /**
   * Cooperative yield: RUNNING → WAIT_* and release local execution capacity.
   * The pending operation is recorded on the ACB.
   */
  wait(agentId: AgentId, details: WaitDetails): AgentSnapshot {
    const to = WAIT_STATE_BY_KIND[details.kind];
    this.#assertState(agentId, "RUNNING", to);
    const snapshot = this.#changeState(agentId, to, {
      pendingOperation: pendingOperationFor(details, this.#clock()),
    });
    this.#runningCount -= 1;
    return snapshot;
  }

  /** WAIT_* → READY: the waited operation completed; re-enqueue. */
  wake(agentId: AgentId): AgentSnapshot {
    const agent = this.#agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown Agent: ${agentId}`);
    }
    if (!WAIT_AGENT_STATES.includes(agent.state)) {
      throw new AgentStateTransitionError(agent.state, "READY");
    }
    const snapshot = this.#changeState(agentId, "READY", { pendingOperation: undefined });
    this.#enqueue(agentId);
    return snapshot;
  }

  /** READY/RUNNING/WAIT_* → SUSPENDED. */
  suspendAgent(agentId: AgentId): AgentSnapshot {
    const agent = this.#agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown Agent: ${agentId}`);
    }
    const suspendable: AgentState[] = [
      "READY",
      "RUNNING",
      ...WAIT_AGENT_STATES,
    ];
    if (!suspendable.includes(agent.state)) {
      throw new AgentStateTransitionError(agent.state, "SUSPENDED");
    }
    this.#dequeue(agentId);
    const snapshot = this.#changeState(agentId, "SUSPENDED", { pendingOperation: undefined });
    if (agent.state === "RUNNING") this.#runningCount -= 1;
    return snapshot;
  }

  /** SUSPENDED → READY and re-enqueue. */
  resumeAgent(agentId: AgentId): AgentSnapshot {
    this.#assertState(agentId, "SUSPENDED", "READY");
    const snapshot = this.#changeState(agentId, "READY");
    this.#enqueue(agentId);
    return snapshot;
  }

  /** RUNNING → SUCCEEDED (terminal). */
  succeedAgent(agentId: AgentId): AgentSnapshot {
    this.#assertState(agentId, "RUNNING", "SUCCEEDED");
    const snapshot = this.#changeState(agentId, "SUCCEEDED");
    this.#runningCount -= 1;
    return snapshot;
  }

  /** Any non-terminal → FAILED (terminal). */
  failAgent(agentId: AgentId): AgentSnapshot {
    const agent = this.#agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown Agent: ${agentId}`);
    }
    if (agent.state === "FAILED") return agent;
    if (TERMINAL_AGENT_STATES.includes(agent.state)) {
      throw new AgentStateTransitionError(agent.state, "FAILED");
    }
    this.#dequeue(agentId);
    const snapshot = this.#changeState(agentId, "FAILED", { pendingOperation: undefined });
    if (agent.state === "RUNNING") this.#runningCount -= 1;
    return snapshot;
  }

  /**
   * Cancel a non-terminal Agent (NEW, READY, any WAIT state, SUSPENDED,
   * RUNNING). Idempotent when already CANCELLED; throws when the Agent
   * already finished (SUCCEEDED/FAILED). External work already dispatched is
   * not rolled back.
   */
  cancelAgent(agentId: AgentId): void {
    const agent = this.#agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown Agent: ${agentId}`);
    }
    if (agent.state === "CANCELLED") return;
    if (agent.state === "SUCCEEDED" || agent.state === "FAILED") {
      throw new AgentStateTransitionError(agent.state, "CANCELLED");
    }
    this.#cancelAgentInternal(agentId, "explicit");
  }

  /** Configured maximum concurrent RUNNING agents. */
  get maxRunningAgents(): number {
    return this.#maxRunningAgents;
  }

  /** How many Agents currently occupy RUNNING capacity. */
  get runningCount(): number {
    return this.#runningCount;
  }

  /** How many Agents are currently queued READY. */
  get readyQueueSize(): number {
    return this.#readyQueue.length;
  }

  /** Subscribe to Scheduler lifecycle events. */
  onEvent(listener: SchedulerEventListener): () => void {
    return this.#bus.subscribe(listener);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  #assertState(agentId: AgentId, expected: AgentState, to: AgentState): void {
    const agent = this.#agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown Agent: ${agentId}`);
    }
    if (agent.state !== expected) {
      throw new AgentStateTransitionError(agent.state, to);
    }
  }

  /** Registry transition + agent.stateChanged event. */
  #changeState(
    agentId: AgentId,
    to: AgentState,
    patch?: { readonly pendingOperation?: AgentSnapshot["pendingOperation"] },
  ): AgentSnapshot {
    const before = this.#agents.get(agentId)!;
    const snapshot = this.#agents.transition(agentId, to, patch);
    this.#bus.emit({
      type: "agent.stateChanged",
      timestamp: this.#clock(),
      agentId,
      from: before.state,
      to,
    });
    return snapshot;
  }

  #enqueue(agentId: AgentId): void {
    if (this.#readyQueue.includes(agentId)) {
      // Defensive invariant: a duplicate READY entry must never exist.
      throw new Error(`Agent already in ready queue: ${agentId}`);
    }
    this.#readyQueue.push(agentId);
  }

  #dequeue(agentId: AgentId): void {
    const index = this.#readyQueue.indexOf(agentId);
    if (index !== -1) this.#readyQueue.splice(index, 1);
  }

  #cancelAgentInternal(
    agentId: AgentId,
    reason: "run_cancelled" | "deadline" | "explicit",
  ): void {
    const agent = this.#agents.get(agentId);
    if (!agent || TERMINAL_AGENT_STATES.includes(agent.state)) return;
    this.#dequeue(agentId);
    this.#changeState(agentId, "CANCELLED", { pendingOperation: undefined });
    if (agent.state === "RUNNING") this.#runningCount -= 1;
    this.#bus.emit({
      type: "agent.cancelled",
      timestamp: this.#clock(),
      agentId,
      reason,
    });
  }
}
