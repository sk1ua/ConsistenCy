/**
 * HarnessRuntime — the PR-2 vertical-slice runtime.
 *
 * Owns:
 *   - a Cordis root Context,
 *   - a CapabilityLifecycleAdapter (coeffect/lifecycle layer),
 *   - a SyscallGateway over the Kernel's CapabilityBroker.
 *
 * The runtime is the ONLY component that issues capabilities and binds them
 * into agent-scoped Cordis contexts as capability-bound facades. It performs
 * NO authorization of its own — every facade call is authorized by the
 * Kernel per syscall.
 */

import { Context } from "cordis";
import type { Fiber } from "cordis";
import {
  CapabilityBroker,
  CapabilityChangeBus,
  makePrincipalId,
  SyscallGateway,
  type ASTResource,
  type CapabilityHandle,
  type Principal,
  type ResourceScope,
} from "@consistency/kernel";
import { CapabilityLifecycleAdapter } from "./adapter.js";
import {
  createEchoAgent,
  createEchoAgentInstrumentation,
  type EchoAgentInstrumentation,
} from "../agent/echo-agent.js";

/** A synthetic Agent attached to the harness: principal + scoped context + fiber. */
export interface AgentAttachment {
  readonly principal: Principal;
  /** Agent-scoped, isolated Cordis context (never the root context). */
  readonly ctx: Context;
  /** The synthetic agent's Cordis Fiber (observable state: PENDING/ACTIVE/…). */
  readonly fiber: Fiber;
  /** Test instrumentation for the agent's applies/cleanups/echoes. */
  readonly instrumentation: EchoAgentInstrumentation;
}

export interface HarnessRuntimeOptions {
  readonly broker: CapabilityBroker;
  readonly bus: CapabilityChangeBus;
}

/** Principal the harness records as the revoker (a Kernel-internal identity). */
const HARNESS_KERNEL_PRINCIPAL_ID = makePrincipalId("kernel", "harness");

export class HarnessRuntime {
  readonly #broker: CapabilityBroker;
  readonly #gateway: SyscallGateway;
  readonly #root: Context;
  readonly #adapter: CapabilityLifecycleAdapter;

  constructor(options: HarnessRuntimeOptions) {
    this.#broker = options.broker;
    this.#gateway = new SyscallGateway(options.broker);
    this.#root = new Context();
    this.#adapter = new CapabilityLifecycleAdapter(this.#root, options.bus);
  }

  /** The Cordis root context (services must NOT be globally toggled here). */
  get root(): Context {
    return this.#root;
  }

  /**
   * Attach a synthetic EchoAgent as a Cordis Fiber in an agent-scoped
   * isolated context. The fiber starts PENDING until an `ast` service is
   * provided for this agent.
   */
  attachAgent(principal: Principal): AgentAttachment {
    const ctx = this.#adapter.attachAgent(principal);
    const instrumentation = createEchoAgentInstrumentation();
    const plugin = createEchoAgent(instrumentation);
    const fiber = ctx.plugin(plugin);
    return { principal, ctx, fiber, instrumentation };
  }

  /**
   * Issue a Kernel `ast.query` capability for the agent and bind a
   * CapabilityBoundAstFacade into the agent's Cordis context.
   *
   * Returns the opaque Kernel handle (used later for revocation).
   */
  issueAstCapability(
    agent: AgentAttachment,
    resource: ASTResource,
    scope?: ResourceScope,
  ): CapabilityHandle {
    const handle = this.#broker.issue({
      subject: agent.principal,
      action: "ast.query",
      resource,
      scope,
    });
    this.#adapter.provisionAst(agent.principal, handle, resource, this.#gateway);
    return handle;
  }

  /**
   * Revoke a capability at the Kernel. The adapter reacts to the Kernel's
   * revoked event and unloads the facade service from the affected agent's
   * context (asynchronously) — but every subsequent syscall with the stale
   * handle is denied by the Kernel immediately, independent of that timing.
   */
  revokeCapability(handle: CapabilityHandle): void {
    this.#broker.revoke(handle, HARNESS_KERNEL_PRINCIPAL_ID);
  }

  /** Wait until deferred Cordis propagation from revocations has completed. */
  flushPropagation(): Promise<void> {
    return this.#adapter.flush();
  }

  /** Stop the adapter's Kernel event subscription. */
  dispose(): void {
    this.#adapter.dispose();
  }
}
