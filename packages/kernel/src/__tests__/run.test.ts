/**
 * RunRegistry tests — Run lifecycle, explicit state machine, snapshot safety.
 */

import { describe, it, expect } from "vitest";
import { RunRegistry, asRunId } from "../run/registry.js";
import {
  RunStateTransitionError,
  canTransitionRun,
  transitionRun,
} from "../run/types.js";

function makeRegistry(start = 1000) {
  let now = start;
  const clock = () => now;
  const registry = new RunRegistry(clock);
  return { registry, clock, advance: (ms: number) => (now += ms) };
}

describe("RunRegistry — lifecycle", () => {
  it("creates a Run in CREATED state with budgets preserved", () => {
    const { registry } = makeRegistry();
    const run = registry.create({
      id: asRunId("run-1"),
      tokenBudget: 10_000,
      costBudgetUsdMicros: 5_000_000n,
      wallTimeBudgetMs: 60_000,
    });
    expect(run.state).toBe("CREATED");
    expect(run.tokenBudget).toBe(10_000);
    expect(run.costBudgetUsdMicros).toBe(5_000_000n);
    expect(run.wallTimeBudgetMs).toBe(60_000);
  });

  it("rejects duplicate RunId", () => {
    const { registry } = makeRegistry();
    registry.create({ id: asRunId("run-1") });
    expect(() => registry.create({ id: asRunId("run-1") })).toThrow(/already exists/);
  });

  it("rejects a deadline that is not strictly in the future", () => {
    const { registry, clock } = makeRegistry(1000);
    expect(() => registry.create({ id: asRunId("r"), deadline: clock() })).toThrow(RangeError);
    expect(() => registry.create({ id: asRunId("r2"), deadline: 999 })).toThrow(RangeError);
  });

  it("applies valid transitions and rejects invalid ones with a typed error", () => {
    const { registry } = makeRegistry();
    const id = asRunId("run-1");
    registry.create({ id });

    expect(registry.transition(id, "ACTIVE").state).toBe("ACTIVE");
    expect(registry.transition(id, "SUSPENDED").state).toBe("SUSPENDED");
    expect(registry.transition(id, "ACTIVE").state).toBe("ACTIVE");
    expect(registry.transition(id, "SUCCEEDED").state).toBe("SUCCEEDED");

    // Terminal: nothing may leave SUCCEEDED.
    for (const next of ["ACTIVE", "SUSPENDED", "CANCELLED", "FAILED"] as const) {
      expect(() => registry.transition(id, next)).toThrow(RunStateTransitionError);
    }
  });

  it("rejects skipping from CREATED directly to terminal success/failure", () => {
    const { registry } = makeRegistry();
    const id = asRunId("run-1");
    registry.create({ id });
    expect(() => registry.transition(id, "SUCCEEDED")).toThrow(RunStateTransitionError);
    expect(() => registry.transition(id, "FAILED")).toThrow(RunStateTransitionError);
    // CREATED → CANCELLED is legal (never started).
    expect(registry.transition(id, "CANCELLED").state).toBe("CANCELLED");
  });

  it("transitions to unknown Run throw", () => {
    const { registry } = makeRegistry();
    expect(() => registry.transition(asRunId("nope"), "ACTIVE")).toThrow(/Unknown Run/);
  });

  it("returns frozen snapshots; internal records never leak", () => {
    const { registry } = makeRegistry();
    const id = asRunId("run-1");
    registry.create({ id });
    const snapshot = registry.get(id)!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as { state: string }).state = "ACTIVE";
    }).toThrow(TypeError);

    // Mutating the returned snapshot must not affect the registry.
    const fresh = registry.get(id)!;
    expect(fresh.state).toBe("CREATED");
    expect(registry.list()[0]!.state).toBe("CREATED");
  });
});

describe("run/types — transition helpers", () => {
  it("canTransitionRun / transitionRun agree with the table", () => {
    expect(canTransitionRun("CREATED", "ACTIVE")).toBe(true);
    expect(canTransitionRun("ACTIVE", "CREATED")).toBe(false);
    expect(transitionRun("ACTIVE", "FAILED")).toBe("FAILED");
    expect(() => transitionRun("FAILED", "ACTIVE")).toThrow(RunStateTransitionError);
  });
});
