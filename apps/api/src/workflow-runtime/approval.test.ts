/**
 * H18 human-wait facts. Waiting is a durable row, not a timer. Expiry and a
 * second click fail closed and authorize nothing.
 */
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { WorkflowRuntimeStore, WorkflowRuntimeStoreError } from "./store";

function store(): WorkflowRuntimeStore {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const runtime = new WorkflowRuntimeStore(database);
  runtime.insertRun({
    runId: "wfrun_wait",
    definitionId: "def-wait",
    revisionId: "rev-wait",
    origin: "user",
    status: "running",
    repository: "repo/x",
    headSha: "a".repeat(40),
    createdAt: "2026-09-27T00:00:00.000Z",
    evidence: [],
  });
  return runtime;
}

describe("H18 approval persistence", () => {
  it("keeps a wait across a new store on the same database and rejects expiry plus replay", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const first = new WorkflowRuntimeStore(database);
    first.insertRun({
      runId: "wfrun_wait",
      definitionId: "def-wait",
      revisionId: "rev-wait",
      origin: "user",
      status: "running",
      repository: "repo/x",
      headSha: "a".repeat(40),
      createdAt: "2026-09-27T00:00:00.000Z",
      evidence: [],
    });
    first.requestApprovalAndWait({ runId: "wfrun_wait", stepId: "gate", expiresAt: "2026-09-27T01:00:00.000Z" });

    const restarted = new WorkflowRuntimeStore(database);
    const again = restarted.requestApproval({ runId: "wfrun_wait", stepId: "gate", expiresAt: "2026-09-27T01:00:00.000Z" });
    expect(again.expiresAt).toBe("2026-09-27T01:00:00.000Z");

    expect(() => restarted.decideApproval({
      runId: "wfrun_wait",
      stepId: "gate",
      decision: "approved",
      now: "2026-09-27T02:00:00.000Z",
    })).toThrow(WorkflowRuntimeStoreError);

    const decided = restarted.decideApproval({
      runId: "wfrun_wait",
      stepId: "gate",
      decision: "approved",
      now: "2026-09-27T00:30:00.000Z",
    });
    expect(decided.decision).toBe("approved");
    expect(() => restarted.decideApproval({
      runId: "wfrun_wait",
      stepId: "gate",
      decision: "approved",
      now: "2026-09-27T00:31:00.000Z",
    })).toThrow(/repeat click/);
  });

  it("does not let one approval authorize a different step", () => {
    const runtime = store();
    runtime.requestApprovalAndWait({ runId: "wfrun_wait", stepId: "gate", expiresAt: "2026-09-27T01:00:00.000Z" });
    runtime.decideApproval({ runId: "wfrun_wait", stepId: "gate", decision: "approved", now: "2026-09-27T00:10:00.000Z" });
    expect(() => runtime.decideApproval({
      runId: "wfrun_wait",
      stepId: "other",
      decision: "approved",
      now: "2026-09-27T00:10:00.000Z",
    })).toThrow(/No approval request/);
  });

  it("refuses a second waiting step and preserves the first decision boundary", () => {
    const runtime = store();
    runtime.requestApprovalAndWait({ runId: "wfrun_wait", stepId: "gate", expiresAt: "2026-09-27T01:00:00.000Z" });
    expect(() => runtime.requestApprovalAndWait({
      runId: "wfrun_wait", stepId: "other", expiresAt: "2026-09-27T01:00:00.000Z",
    })).toThrow(/different approval/);
    expect(runtime.getApproval("wfrun_wait", "other")).toBeUndefined();
    expect(runtime.getRun("wfrun_wait")?.error).toContain("gate");
    runtime.requestApprovalAndWait({ runId: "wfrun_wait", stepId: "gate", expiresAt: "2026-09-27T01:00:00.000Z" });
    expect(() => runtime.requestApprovalAndWait({
      runId: "wfrun_wait", stepId: "gate", expiresAt: "2026-09-27T02:00:00.000Z",
    })).toThrow(/identity does not match/);
  });

  it("atomically refuses a wait for a terminal run without leaving an approval row", () => {
    const runtime = store();
    runtime.updateRunTerminal({
      runId: "wfrun_wait", status: "failed", finishedAt: new Date().toISOString(),
      evidence: [], lifecycleState: "failed", terminalReason: "fatal_error",
    });
    expect(() => runtime.requestApprovalAndWait({
      runId: "wfrun_wait", stepId: "gate", expiresAt: "2026-09-27T01:00:00.000Z",
    })).toThrow(/not eligible/);
    expect(runtime.getApproval("wfrun_wait", "gate")).toBeUndefined();
  });

  it("refuses approval after a waiting run becomes terminal", () => {
    const runtime = store();
    runtime.requestApprovalAndWait({ runId: "wfrun_wait", stepId: "gate", expiresAt: "2026-09-27T01:00:00.000Z" });
    runtime.updateRunTerminal({
      runId: "wfrun_wait", status: "failed", finishedAt: "2026-09-27T00:05:00.000Z",
      evidence: [], lifecycleState: "failed", terminalReason: "user_cancelled",
    });
    expect(() => runtime.decideApproval({
      runId: "wfrun_wait", stepId: "gate", decision: "approved", now: "2026-09-27T00:10:00.000Z",
    })).toThrow(/not awaiting approval/);
    expect(runtime.getApproval("wfrun_wait", "gate")?.decision).toBeNull();
  });

  it("does not treat a persisted wait as an interrupted run", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const runtime = new WorkflowRuntimeStore(database);
    runtime.insertRun({
      runId: "wfrun_wait",
      definitionId: "def-wait",
      revisionId: "rev-wait",
      origin: "user",
      status: "running",
      repository: "repo/x",
      headSha: "a".repeat(40),
      createdAt: "2026-09-27T00:00:00.000Z",
      evidence: [],
    });
    runtime.requestApprovalAndWait({ runId: "wfrun_wait", stepId: "gate", expiresAt: "2026-09-27T01:00:00.000Z" });
    expect(runtime.recoverInterruptedRuns()).toBe(0);
    expect(runtime.getRun("wfrun_wait")?.status).toBe("running");
    expect(runtime.getRun("wfrun_wait")?.lifecycleState).toBe("awaiting_input");
    expect(new WorkflowRuntimeStore(database).getApproval("wfrun_wait", "gate")?.decision).toBeNull();
  });
});
