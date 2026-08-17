/**
 * Agent state machine + AgentRegistry tests.
 *
 * Covers the explicit transition table (AC-SCHED-9 at the state level) and
 * the process-tree invariants: exactly-one-Run membership, cross-Run parent
 * rejection (AC-SCHED-12), self-parent/cycle rejection (AC-SCHED-13), and
 * parent/child consistency. Also proves snapshots are frozen and that
 * mutable ACB records never leak outside the Kernel.
 */

import { describe, it, expect } from "vitest";
import { AgentRegistry } from "../agent/registry.js";
import {
  AgentStateTransitionError,
  AGENT_TRANSITIONS,
  canTransitionAgent,
  transitionAgent,
} from "../agent/state.js";
import {
  AgentTreeInvariantError,
  asAgentId,
  type RegisterAgentRequest,
} from "../agent/types.js";
import { asRunId } from "../run/types.js";
import { asContextImageId } from "../identity/context-image.js";

const RUN_A = asRunId("run-a");
const RUN_B = asRunId("run-b");

function makeRegistry(start = 1000) {
  let now = start;
  const clock = () => now;
  return { registry: new AgentRegistry(clock) };
}

function request(
  overrides: Omit<Partial<RegisterAgentRequest>, "id"> & { id: string },
): RegisterAgentRequest {
  return {
    runId: RUN_A,
    priority: 0,
    executionDomain: "in-process",
    ...overrides,
    id: asAgentId(overrides.id),
  } as RegisterAgentRequest;
}

describe("agent/state — explicit transition table", () => {
  it("permits the documented transitions", () => {
    expect(canTransitionAgent("NEW", "READY")).toBe(true);
    expect(canTransitionAgent("READY", "RUNNING")).toBe(true);
    expect(canTransitionAgent("RUNNING", "WAIT_LLM")).toBe(true);
    expect(canTransitionAgent("RUNNING", "WAIT_HUMAN")).toBe(true);
    expect(canTransitionAgent("WAIT_LLM", "READY")).toBe(true);
    expect(canTransitionAgent("RUNNING", "SUCCEEDED")).toBe(true);
    expect(canTransitionAgent("RUNNING", "FAILED")).toBe(true);
    expect(canTransitionAgent("READY", "SUSPENDED")).toBe(true);
    expect(canTransitionAgent("SUSPENDED", "READY")).toBe(true);
    expect(canTransitionAgent("WAIT_TOOL", "SUSPENDED")).toBe(true);
  });

  it("rejects invalid and terminal-exit transitions with a typed error", () => {
    expect(canTransitionAgent("NEW", "RUNNING")).toBe(false);
    expect(canTransitionAgent("READY", "WAIT_LLM")).toBe(false);
    expect(canTransitionAgent("READY", "SUCCEEDED")).toBe(false);
    for (const terminal of ["SUCCEEDED", "FAILED", "CANCELLED"] as const) {
      for (const next of ["READY", "RUNNING", "WAIT_LLM", "SUSPENDED"] as const) {
        expect(canTransitionAgent(terminal, next)).toBe(false);
        expect(() => transitionAgent(terminal, next)).toThrow(AgentStateTransitionError);
      }
    }
  });

  it("exposes the complete table without holes", () => {
    for (const from of Object.keys(AGENT_TRANSITIONS) as (keyof typeof AGENT_TRANSITIONS)[]) {
      const targets = AGENT_TRANSITIONS[from];
      expect(Array.isArray(targets)).toBe(true);
      for (const to of targets) {
        expect(canTransitionAgent(from, to)).toBe(true);
      }
    }
  });
});

describe("AgentRegistry — ACB registration and tree invariants", () => {
  it("registers an Agent in state NEW with all metadata preserved", () => {
    const { registry } = makeRegistry();
    const agent = registry.register(
      request({
        id: "a",
        priority: 7,
        logicalRing: 3,
        executionDomain: "child-process",
        contextImage: asContextImageId("ctx-1"),
        capabilities: [
          { handleFingerprint: "0123456789ab", action: "ast.query", resourceKind: "ast" },
        ],
        modelPolicy: { provider: "mock", model: "m1" },
        tokenBudget: 500,
        costBudgetUsdMicros: 100n,
        wallTimeBudgetMs: 9000,
        deadline: 5000,
      }),
    );

    expect(agent.state).toBe("NEW");
    expect(agent.priority).toBe(7);
    expect(agent.executionDomain).toBe("child-process");
    expect(agent.contextImage).toBe("ctx-1");
    expect(agent.capabilities).toHaveLength(1);
    expect(agent.modelPolicy?.provider).toBe("mock");
    expect(agent.tokenBudget).toBe(500);
    expect(agent.costBudgetUsdMicros).toBe(100n);
    expect(agent.deadline).toBe(5000);
    expect(agent.children).toEqual([]);
    expect(agent.pendingOperation).toBeUndefined();
  });

  it("rejects duplicate AgentId", () => {
    const { registry } = makeRegistry();
    registry.register(request({ id: "a" }));
    expect(() => registry.register(request({ id: "a" }))).toThrow(AgentTreeInvariantError);
  });

  it("AC-SCHED-13a: rejects self-parent", () => {
    const { registry } = makeRegistry();
    expect(() => registry.register(request({ id: "a", parent: asAgentId("a") }))).toThrow(
      AgentTreeInvariantError,
    );
  });

  it("rejects unknown parent", () => {
    const { registry } = makeRegistry();
    expect(() =>
      registry.register(request({ id: "a", parent: asAgentId("ghost") })),
    ).toThrow(AgentTreeInvariantError);
  });

  it("AC-SCHED-12: rejects a child whose parent belongs to a different Run", () => {
    const { registry } = makeRegistry();
    registry.register(request({ id: "parent-in-a", runId: RUN_A }));
    expect(() =>
      registry.register(request({ id: "child-in-b", runId: RUN_B, parent: asAgentId("parent-in-a") })),
    ).toThrow(AgentTreeInvariantError);
  });

  it("AC-SCHED-13b: maintains parent/children consistency; cycles are structurally impossible", () => {
    const { registry } = makeRegistry();
    const a = registry.register(request({ id: "a" }));
    const b = registry.register(request({ id: "b", parent: asAgentId("a") }));
    const c = registry.register(request({ id: "c", parent: asAgentId("b") }));

    // Child side.
    expect(b.parent).toBe(a.id);
    expect(c.parent).toBe(b.id);
    // Parent side stays consistent (parent record was replaced, not mutated).
    expect(registry.get(a.id)!.children).toEqual([b.id]);
    expect(registry.get(b.id)!.children).toEqual([c.id]);
    expect(registry.get(c.id)!.children).toEqual([]);

    // Parent is immutable after registration: the only way to "create" a
    // cycle would be re-registering an existing id (duplicate — rejected) or
    // self-parenting (rejected above). No re-parenting API exists.
    expect(() => registry.register(request({ id: "a" }))).toThrow(AgentTreeInvariantError);
  });

  it("rejects a deadline that is not strictly in the future", () => {
    const { registry } = makeRegistry(1000);
    expect(() => registry.register(request({ id: "a", deadline: 1000 }))).toThrow(RangeError);
  });

  it("applies validated transitions and attaches/clears pendingOperation atomically", () => {
    const { registry } = makeRegistry();
    const a = registry.register(request({ id: "a" }));

    const ready = registry.transition(a.id, "READY");
    expect(ready.state).toBe("READY");

    const running = registry.transition(a.id, "RUNNING");
    expect(running.state).toBe("RUNNING");

    const waiting = registry.transition(a.id, "WAIT_LLM", {
      pendingOperation: { kind: "llm", startedAt: 1234, provider: "mock" },
    });
    expect(waiting.state).toBe("WAIT_LLM");
    expect(waiting.pendingOperation).toEqual({ kind: "llm", startedAt: 1234, provider: "mock" });

    const woken = registry.transition(a.id, "READY", { pendingOperation: undefined });
    expect(woken.state).toBe("READY");
    expect(woken.pendingOperation).toBeUndefined();

    expect(() => registry.transition(a.id, "SUCCEEDED")).toThrow(AgentStateTransitionError);
  });

  it("returns frozen snapshots — mutable ACB records never leak", () => {
    const { registry } = makeRegistry();
    const a = registry.register(
      request({
        id: "a",
        capabilities: [{ handleFingerprint: "fedcba987654", action: "repo.read", resourceKind: "repository" }],
        modelPolicy: { provider: "mock" },
      }),
    );
    registry.register(request({ id: "b", parent: a.id }));

    const snapshot = registry.get(a.id)!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.children)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities[0]!)).toBe(true);
    expect(Object.isFrozen(snapshot.modelPolicy)).toBe(true);

    expect(() => {
      (snapshot as { state: string }).state = "RUNNING";
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.children as unknown as unknown[]).push("x");
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.capabilities as unknown[]).push({});
    }).toThrow(TypeError);

    // Registry state is unaffected by any attempted external mutation.
    expect(registry.get(a.id)!.state).toBe("NEW");
    expect(registry.get(a.id)!.children).toEqual([asAgentId("b")]);
  });
});
