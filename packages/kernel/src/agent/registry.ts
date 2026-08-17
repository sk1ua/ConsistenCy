/**
 * AgentRegistry — Kernel-owned store of AgentControlBlocks.
 *
 * Responsibilities:
 *  - register Agents (state NEW) with validated process-tree invariants:
 *      • unique AgentId,
 *      • parent exists and belongs to the SAME Run,
 *      • no self-parent,
 *      • no cycles (parent chain is immutable and validated by walking it —
 *        cycles are structurally impossible after registration),
 *      • parent.children / child.parent stay consistent.
 *  - apply validated state transitions (replacing records immutably),
 *  - expose only frozen {@link AgentSnapshot} copies.
 *
 * The registry is a data store, not an orchestrator: it does not enqueue,
 * admit, or emit scheduler events. The KernelScheduler composes it.
 *
 * OWNERSHIP CONTRACT: in a running system the KernelScheduler is the only
 * component that should transition Agents (it owns the ready queue, running
 * capacity, and events). Direct registry use is intended for composition and
 * tests — a caller that transitions Agents directly owns the resulting
 * scheduler-consistency obligations (e.g. a RUNNING → SUCCEEDED transition
 * outside the Scheduler would leak concurrency capacity).
 */

import {
  transitionAgent,
} from "./state.js";
import {
  AgentTreeInvariantError,
  asAgentId,
  type AgentControlBlock,
  type AgentId,
  type AgentSnapshot,
  type AgentState,
  type PendingOperation,
  type RegisterAgentRequest,
} from "./types.js";
import type { RunId } from "../run/types.js";

export class AgentRegistry {
  readonly #agents = new Map<AgentId, AgentControlBlock>();
  readonly #clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  /**
   * Register a new Agent (state NEW).
   *
   * @throws {AgentTreeInvariantError} on duplicate id, unknown parent,
   *   cross-Run parent, or self-parent.
   * @throws {RangeError} when `deadline` is not strictly in the future.
   */
  register(request: RegisterAgentRequest): AgentSnapshot {
    if (this.#agents.has(request.id)) {
      throw new AgentTreeInvariantError(`Agent already exists: ${request.id}`);
    }

    if (request.parent !== undefined) {
      if (request.parent === request.id) {
        throw new AgentTreeInvariantError(`Agent cannot be its own parent: ${request.id}`);
      }
      const parent = this.#agents.get(request.parent);
      if (!parent) {
        throw new AgentTreeInvariantError(`Unknown parent Agent: ${request.parent}`);
      }
      if (parent.runId !== request.runId) {
        throw new AgentTreeInvariantError(
          `Child ${request.id} (run ${request.runId}) cannot have parent ${parent.id} from a different run (${parent.runId})`,
        );
      }
      // Defense in depth: walk the existing parent chain. Since parent is
      // immutable after registration this can never find a cycle today, but
      // the walk guarantees the invariant if re-parenting is ever added.
      let cursor: AgentControlBlock | undefined = parent;
      let depth = 0;
      while (cursor) {
        if (cursor.id === request.id) {
          throw new AgentTreeInvariantError(`Cycle detected while attaching ${request.id}`);
        }
        if (++depth > 1000) {
          throw new AgentTreeInvariantError("Agent parent chain exceeds maximum depth");
        }
        cursor = cursor.parent ? this.#agents.get(cursor.parent) : undefined;
      }
    }

    const createdAt = this.#clock();
    if (request.deadline !== undefined && request.deadline <= createdAt) {
      throw new RangeError("Agent deadline must be strictly in the future");
    }

    const agent: AgentControlBlock = {
      id: request.id,
      runId: request.runId,
      state: "NEW",
      priority: request.priority,
      parent: request.parent,
      children: [],
      contextImage: request.contextImage,
      capabilities: [...(request.capabilities ?? [])],
      logicalRing: request.logicalRing ?? 3,
      executionDomain: request.executionDomain,
      modelPolicy: request.modelPolicy,
      tokenBudget: request.tokenBudget,
      costBudgetUsdMicros: request.costBudgetUsdMicros,
      wallTimeBudgetMs: request.wallTimeBudgetMs,
      pendingOperation: undefined,
      createdAt,
      deadline: request.deadline,
    };
    this.#agents.set(agent.id, agent);

    // Maintain parent.children consistency (parent record is replaced, too).
    if (agent.parent !== undefined) {
      const parent = this.#agents.get(agent.parent)!;
      this.#agents.set(parent.id, { ...parent, children: [...parent.children, agent.id] });
    }

    return this.#snapshot(agent);
  }

  get(id: AgentId): AgentSnapshot | undefined {
    const agent = this.#agents.get(id);
    return agent ? this.#snapshot(agent) : undefined;
  }

  list(): readonly AgentSnapshot[] {
    return [...this.#agents.values()].map((agent) => this.#snapshot(agent));
  }

  /**
   * Apply a validated Agent state transition (record replaced, not mutated).
   * Optionally attach/clear the pending operation in the same atomic step.
   *
   * @throws {AgentStateTransitionError} on invalid transitions.
   */
  transition(
    id: AgentId,
    to: AgentState,
    patch?: { readonly pendingOperation?: PendingOperation },
  ): AgentSnapshot {
    const agent = this.#agents.get(id);
    if (!agent) {
      throw new Error(`Unknown Agent: ${id}`);
    }
    transitionAgent(agent.state, to);
    const next: AgentControlBlock = {
      ...agent,
      state: to,
      pendingOperation: patch ? patch.pendingOperation : agent.pendingOperation,
    };
    this.#agents.set(id, next);
    return this.#snapshot(next);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  #snapshot(agent: AgentControlBlock): AgentSnapshot {
    const snapshot: AgentSnapshot = Object.freeze({
      ...agent,
      children: Object.freeze([...agent.children]),
      capabilities: Object.freeze(
        agent.capabilities.map((ref) => Object.freeze({ ...ref })),
      ),
      pendingOperation: agent.pendingOperation
        ? Object.freeze({ ...agent.pendingOperation })
        : undefined,
      modelPolicy: agent.modelPolicy
        ? Object.freeze({ ...agent.modelPolicy })
        : undefined,
    });
    return snapshot;
  }
}

export { asAgentId };
