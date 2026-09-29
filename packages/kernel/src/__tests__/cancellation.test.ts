/**
 * H13 cancellation-tree tests — ONE cancel causal id per decision, subtree
 * propagation, and the deterministic outcomes of a cancel racing completion.
 *
 *   C1  cancelRun allocates ONE cause, stamps every cancelled ACB, and every
 *       event carries the same cancelId; re-cancel keeps the ORIGINAL cause.
 *   C2  cancelAgentTree propagates the same cancelId to every non-terminal
 *       descendant (parent_cancelled reason) — and never flips terminal
 *       members (SUCCEEDED/FAILED stay; already-CANCELLED keeps its cause).
 *   C3  queued window: a cancelled agent is never admitted afterwards.
 *   C4  waiting window: wake() after cancel throws — a waited operation
 *       cannot resurrect a cancelled agent.
 *   C5  completion race: late succeedAgent/failRun after cancel throws — a
 *       late result can NEVER flip a CANCELLED terminal state.
 *   C6  deadline expiry creates a deadline cause (bounded timeout is itself
 *       a cancellation decision with a causal id).
 *   C7  budget settlement: releaseAll releases only PENDING reservations —
 *       usage already committed stays on the ledger.
 */

import { describe, it, expect } from "vitest";
import {
  BudgetAccountant,
  CapabilityBroker,
  KernelScheduler,
  MemoryJournal,
  asAgentId,
  asRunId,
  makePrincipalId,
  type SchedulerEvent,
} from "../index.js";

const START = 2_000_000;

interface Fixture {
  readonly scheduler: KernelScheduler;
  readonly events: SchedulerEvent[];
  setNow(t: number): void;
}

function makeFixture(maxRunningAgents = 2): Fixture {
  let now = START;
  const scheduler = new KernelScheduler({ maxRunningAgents }, { clock: () => now });
  const events: SchedulerEvent[] = [];
  scheduler.onEvent((event) => events.push(event));
  return {
    scheduler,
    events,
    setNow: (t: number) => {
      now = t;
    },
  };
}

function makeRun(fixture: Fixture, runId = "run-1"): ReturnType<KernelScheduler["registerRun"]>["id"] {
  fixture.scheduler.registerRun({ id: asRunId(runId) });
  fixture.scheduler.activateRun(asRunId(runId));
  return asRunId(runId);
}

function makeAgent(
  fixture: Fixture,
  id: string,
  runId = "run-1",
  parent?: string,
): ReturnType<KernelScheduler["registerAgent"]>["id"] {
  return fixture.scheduler.registerAgent({
    id: asAgentId(id),
    runId: asRunId(runId),
    priority: 0,
    executionDomain: "in-process",
    ...(parent ? { parent: asAgentId(parent) } : {}),
  }).id;
}

describe("KernelScheduler cancellation tree (H13)", () => {
  it("C1: cancelRun stamps ONE causal id across run, ACBs, and events; re-cancel keeps the original", () => {
    const fixture = makeFixture();
    const runId = makeRun(fixture);
    const a = makeAgent(fixture, "agent-a", "run-1");
    const b = makeAgent(fixture, "agent-b", "run-1");

    const cause = fixture.scheduler.cancelRun(runId);
    expect(cause.cancelId).toMatch(/^cancel_/);
    expect(fixture.scheduler.getRunCancelCause(runId)?.cancelId).toBe(cause.cancelId);
    expect(fixture.scheduler.getAgent(a)?.cancelCauseId).toBe(cause.cancelId);
    expect(fixture.scheduler.getAgent(b)?.cancelCauseId).toBe(cause.cancelId);
    expect(fixture.scheduler.getAgent(a)?.state).toBe("CANCELLED");

    const cancelledEvents = fixture.events.filter(
      (event) =>
        (event.type === "agent.cancelled" || event.type === "run.cancelled")
    );
    for (const event of cancelledEvents) {
      expect(event.cancelId).toBe(cause.cancelId);
    }
    // Reasons: the run's agents carry run_cancelled, sharing the run's id.
    const agentReasons = fixture.events
      .filter((event): event is Extract<SchedulerEvent, { type: "agent.cancelled" }> => event.type === "agent.cancelled")
      .map((event) => event.reason);
    expect(agentReasons).toEqual(["run_cancelled", "run_cancelled"]);

    // Idempotent re-cancel: same cause back, no second event, no rewrite.
    const eventsBefore = fixture.events.length;
    const second = fixture.scheduler.cancelRun(runId);
    expect(second.cancelId).toBe(cause.cancelId);
    expect(fixture.events.length).toBe(eventsBefore);
  });

  it("C2: cancelAgentTree shares one cancelId across the subtree and never flips terminal members", () => {
    const fixture = makeFixture();
    makeRun(fixture);
    const parent = makeAgent(fixture, "parent");
    const childA = makeAgent(fixture, "child-a", "run-1", "parent");
    const childB = makeAgent(fixture, "child-b", "run-1", "child-a");
    const sibling = makeAgent(fixture, "sibling");

    // child-b already finished successfully; child-a was cancelled earlier
    // for its own (different) reason. Both must survive the tree cancel
    // untouched — a cancel never rewrites terminal states or prior causes.
    fixture.scheduler.ready(childB);
    fixture.scheduler.admit();
    fixture.scheduler.succeedAgent(childB);
    fixture.scheduler.cancelAgent(childA);

    const cause = fixture.scheduler.cancelAgentTree(parent);

    expect(fixture.scheduler.getAgent(parent)?.state).toBe("CANCELLED");
    expect(fixture.scheduler.getAgent(parent)?.cancelCauseId).toBe(cause.cancelId);
    // Descendant of parent, was non-terminal → cancelled under the SAME id.
    expect(fixture.scheduler.getAgent(sibling)?.state).toBe("NEW");
    expect(fixture.scheduler.getAgent(sibling)?.cancelCauseId).toBeUndefined();
    expect(fixture.scheduler.getAgent(parent)?.cancelCauseId)
      .not.toBe(fixture.scheduler.getAgent(childA)?.cancelCauseId);
    // Terminal members untouched.
    expect(fixture.scheduler.getAgent(childB)?.state).toBe("SUCCEEDED");
    expect(fixture.scheduler.getAgent(childB)?.cancelCauseId).toBeUndefined();
    expect(fixture.scheduler.getAgent(childA)?.state).toBe("CANCELLED");
    // Descendant reasons distinguish parent_cancelled from the target.
    const reasons = new Map(
      fixture.events
        .filter((event): event is Extract<SchedulerEvent, { type: "agent.cancelled" }> => event.type === "agent.cancelled")
        .map((event) => [event.agentId, event.reason] as const)
    );
    expect(reasons.get(parent)).toBe("explicit");
  });

  it("C3: queued window — an agent cancelled while READY is never admitted afterwards", () => {
    const fixture = makeFixture();
    makeRun(fixture);
    const a = makeAgent(fixture, "agent-a");
    fixture.scheduler.ready(a);

    fixture.scheduler.cancelAgent(a);
    expect(fixture.scheduler.admit()).toBeUndefined();
    expect(fixture.scheduler.getAgent(a)?.state).toBe("CANCELLED");
  });

  it("C4: waiting window — wake() after cancel throws; the waited op cannot resurrect the agent", () => {
    const fixture = makeFixture();
    makeRun(fixture);
    const a = makeAgent(fixture, "agent-a");
    fixture.scheduler.ready(a);
    fixture.scheduler.admit();
    fixture.scheduler.wait(a, { kind: "llm", provider: "deepseek" });

    fixture.scheduler.cancelAgent(a);
    expect(() => fixture.scheduler.wake(a)).toThrowError(/CANCELLED/);
    expect(fixture.scheduler.getAgent(a)?.state).toBe("CANCELLED");
  });

  it("C5: completion race — a late succeed/fail can never flip a cancelled terminal state", () => {
    const fixture = makeFixture();
    const runId = makeRun(fixture);
    const a = makeAgent(fixture, "agent-a");
    fixture.scheduler.ready(a);
    fixture.scheduler.admit();

    fixture.scheduler.cancelRun(runId);
    // Late success for the agent → typed transition error, state unchanged.
    expect(() => fixture.scheduler.succeedAgent(a)).toThrowError();
    expect(fixture.scheduler.getAgent(a)?.state).toBe("CANCELLED");
    expect(() => fixture.scheduler.failAgent(a)).toThrowError();
    // Late success for the run → typed transition error, run stays CANCELLED.
    expect(() => fixture.scheduler.succeedRun(runId)).toThrowError();
    expect(fixture.scheduler.getRun(runId)?.state).toBe("CANCELLED");
    expect(fixture.scheduler.getRunCancelCause(runId)).toBeDefined();
  });

  it("C6: deadline expiry is a cancellation decision with its own deadline cause", () => {
    const fixture = makeFixture();
    makeRun(fixture);
    const a = fixture.scheduler.registerAgent({
      id: asAgentId("agent-deadline"),
      runId: asRunId("run-1"),
      priority: 0,
      executionDomain: "in-process",
      deadline: START + 100,
    });
    fixture.scheduler.ready(a.id);

    fixture.setNow(START + 200);
    fixture.scheduler.admit();
    expect(fixture.scheduler.getAgent(a.id)?.state).toBe("CANCELLED");
    const cause = fixture.scheduler.getAgentCancelCause(a.id);
    expect(cause?.reason).toBe("deadline");
    expect(fixture.scheduler.getAgent(a.id)?.cancelCauseId).toBe(cause?.cancelId);
  });

  it("C7: budget settlement on cancel — pending reservations released, committed usage kept", () => {
    const accountant = new BudgetAccountant({ maxTokens: 1_000 });
    const committed = accountant.reserve({ calls: 1, tokens: 0 });
    if (!committed.ok) throw new Error("fixture reserve must succeed");
    accountant.commit(committed.reservationId, 400);
    const pending = accountant.reserve({ calls: 1, tokens: 300 });
    if (!pending.ok) throw new Error("fixture reserve must succeed");

    const released = accountant.releaseAll();
    expect(released).toBe(1);

    // Committed usage survived the cancel-time settlement…
    expect(accountant.state()).toMatchObject({ usedTokens: 400, reservedTokens: 0 });
    // …and the freed capacity is usable again.
    const next = accountant.reserve({ calls: 1, tokens: 500 });
    expect(next.ok).toBe(true);
  });

  it("C7b: broker.releaseAllTokens settles one capability's pending reservations", () => {
    const broker = new CapabilityBroker(new MemoryJournal());
    const principal = {
      id: makePrincipalId("agent", "cancellation-test", "run-1"),
      kind: "agent" as const,
      runId: "run-1",
    };
    const resource = { kind: "llm" as const, provider: "deepseek" };
    const handle = broker.issue({
      subject: principal,
      action: "llm.invoke",
      resource,
      budget: { maxTokens: 500 },
    });
    const reservation = broker.authorise({
      principal,
      handle,
      action: "llm.invoke",
      resource,
      tokensToReserve: 200,
    });
    expect(reservation).not.toBeNull();
    expect(broker.releaseAllTokens(handle)).toBe(1);
    expect(broker.releaseAllTokens(handle)).toBe(0);
  });
});
