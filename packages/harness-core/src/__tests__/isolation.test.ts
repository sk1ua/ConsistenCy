/**
 * PR-2 isolation & denial invariants — AC-PR2-6 … AC-PR2-8.
 *
 * These prove that agent-scoped contexts are truly isolated (no global
 * service toggling), that wrong principals/actions are denied by the real
 * Kernel, and that a Cordis ACTIVE fiber grants NO authorization by itself.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  CapabilityBroker,
  CapabilityChangeBus,
  CapabilityError,
  MemoryJournal,
  SyscallGateway,
  makePrincipalId,
  type ASTResource,
  type Principal,
  type RepositoryResource,
} from "@consistency/kernel";
import {
  CapabilityBoundAstFacade,
  HarnessRuntime,
} from "../index.js";
import {
  getFakeAstInvocationCount,
  resetFakeAstInvocationCount,
} from "../service/fake-ast.js";

const FIBER_PENDING = 0;
const FIBER_ACTIVE = 2;

const agentA: Principal = {
  id: makePrincipalId("agent", "echo-a", "run_1"),
  kind: "agent",
  runId: "run_1",
};
const agentB: Principal = {
  id: makePrincipalId("agent", "echo-b", "run_1"),
  kind: "agent",
  runId: "run_1",
};

const snapshot: ASTResource = { kind: "ast", snapshotId: "snapshot-test-1" };
const repo: RepositoryResource = { kind: "repository", id: "sk1ua/ConsistenCy" };

function makeHarness() {
  const journal = new MemoryJournal();
  const bus = new CapabilityChangeBus();
  const broker = new CapabilityBroker(journal, Date.now, bus);
  const runtime = new HarnessRuntime({ broker, bus });
  return { journal, bus, broker, runtime };
}

function flushTicks(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

async function attachAndProvision(runtime: HarnessRuntime, principal: Principal) {
  const agent = runtime.attachAgent(principal);
  const handle = runtime.issueAstCapability(agent, snapshot);
  await agent.fiber;
  await flushTicks();
  return { agent, handle };
}

describe("PR-2 — multi-agent isolation and Kernel denial invariants", () => {
  beforeEach(() => {
    resetFakeAstInvocationCount();
  });

  it("AC-PR2-6: revoking Agent B never affects Agent A (no global service toggle)", async () => {
    const { runtime } = makeHarness();
    const a = await attachAndProvision(runtime, agentA);
    const b = await attachAndProvision(runtime, agentB);
    expect(a.agent.fiber.state).toBe(FIBER_ACTIVE);
    expect(b.agent.fiber.state).toBe(FIBER_ACTIVE);

    // Revoke only B's capability.
    runtime.revokeCapability(b.handle);

    // B's stale facade is denied by the Kernel…
    let bReason: string | undefined;
    try {
      await b.agent.instrumentation.facade!.query({ query: "b-after-revoke" });
    } catch (err) {
      bReason = (err as CapabilityError).reason;
    }
    expect(bReason).toBe("revoked");

    // …while A's facade still ALLOWS and executes the trusted handler.
    const aResult = await a.agent.instrumentation.facade!.query({ query: "a-still-works" });
    expect(aResult).toEqual({ matched: "echo:a-still-works", engine: "fake-ast" });

    await runtime.flushPropagation();

    // B unloaded to PENDING; A's fiber untouched and still ACTIVE.
    expect(b.agent.fiber.state).toBe(FIBER_PENDING);
    expect(b.agent.instrumentation.cleanupCount).toBe(1);
    expect(a.agent.fiber.state).toBe(FIBER_ACTIVE);
    expect(a.agent.instrumentation.cleanupCount).toBe(0);
    expect(a.agent.instrumentation.appliedCount).toBe(1);
  });

  it("AC-PR2-7: wrong principal and wrong action are denied by the Kernel, handler never invoked", async () => {
    const { broker, runtime } = makeHarness();
    const a = await attachAndProvision(runtime, agentA);
    const countBefore = getFakeAstInvocationCount();

    // --- Wrong principal: Agent B presents Agent A's capability handle. ---
    const wrongPrincipalFacade = new CapabilityBoundAstFacade({
      principal: agentB,
      handle: a.handle,
      resource: snapshot,
      gateway: new SyscallGateway(broker),
    });
    let principalReason: string | undefined;
    try {
      await wrongPrincipalFacade.query({ query: "impersonation" });
    } catch (err) {
      principalReason = (err as CapabilityError).reason;
    }
    expect(principalReason).toBe("subject_mismatch");

    // --- Wrong action: a repo.read capability cannot perform ast.query. ---
    const repoReadHandle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: repo,
    });
    let handlerInvoked = false;
    const gateway = new SyscallGateway(broker);
    let actionReason: string | undefined;
    try {
      await gateway.invoke(
        { principal: agentA, handle: repoReadHandle, action: "ast.query", resource: snapshot },
        () => {
          handlerInvoked = true;
          return { value: "should never run" };
        },
      );
    } catch (err) {
      actionReason = (err as CapabilityError).reason;
    }
    expect(actionReason).toBe("action_mismatch");
    expect(handlerInvoked).toBe(false);

    // Neither denied attempt reached the trusted handler.
    expect(getFakeAstInvocationCount()).toBe(countBefore);
  });

  it("AC-PR2-8: a Cordis ACTIVE service grants no authorization — Kernel scope still denies", async () => {
    const { runtime } = makeHarness();
    const agent = runtime.attachAgent(agentA);
    // Capability pinned to a specific SHA.
    runtime.issueAstCapability(agent, snapshot, { sha: "abc123" });
    await agent.fiber;
    await flushTicks();

    // Fiber ACTIVE, service provided — Cordis says the agent is fully eligible.
    expect(agent.fiber.state).toBe(FIBER_ACTIVE);
    expect(agent.instrumentation.facade).toBeDefined();

    // But a call that omits the pinned SHA violates the capability scope:
    // the Kernel denies it (PR-1.1 hardening) regardless of Cordis state.
    let scopeReason: string | undefined;
    try {
      await agent.instrumentation.facade!.query({ query: "no-sha" });
    } catch (err) {
      scopeReason = (err as CapabilityError).reason;
    }
    expect(scopeReason).toBe("scope_violation");

    // The fiber stays ACTIVE — a denial is not a lifecycle event.
    expect(agent.fiber.state).toBe(FIBER_ACTIVE);

    // With the correct SHA the same facade works — same capability, same
    // service, and the authorization difference is purely Kernel-side.
    const ok = await agent.instrumentation.facade!.query({ query: "with-sha", sha: "abc123" });
    expect(ok).toEqual({ matched: "echo:with-sha", engine: "fake-ast" });
  });

  it("audit journal never contains the raw capability handle", async () => {
    const { journal, runtime } = makeHarness();
    const a = await attachAndProvision(runtime, agentA);
    runtime.revokeCapability(a.handle);
    await runtime.flushPropagation();

    const serialized = JSON.stringify(journal.entries());
    expect(serialized).not.toContain(a.handle);
    expect(serialized).not.toContain("cap_");
  });
});
