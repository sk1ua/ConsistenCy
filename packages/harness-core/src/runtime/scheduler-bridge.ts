/**
 * SchedulerAgentBridge — the minimal Kernel Scheduler ↔ Cordis Fiber bridge.
 *
 * Maps KernelScheduler Agent Process admission onto REAL Cordis fiber
 * lifecycle:
 *
 *   agent admitted (READY → RUNNING)   → per-agent "admission" service provided
 *                                         → fiber LOADING → ACTIVE
 *   agent yields / completes / cancels → admission service disposed
 *                                         → fiber cleanup → UNLOADING → PENDING
 *
 * STRICT INVARIANTS (from PR-2):
 *   - Scheduler state ≠ Fiber lifecycle state. The bridge only mirrors
 *     ADMISSION into structural availability; a body may keep executing
 *     while its fiber is PENDING (no preemption is claimed).
 *   - The bridge performs NO authorization. Every protected operation still
 *     goes through SyscallGateway → CapabilityBroker.authorise().
 *   - Agent-scoped contexts are ISOLATED: toggling one agent's admission
 *     never affects another agent's fiber.
 *
 * Implementation notes:
 *   - provide/dispose operations are serialized through a promise queue, so
 *     rapid RUNNING → WAIT_LLM → READY → RUNNING cycles cannot race
 *     (Cordis rejects re-providing a service whose disposal has not run).
 *   - Fiber state observations lag scheduler transitions by microtasks;
 *     `flush()` settles the queue for deterministic tests.
 */

import { Context } from "cordis";
import type { Fiber, Plugin } from "cordis";
import type {
  AgentId,
  KernelScheduler,
  Principal,
} from "@consistency/kernel";

/** Observable fiber lifecycle counters (tests / diagnostics). */
export interface AgentFiberInstrumentation {
  /** How many times the agent's fiber applied (LOADING → ACTIVE). */
  applied: number;
  /** How many times the agent's fiber cleanup ran (UNLOADING). */
  cleaned: number;
}

export interface AgentFiberHandle {
  readonly principal: Principal;
  readonly agentId: AgentId;
  /** Agent-scoped isolated Cordis context (never the root). */
  readonly ctx: Context;
  readonly fiber: Fiber;
  readonly instrumentation: AgentFiberInstrumentation;
  /**
   * Run work on behalf of an agent the Scheduler has ADMITTED (state
   * RUNNING). Throws when the agent was never admitted (fiber not ACTIVE).
   */
  execute<T>(work: () => T | Promise<T>): Promise<T>;
}

interface Attachment {
  readonly ctx: Context;
  readonly fiber: Fiber;
  readonly instrumentation: AgentFiberInstrumentation;
  disposer: (() => Promise<void>) | null;
}

export class SchedulerAgentBridge {
  readonly #root: Context;
  readonly #attachments = new Map<AgentId, Attachment>();
  readonly #unsubscribe: () => void;
  #pending: Promise<void> = Promise.resolve();

  constructor(root: Context, scheduler: KernelScheduler) {
    this.#root = root;
    this.#unsubscribe = scheduler.onEvent((event) => {
      if (event.type !== "agent.stateChanged") return;
      if (event.to === "RUNNING") {
        this.#enqueue(() => this.#provide(event.agentId));
      } else {
        this.#enqueue(() => this.#dispose(event.agentId));
      }
    });
  }

  /**
   * Attach an agent to the bridge BEFORE the Scheduler admits it. The fiber
   * starts PENDING and only becomes ACTIVE on admission.
   */
  attach(principal: Principal, agentId: AgentId): AgentFiberHandle {
    const ctx = this.#root.isolate("admission", Symbol(`agent:${agentId}`));
    const instrumentation: AgentFiberInstrumentation = { applied: 0, cleaned: 0 };

    const plugin: Plugin.Function<void> = function admissionAgent(ctx: Context, _config: void): void {
      instrumentation.applied += 1;
      ctx.effect(() => () => {
        instrumentation.cleaned += 1;
      });
    };
    plugin.inject = ["admission"];

    const fiber = ctx.plugin(plugin);
    this.#attachments.set(agentId, { ctx, fiber, instrumentation, disposer: null });

    return {
      principal,
      agentId,
      ctx,
      fiber,
      instrumentation,
      execute: (work) => this.#execute(agentId, work),
    };
  }

  /** Settle all queued admission propagations (deterministic tests). */
  flush(): Promise<void> {
    return this.#pending;
  }

  /** Stop listening to scheduler events (fiber states freeze afterwards). */
  dispose(): void {
    this.#unsubscribe();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  async #execute<T>(agentId: AgentId, work: () => T | Promise<T>): Promise<T> {
    const attachment = this.#attachments.get(agentId);
    if (!attachment) {
      throw new Error(`agent not attached to bridge: ${agentId}`);
    }
    // Settle the admission queue first, then wait for the fiber's own
    // load/unload inertia, then verify ACTIVE.
    await this.#pending;
    await attachment.fiber.await();
    if (attachment.fiber.state !== 2 /* ACTIVE */) {
      throw new Error(
        `agent ${agentId} is not admitted by the Scheduler (fiber state ${attachment.fiber.state})`,
      );
    }
    return work();
  }

  #provide(agentId: AgentId): void {
    const attachment = this.#attachments.get(agentId);
    if (!attachment || attachment.disposer) return; // already provided
    const disposer = attachment.ctx.reflect.provide(
      "admission",
      Object.freeze({ agentId }),
    );
    attachment.disposer = disposer;
  }

  #dispose(agentId: AgentId): Promise<void> {
    const attachment = this.#attachments.get(agentId);
    if (!attachment || !attachment.disposer) return Promise.resolve();
    const disposer = attachment.disposer;
    attachment.disposer = null;
    return disposer();
  }

  #enqueue(task: () => void | Promise<void>): void {
    this.#pending = this.#pending.then(task).catch(() => {});
  }
}
