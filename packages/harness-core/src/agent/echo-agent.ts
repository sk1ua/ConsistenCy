/**
 * EchoAgent — the PR-2 synthetic Agent (Cordis Fiber).
 *
 * The EchoAgent is deliberately tiny and synthetic. Its only purpose is to
 * prove the architectural equation:
 *
 *   Kernel Capability → Cordis Coeffect → Fiber Lifecycle
 *
 * Lifecycle expectation (all driven by REAL Cordis semantics):
 *   - No capability/service         → fiber PENDING
 *   - `ast` facade provided         → fiber LOADING → ACTIVE (plugin applies)
 *   - Capability revoked            → service disposed → plugin cleanup runs
 *                                   → fiber UNLOADING → PENDING
 *
 * On apply, the agent captures the facade it received from its context and
 * performs one echo query through it — exercising the full syscall path
 * (Agent → facade → SyscallGateway → Kernel authorization → trusted handler).
 */

import type { Context, Plugin } from "cordis";
import type { CapabilityBoundAstFacade, AstQueryResult } from "../facade/ast-facade.js";

/** Observable state for tests (never used by production logic). */
export interface EchoAgentInstrumentation {
  /** How many times the fiber has applied (LOADING → ACTIVE). */
  appliedCount: number;
  /** How many times the fiber's cleanup has run (UNLOADING). */
  cleanupCount: number;
  /**
   * The facade instance the agent captured at its last apply. Held "stale"
   * after revocation — the exact object used to prove the Kernel denies it.
   */
  facade?: CapabilityBoundAstFacade;
  /** Result of the agent's apply-time echo query, if completed. */
  lastEcho?: AstQueryResult;
  /** Error of the apply-time echo query, if it was denied/failed. */
  echoError?: string;
}

export function createEchoAgentInstrumentation(): EchoAgentInstrumentation {
  return { appliedCount: 0, cleanupCount: 0 };
}

/**
 * Create the synthetic agent plugin.
 *
 * The returned function is a Cordis Plugin.Function with
 * `inject: ["ast"]` — the co-effect that makes Cordis keep the fiber PENDING
 * until the Kernel-backed facade service is provided in the agent's context.
 */
export function createEchoAgent(
  instrumentation: EchoAgentInstrumentation = createEchoAgentInstrumentation(),
): Plugin.Function<void> {
  const echoAgent: Plugin.Function<void> = function echoAgent(ctx: Context, _config: void): void {
    instrumentation.appliedCount += 1;

    const facade = ctx.ast;
    if (!facade) {
      // Cordis guarantees inject satisfaction before apply — this is a
      // fail-closed assertion, not a fallback.
      throw new Error("EchoAgent applied without an ast service");
    }

    // The facade the agent holds. After revocation this reference goes
    // stale, but it must still be denied by the Kernel on every call.
    instrumentation.facade = facade;

    // Cordis effect: body runs now, returned function is the cleanup that
    // executes when the fiber unloads (UNLOADING → PENDING).
    ctx.effect(() => () => {
      instrumentation.cleanupCount += 1;
    });

    // One synthetic unit of work through the full syscall path.
    void facade.query({ query: "echo-ping" }).then(
      (result) => {
        instrumentation.lastEcho = result;
      },
      (err: unknown) => {
        instrumentation.echoError = String(err);
      },
    );
  };

  // Coeffect declaration: this fiber is only eligible to be ACTIVE when the
  // `ast` service is available in its context.
  echoAgent.inject = ["ast"];

  return echoAgent;
}
