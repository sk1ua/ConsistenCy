/**
 * PR-2 vertical slice — AC-PR2-1 … AC-PR2-5.
 *
 * These tests import the REAL @consistency/kernel (CapabilityBroker,
 * SyscallGateway, CapabilityChangeBus) — there are no self-contained mock
 * authorization helpers here. The only synthetic component is the trusted
 * FakeAstService handler below the gateway, exactly as designed.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  CapabilityBroker,
  CapabilityChangeBus,
  CapabilityError,
  MemoryJournal,
  makePrincipalId,
  type ASTResource,
  type Principal,
} from "@consistency/kernel";
import {
  HarnessRuntime,
} from "../index.js";
import {
  getFakeAstInvocationCount,
  resetFakeAstInvocationCount,
} from "../service/fake-ast.js";

// Cordis FiberState (cordis 4): PENDING=0, LOADING=1, ACTIVE=2,
// FAILED=3, DISPOSED=4, UNLOADING=5. Literals avoid const-enum runtime issues.
const FIBER_PENDING = 0;
const FIBER_ACTIVE = 2;

const agentA: Principal = {
  id: makePrincipalId("agent", "echo-a", "run_1"),
  kind: "agent",
  runId: "run_1",
};

const snapshot: ASTResource = { kind: "ast", snapshotId: "snapshot-test-1" };

function makeHarness() {
  const journal = new MemoryJournal();
  const bus = new CapabilityChangeBus();
  const broker = new CapabilityBroker(journal, Date.now, bus);
  const runtime = new HarnessRuntime({ broker, bus });
  return { journal, bus, broker, runtime };
}

/** Let pending microtasks / cordis propagation settle deterministically. */
function flushTicks(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

describe("PR-2 vertical slice — Kernel Capability → Cordis Coeffect → Fiber Lifecycle", () => {
  beforeEach(() => {
    resetFakeAstInvocationCount();
  });

  it("AC-PR2-1: without a capability/service, the agent fiber is not ACTIVE", () => {
    const { runtime } = makeHarness();
    const agent = runtime.attachAgent(agentA);

    expect(agent.fiber.state).toBe(FIBER_PENDING);
    expect(agent.instrumentation.appliedCount).toBe(0);
    expect(agent.instrumentation.cleanupCount).toBe(0);
    expect(agent.instrumentation.lastEcho).toBeUndefined();
    expect(agent.instrumentation.echoError).toBeUndefined();
  });

  it("AC-PR2-2: granting a capability makes the service available and the fiber ACTIVE", async () => {
    const { runtime } = makeHarness();
    const agent = runtime.attachAgent(agentA);

    runtime.issueAstCapability(agent, snapshot);
    await agent.fiber;

    expect(agent.fiber.state).toBe(FIBER_ACTIVE);
    expect(agent.instrumentation.appliedCount).toBe(1);
    // The service is available through the agent's own scoped context.
    expect(agent.ctx.ast).toBe(agent.instrumentation.facade);

    // The apply-time echo proves the full path was reachable.
    await flushTicks();
    expect(agent.instrumentation.lastEcho).toEqual({
      matched: "echo:echo-ping",
      engine: "fake-ast",
    });
    expect(agent.instrumentation.echoError).toBeUndefined();
  });

  it("AC-PR2-3: a facade call goes through the real SyscallGateway and Kernel authorization before the handler runs", async () => {
    const { journal, runtime } = makeHarness();
    const agent = runtime.attachAgent(agentA);
    runtime.issueAstCapability(agent, snapshot);
    await agent.fiber;
    await flushTicks();

    // One echo already ran through the full path at apply time.
    expect(getFakeAstInvocationCount()).toBe(1);

    // Direct agent-facing call: same path, deterministic trusted result.
    const result = await agent.instrumentation.facade!.query({ query: "direct" });
    expect(result).toEqual({ matched: "echo:direct", engine: "fake-ast" });
    expect(getFakeAstInvocationCount()).toBe(2);

    // The Kernel audited real allow decisions for ast.query.
    const allows = journal
      .ofType("syscall.authorised")
      .filter((e) => e.decision === "allow" && e.action === "ast.query");
    expect(allows.length).toBeGreaterThanOrEqual(2);
  });

  it("AC-PR2-4: a stale facade is DENIED by the Kernel immediately on revocation, before Cordis propagation", async () => {
    const { journal, runtime } = makeHarness();
    const agent = runtime.attachAgent(agentA);
    const handle = runtime.issueAstCapability(agent, snapshot);
    await agent.fiber;
    await flushTicks();

    const staleFacade = agent.instrumentation.facade!;
    const handlerCountBefore = getFakeAstInvocationCount();

    // Revoke at the Kernel. Propagation to Cordis is deferred (microtask).
    runtime.revokeCapability(handle);

    // The fiber is STILL ACTIVE — Cordis has not cleaned up yet.
    expect(agent.fiber.state).toBe(FIBER_ACTIVE);

    // The stale facade call must be denied by the Kernel NOW.
    let denyReason: string | undefined;
    try {
      await staleFacade.query({ query: "stale-after-revoke" });
    } catch (err) {
      denyReason = (err as CapabilityError).reason;
    }
    expect(denyReason).toBe("revoked");

    // The trusted handler was NEVER invoked for the denied call.
    expect(getFakeAstInvocationCount()).toBe(handlerCountBefore);

    // The Kernel audited the denial with the precise reason.
    const denies = journal
      .ofType("syscall.authorised")
      .filter((e) => e.decision === "deny" && e.reason === "revoked");
    expect(denies.length).toBe(1);
  });

  it("AC-PR2-5: after revocation propagation, the fiber cleanup runs and returns to PENDING", async () => {
    const { runtime } = makeHarness();
    const agent = runtime.attachAgent(agentA);
    const handle = runtime.issueAstCapability(agent, snapshot);
    await agent.fiber;
    await flushTicks();
    expect(agent.instrumentation.cleanupCount).toBe(0);

    runtime.revokeCapability(handle);
    await runtime.flushPropagation();

    expect(agent.fiber.state).toBe(FIBER_PENDING);
    expect(agent.instrumentation.cleanupCount).toBe(1);
    expect(agent.instrumentation.appliedCount).toBe(1);
  });
});
