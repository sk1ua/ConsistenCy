/**
 * CapabilityLifecycleAdapter — Cordis Coeffect ↔ Kernel Capability binding.
 *
 * This adapter is the ONLY place where Kernel capability state influences
 * Cordis service availability. It subscribes to the Kernel's
 * {@link CapabilityChangeBus} and, on `capability.revoked` events, unloads
 * the affected Agent's facade service from that Agent's isolated context.
 *
 * STRICT CONTRACT (Axiom 1 — Coeffect ≠ Authorization):
 *
 *  1. The adapter controls LIFECYCLE ELIGIBILITY ONLY. Unloading a service
 *     makes the Agent's fiber PENDING; it does not and cannot authorize
 *     anything.
 *  2. Authorization happens per-call, in the Kernel, via
 *     `SyscallGateway → CapabilityBroker.authorise()`. A stale facade
 *     (held by an Agent whose service has not yet been unloaded) is denied
 *     by the Kernel on its very next syscall.
 *  3. Propagation here is intentionally deferred to the microtask queue —
 *     mirroring real-world async dependency propagation. Nothing about
 *     security depends on when this propagation completes.
 */

import type {
  CapabilityChangeBus,
  CapabilityChangeEvent,
} from "@consistency/kernel";
import type {
  ASTResource,
  CapabilityHandle,
  Principal,
  PrincipalId,
  SyscallGateway,
} from "@consistency/kernel";
import type { Context } from "cordis";
import "./cordis-augment.js";
import { CapabilityBoundAstFacade } from "../facade/ast-facade.js";

/** Per-agent Cordis bookkeeping held by the adapter. */
interface AgentServiceState {
  /** The agent-scoped isolated Cordis context (per-agent `ast` isolate key). */
  readonly ctx: Context;
  /** action → provisioned service (disposer handles Cordis effect cleanup). */
  readonly services: Map<string, () => Promise<void>>;
}

export class CapabilityLifecycleAdapter {
  readonly #root: Context;
  readonly #agents = new Map<PrincipalId, AgentServiceState>();
  readonly #unsubscribe: () => void;
  #pending: Promise<void> = Promise.resolve();

  constructor(root: Context, bus: CapabilityChangeBus) {
    this.#root = root;
    this.#unsubscribe = bus.subscribe((event) => this.#onCapabilityChange(event));
  }

  /**
   * Create an agent-scoped Cordis context isolated from all other agents.
   *
   * Each agent gets its own `ast` isolate key, so providing/disposing the
   * `ast` service for one agent NEVER affects another agent's context.
   */
  attachAgent(principal: Principal): Context {
    const ctx = this.#root.isolate("ast", Symbol(`agent:${principal.id}`));
    this.#agents.set(principal.id, { ctx, services: new Map() });
    return ctx;
  }

  /**
   * Bind a Kernel-issued `ast.query` capability into the agent's context as a
   * CapabilityBoundAstFacade service. Cordis fibers that declare
   * `inject: ["ast"]` transition PENDING → ACTIVE once this is provided.
   */
  provisionAst(
    principal: Principal,
    handle: CapabilityHandle,
    resource: ASTResource,
    gateway: SyscallGateway,
  ): void {
    const state = this.#agents.get(principal.id);
    if (!state) {
      throw new Error(`cannot provision ast.query: agent not attached (${principal.id})`);
    }
    if (state.services.has("ast.query")) {
      throw new Error(`ast.query already provisioned for agent ${principal.id}`);
    }

    const facade = new CapabilityBoundAstFacade({ principal, handle, resource, gateway });
    const disposer = state.ctx.reflect.provide("ast", facade);
    state.services.set("ast.query", disposer);
  }

  /**
   * Wait until all deferred service propagation (from revocations) has
   * completed. Test/diagnostic hook; production code never depends on this
   * for security.
   */
  flush(): Promise<void> {
    return this.#pending;
  }

  /** Stop listening to Kernel capability events. */
  dispose(): void {
    this.#unsubscribe();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  #onCapabilityChange(event: CapabilityChangeEvent): void {
    if (event.type !== "capability.revoked") return;

    const state = this.#agents.get(event.subject);
    const disposer = state?.services.get(event.action);
    if (!state || !disposer) return;

    // Unregister immediately so a second revoke event cannot double-schedule.
    state.services.delete(event.action);

    // Defer Cordis propagation to the microtask queue. Until it runs, the
    // agent's fiber may still be ACTIVE with a stale facade in hand — the
    // Kernel denies that stale facade on every call regardless.
    const propagation = this.#pending.then(() => disposer());
    this.#pending = propagation.catch(() => {});
    queueMicrotask(() => {
      void propagation;
    });
  }
}
