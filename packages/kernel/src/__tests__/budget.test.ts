/**
 * Budget accounting tests.
 *
 * AC verified:
 *   AC-8: After budget is exhausted, the next syscall is denied.
 *
 * Also verifies:
 *   - Two-phase reserve/commit correctly tracks in-flight reservations.
 *   - release() correctly returns reserved budget.
 *   - Concurrent reservations are all accounted for.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BudgetAccountant } from "../budget/accounting.js";
import { CapabilityBroker } from "../capability/broker.js";
import { CapabilityError } from "../capability/errors.js";
import { MemoryJournal } from "../audit/memoryJournal.js";
import { makePrincipalId } from "../identity/principal.js";
import type { Principal } from "../identity/principal.js";

const agentA: Principal = {
  id: makePrincipalId("agent", "style", "run_001"),
  kind: "agent",
  runId: "run_001",
};

const repo = { kind: "repository" as const, id: "sk1ua/ConsistenCy" };

// ---------------------------------------------------------------------------
// BudgetAccountant unit tests
// ---------------------------------------------------------------------------

describe("BudgetAccountant — two-phase reserve/commit", () => {
  it("reserve succeeds when budget is available", () => {
    const acc = new BudgetAccountant({ maxCalls: 5 });
    const result = acc.reserve({ calls: 1 });
    expect(result.ok).toBe(true);
  });

  it("reserve fails when maxCalls would be exceeded", () => {
    const acc = new BudgetAccountant({ maxCalls: 2 });
    acc.reserve({ calls: 1 });
    acc.reserve({ calls: 1 });
    const result = acc.reserve({ calls: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("calls");
  });

  it("in-flight reservations count against the limit", () => {
    const acc = new BudgetAccountant({ maxCalls: 2 });
    // Reserve 2 — both in-flight, none committed yet
    acc.reserve({ calls: 1 });
    acc.reserve({ calls: 1 });
    // 3rd must fail
    const result = acc.reserve({ calls: 1 });
    expect(result.ok).toBe(false);
  });

  it("release() returns reserved capacity", () => {
    const acc = new BudgetAccountant({ maxCalls: 1 });
    const r = acc.reserve({ calls: 1 });
    if (!r.ok) throw new Error("should have succeeded");

    // Budget exhausted
    expect(acc.reserve({ calls: 1 }).ok).toBe(false);

    // Release
    acc.release(r.reservationId);

    // Now available again
    expect(acc.reserve({ calls: 1 }).ok).toBe(true);
  });

  it("commit() moves reserved tokens into used column", () => {
    const acc = new BudgetAccountant({ maxTokens: 100 });
    const r = acc.reserve({ calls: 1, tokens: 80 });
    if (!r.ok) throw new Error("should have succeeded");

    acc.commit(r.reservationId, 60); // actual was less than reserved

    const state = acc.state();
    expect(state.usedTokens).toBe(60);
    expect(state.reservedTokens).toBe(0);
  });

  it("maxTokens budget is exhausted after commit", () => {
    const acc = new BudgetAccountant({ maxTokens: 100 });
    const r = acc.reserve({ calls: 1, tokens: 80 });
    if (!r.ok) throw new Error();
    acc.commit(r.reservationId, 80);

    // 30 more would exceed 100
    const r2 = acc.reserve({ calls: 1, tokens: 30 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("tokens");
  });

  it("bigint cost accounting does not lose precision", () => {
    const acc = new BudgetAccountant({ maxCostUsdMicros: 1_000_000n }); // 1 USD
    const r = acc.reserve({ calls: 1, costUsdMicros: 999_999n });
    if (!r.ok) throw new Error();
    acc.commit(r.reservationId, 0, 999_999n);

    // 2 micros left — 3 micros request should fail
    const r2 = acc.reserve({ calls: 1, costUsdMicros: 3n });
    expect(r2.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CapabilityBroker integration: AC-8
// ---------------------------------------------------------------------------

describe("CapabilityBroker — AC-8: budget exhaustion denies syscall", () => {
  it("denies with budget_exhausted after maxCalls consumed", () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);

    const handle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: repo,
      budget: { maxCalls: 2 },
    });

    const req = { principal: agentA, handle, action: "repo.read" as const, resource: repo };

    // Two successful calls
    broker.authorise(req);
    broker.authorise(req);

    // Third must fail
    expect(() => broker.authorise(req)).toThrow(CapabilityError);

    const denials = journal.ofType("syscall.authorised").filter(e => e.decision === "deny");
    expect(denials.at(-1)?.reason).toBe("budget_exhausted");
  });
});
