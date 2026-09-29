import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type ConsistencyDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { WorkflowRuntimeEventStore } from "./eventStore";
import { WorkflowRuntimeStore, WorkflowRuntimeStoreError } from "./store";

const databases: ConsistencyDatabase[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    try { database.close(); } catch { /* already closed by restart test */ }
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeDatabase(file = false): { database: ConsistencyDatabase; filePath?: string } {
  const directory = file ? fs.mkdtempSync(path.join(os.tmpdir(), "consistency-handoff-")) : undefined;
  if (directory) directories.push(directory);
  const filePath = directory && path.join(directory, "handoffs.db");
  const database = openDatabase(filePath ?? ":memory:");
  runMigrations(database);
  databases.push(database);
  return { database, ...(filePath ? { filePath } : {}) };
}

function seedRun(database: ConsistencyDatabase, runId = "wfrun_handoff"): { store: WorkflowRuntimeStore; events: WorkflowRuntimeEventStore } {
  const store = new WorkflowRuntimeStore(database);
  const revision = store.appendRevision({
    definitionId: "handoff-fixture",
    definition: {
      id: "handoff-fixture", version: 1,
      nodes: ["parent", "child", "unrelated"].map((id) => ({
        id, type: "verifier.persisted-evidence", serviceRef: "persisted-evidence.verifier",
        parameters: {}, failurePolicy: "fail-closed" as const,
      })),
      edges: [{ from: "parent", to: "child" }],
    },
    status: "validated", validationIssues: [],
  });
  store.insertRun({
    runId, definitionId: "handoff-fixture", revisionId: revision.revisionId,
    origin: "user", status: "running", lifecycleState: "running",
    repository: "test/repo", headSha: "a".repeat(40), createdAt: new Date().toISOString(), evidence: [],
  });
  return { store, events: new WorkflowRuntimeEventStore(database) };
}

const handoff = { runId: "wfrun_handoff", parentStepId: "parent", childStepId: "child", instruction: "review-evidence" as const };
function stepEvent(events: WorkflowRuntimeEventStore, eventType: "step_started" | "step_succeeded" | "step_failed", stepId: string, runId = handoff.runId): void {
  events.recordEvent({ eventType, runId, correlationId: runId, stepId, attemptNumber: 1 });
}
function completeStep(events: WorkflowRuntimeEventStore, stepId: string, runId = handoff.runId): void {
  stepEvent(events, "step_started", stepId, runId);
  stepEvent(events, "step_succeeded", stepId, runId);
}

describe("H24 bounded durable handoffs (facts, never dispatch authority)", () => {
  it("requires a pinned validated plan, successful upstream parent, and unstarted dependent child", () => {
    const { database } = makeDatabase();
    const { store, events } = seedRun(database);
    expect(() => store.delegateHandoff(handoff)).toThrow(WorkflowRuntimeStoreError);
    completeStep(events, "parent");
    expect(() => store.delegateHandoff({ ...handoff, childStepId: "unrelated" })).toThrow(WorkflowRuntimeStoreError);
    expect(() => store.delegateHandoff({ ...handoff, parentStepId: "invented" })).toThrow(WorkflowRuntimeStoreError);
    expect(() => store.delegateHandoff({ ...handoff, runId: "wfrun_not_found" })).toThrow(WorkflowRuntimeStoreError);
    expect(() => store.delegateHandoff({ ...handoff, parentStepId: "child", childStepId: "parent" })).toThrow(WorkflowRuntimeStoreError);
    expect(database.prepare("SELECT COUNT(*) AS n FROM workflow_runtime_handoffs").get()).toEqual({ n: 0 });
    stepEvent(events, "step_started", "child");
    expect(() => store.delegateHandoff(handoff)).toThrow(WorkflowRuntimeStoreError);
  });

  it("rejects free-form secrets and paths before persistence; stores only bounded public intent codes", () => {
    const { database } = makeDatabase();
    const { store, events } = seedRun(database);
    completeStep(events, "parent");
    for (const instruction of ["api_key=not-for-storage", "C:\\Users\\Test\\private.txt", "review evidence", "x".repeat(501)]) {
      expect(() => store.delegateHandoff({ ...handoff, instruction: instruction as typeof handoff.instruction })).toThrow(WorkflowRuntimeStoreError);
    }
    expect(JSON.stringify(database.prepare("SELECT * FROM workflow_runtime_handoffs").all())).not.toContain("not-for-storage");
    expect(store.delegateHandoff(handoff)).toMatchObject({ status: "delegated" });
    expect(database.prepare("SELECT instruction FROM workflow_runtime_handoffs").get()).toEqual({ instruction: "review-evidence" });
    expect(() => store.delegateHandoff({ ...handoff, instruction: "verify-findings" })).toThrow(/identity/);
  });

  it("rejects nonexistent, draft, and mismatched pinned revisions even when a forged event claims success", () => {
    const { database } = makeDatabase();
    const { store, events } = seedRun(database);
    completeStep(events, "parent");
    database.prepare("UPDATE workflow_runtime_runs SET revision_id = ? WHERE id = ?").run("missing", handoff.runId);
    expect(() => store.delegateHandoff(handoff)).toThrow(WorkflowRuntimeStoreError);
    const wrong = store.appendRevision({
      definitionId: "another-def",
      definition: { id: "another-def", version: 1, nodes: [{
        id: "parent", type: "verifier.persisted-evidence", serviceRef: "persisted-evidence.verifier",
        parameters: {}, failurePolicy: "fail-closed",
      }], edges: [] }, status: "draft_with_issues", validationIssues: [],
    });
    database.prepare("UPDATE workflow_runtime_runs SET revision_id = ? WHERE id = ?").run(wrong.revisionId, handoff.runId);
    expect(() => store.delegateHandoff(handoff)).toThrow(WorkflowRuntimeStoreError);
    expect(database.prepare("SELECT COUNT(*) AS n FROM workflow_runtime_handoffs").get()).toEqual({ n: 0 });
  });

  it("allows at most one upstream handoff to a child step and rejects fabricated completion without dispatch intent", () => {
    const { database } = makeDatabase();
    const { store, events } = seedRun(database);
    stepEvent(events, "step_succeeded", "parent");
    expect(() => store.delegateHandoff(handoff)).toThrow(WorkflowRuntimeStoreError);
    stepEvent(events, "step_started", "parent");
    stepEvent(events, "step_succeeded", "parent");
    store.delegateHandoff(handoff);
    const other = store.appendRevision({
      definitionId: "fan-in", definition: { id: "fan-in", version: 1,
        nodes: ["parent", "other", "child"].map((id) => ({ id, type: "verifier.persisted-evidence", serviceRef: "persisted-evidence.verifier", parameters: {}, failurePolicy: "fail-closed" as const })),
        edges: [{ from: "parent", to: "child" }, { from: "other", to: "child" }],
      }, status: "validated", validationIssues: [],
    });
    database.prepare("UPDATE workflow_runtime_runs SET definition_id = ?, revision_id = ? WHERE id = ?")
      .run(other.definitionId, other.revisionId, handoff.runId);
    completeStep(events, "other");
    expect(() => store.delegateHandoff({ ...handoff, parentStepId: "other" })).toThrow(WorkflowRuntimeStoreError);
    expect(database.prepare("SELECT COUNT(*) AS n FROM workflow_runtime_handoffs").get()).toEqual({ n: 1 });
  });

  it("requires a matching latest parent attempt rather than recycling an earlier dispatch", () => {
    const { database } = makeDatabase();
    const { store, events } = seedRun(database);
    stepEvent(events, "step_started", "parent");
    events.recordEvent({ eventType: "step_succeeded", runId: handoff.runId, correlationId: handoff.runId, stepId: "parent", attemptNumber: 2 });
    expect(() => store.delegateHandoff(handoff)).toThrow(WorkflowRuntimeStoreError);
    expect(database.prepare("SELECT COUNT(*) AS n FROM workflow_runtime_handoffs").get()).toEqual({ n: 0 });
  });

  it("survives SQLite reopen; replay reports actual state, acceptance is one-shot and cannot reopen a terminal run", () => {
    const { database, filePath } = makeDatabase(true);
    const { store, events } = seedRun(database);
    completeStep(events, "parent");
    const initial = store.delegateHandoff(handoff);
    database.close();
    const reopened = openDatabase(filePath!);
    databases.push(reopened);
    expect(runMigrations(reopened)).toEqual([]);
    const restarted = new WorkflowRuntimeStore(reopened);
    expect(restarted.getHandoff(handoff)).toMatchObject({ id: initial.id, status: "delegated" });
    expect(restarted.delegateHandoff(handoff)).toMatchObject({ id: initial.id, status: "delegated" });
    expect(restarted.acceptHandoff(handoff)).toBe(true);
    expect(restarted.acceptHandoff(handoff)).toBe(false);
    expect(restarted.delegateHandoff(handoff)).toMatchObject({ id: initial.id, status: "accepted" });
    restarted.updateRunTerminal({ runId: handoff.runId, status: "failed", finishedAt: new Date().toISOString(), evidence: [], lifecycleState: "failed", terminalReason: "user_cancelled" });
    expect(restarted.acceptHandoff(handoff)).toBe(false);
    expect(() => restarted.delegateHandoff(handoff)).toThrow(WorkflowRuntimeStoreError);
    expect(restarted.getHandoff(handoff)?.status).toBe("accepted");
  });

  it("does not accept after the child starts or when the parent has a newer unfinished attempt", () => {
    const { database } = makeDatabase();
    const { store, events } = seedRun(database);
    completeStep(events, "parent");
    store.delegateHandoff(handoff);
    stepEvent(events, "step_started", "child");
    expect(store.acceptHandoff(handoff)).toBe(false);
    const second = seedRunForExistingRevision(database, "wfrun_other");
    completeStep(second.events, "parent", "wfrun_other");
    stepEvent(second.events, "step_started", "parent", "wfrun_other");
    expect(() => second.store.delegateHandoff({ ...handoff, runId: "wfrun_other" })).toThrow(WorkflowRuntimeStoreError);
  });
});

function seedRunForExistingRevision(database: ConsistencyDatabase, runId: string): { store: WorkflowRuntimeStore; events: WorkflowRuntimeEventStore } {
  const store = new WorkflowRuntimeStore(database);
  const revision = store.getLatestValidatedRevision("handoff-fixture");
  if (!revision) throw new Error("missing seeded revision");
  store.insertRun({
    runId, definitionId: "handoff-fixture", revisionId: revision.revisionId,
    origin: "user", status: "running", lifecycleState: "running", repository: "test/repo",
    headSha: "b".repeat(40), createdAt: new Date().toISOString(), evidence: [],
  });
  return { store, events: new WorkflowRuntimeEventStore(database) };
}
