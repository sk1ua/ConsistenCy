/**
 * WorkflowRuntimeEventStore tests — H11 (persisted execution events).
 *
 *   TEST E1  persistence round-trip: events + transactional run-state updates
 *            written to a file database survive close/reopen (simulated
 *            restart) and read back in seq order, schema-conformant.
 *   TEST E2  seq ordering: per-run monotonic append under interleaved writes
 *            across two runs; unknown run reads as empty.
 *   TEST E3  redaction: suspected token/key material is redacted BEFORE it
 *            reaches the database (checked via raw SQL against payload_json,
 *            not just the read API).
 *   TEST E4  transaction atomicity: a failing event write rolls back the
 *            coupled run-state update (no half-updated run row), and a
 *            failing run-state update appends no orphan event.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executionLifecycleEventSchema } from "@consistency/schema";
import { openDatabase, type ConsistencyDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { WorkflowRuntimeStore } from "./store";
import { WorkflowRuntimeEventStore } from "./eventStore";

const TMP_DIRS: string[] = [];
const OPEN_DBS: ConsistencyDatabase[] = [];
afterEach(() => {
  // Close every handle first — Windows refuses to delete locked files. Tests
  // may already have closed a handle (simulated restart), so tolerate that.
  for (const database of OPEN_DBS.splice(0)) {
    try {
      database.close();
    } catch {
      // Already closed by the test itself.
    }
  }
  for (const dir of TMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeFileDatabase(): { databasePath: string; database: ConsistencyDatabase } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wfevt-"));
  TMP_DIRS.push(dir);
  const databasePath = path.join(dir, "events.db");
  const database = openDatabase(databasePath);
  runMigrations(database);
  OPEN_DBS.push(database);
  return { databasePath, database };
}

function makeMemoryDatabase(): ConsistencyDatabase {
  const database = openDatabase(":memory:");
  runMigrations(database);
  OPEN_DBS.push(database);
  return database;
}

const RUN_INPUT = {
  runId: "wfrun_test-0001",
  definitionId: "def-mini-review",
  revisionId: "wfrev_test-1",
  origin: "builtin" as const,
  status: "running" as const,
  repository: "test/fixture-canonical",
  headSha: "a".repeat(40),
  createdAt: "2026-01-01T00:00:00.000Z",
  evidence: [] as unknown[],
};

describe("WorkflowRuntimeEventStore (H11)", () => {
  it("TEST E1: persists events durably, survives a simulated restart, and reads back in seq order", () => {
    const { databasePath, database } = makeFileDatabase();
    const store = new WorkflowRuntimeStore(database);
    const events = new WorkflowRuntimeEventStore(database);

    events.recordEvent(
      {
        eventType: "run_started",
        runId: RUN_INPUT.runId,
        correlationId: RUN_INPUT.runId,
        payload: { trigger: { source: "manual" } },
      },
      { applyRunUpdate: () => store.insertRun(RUN_INPUT) },
    );
    events.recordEvent({
      eventType: "step_started",
      runId: RUN_INPUT.runId,
      correlationId: RUN_INPUT.runId,
      stepId: "analyze",
      attemptNumber: 1,
      payload: { serviceRef: "deterministic-evidence.analyzer" },
    });
    events.recordEvent(
      {
        eventType: "run_succeeded",
        runId: RUN_INPUT.runId,
        correlationId: RUN_INPUT.runId,
      },
      {
        applyRunUpdate: () =>
          store.updateRunTerminal({
            runId: RUN_INPUT.runId,
            status: "succeeded",
            finishedAt: "2026-01-01T00:01:00.000Z",
            evidence: [],
          }),
      },
    );

    database.close();

    // Simulated process restart: reopen the same file, migrations no-op.
    const reopened = openDatabase(databasePath);
    OPEN_DBS.push(reopened);
    expect(runMigrations(reopened)).toEqual([]);
    const reopenedEvents = new WorkflowRuntimeEventStore(reopened);
    const readBack = reopenedEvents.listEvents(RUN_INPUT.runId);

    expect(readBack.map((event) => event.eventType)).toEqual([
      "run_started",
      "step_started",
      "run_succeeded",
    ]);
    expect(readBack.map((event) => event.seq)).toEqual([1, 2, 3]);
    // Every persisted row conforms to the shared lifecycle event schema.
    for (const event of readBack) {
      expect(() =>
        executionLifecycleEventSchema.parse({
          eventId: event.eventId,
          correlationId: event.correlationId,
          runId: event.runId,
          ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
          ...(event.attemptNumber === undefined ? {} : { attemptNumber: event.attemptNumber }),
          ...(event.fromState === undefined ? {} : { fromState: event.fromState }),
          toState: event.toState,
          ...(event.terminalReason === undefined ? {} : { terminalReason: event.terminalReason }),
          timestamp: event.timestamp,
          ...(event.error === undefined ? {} : { error: event.error }),
          payload: event.payload,
        }),
      ).not.toThrow();
    }
    // Lifecycle projection derives from event_type.
    expect(readBack[0]).toMatchObject({ toState: "running" });
    expect(readBack[0]!.fromState).toBeUndefined();
    expect(readBack[0]!.terminalReason).toBeUndefined();
    expect(readBack[2]).toMatchObject({ fromState: "running", toState: "succeeded", terminalReason: "completed" });
    expect(readBack[1]).toMatchObject({ stepId: "analyze", attemptNumber: 1 });

    // The coupled run-state updates are durable too.
    const reopenedStore = new WorkflowRuntimeStore(reopened);
    expect(reopenedStore.getRun(RUN_INPUT.runId)?.status).toBe("succeeded");
  });

  it("TEST E2: appends seq monotonically per run under interleaved writes", () => {
    const database = makeMemoryDatabase();
    const store = new WorkflowRuntimeStore(database);
    const events = new WorkflowRuntimeEventStore(database);
    store.insertRun({ ...RUN_INPUT, runId: "wfrun_a" });
    store.insertRun({ ...RUN_INPUT, runId: "wfrun_b" });

    // Appends interleave across runs; seq must stay per-run monotonic and
    // listEvents must return the append order.
    events.recordEvent({ eventType: "run_started", runId: "wfrun_a", correlationId: "wfrun_a" });
    events.recordEvent({ eventType: "run_started", runId: "wfrun_b", correlationId: "wfrun_b" });
    events.recordEvent({
      eventType: "step_started", runId: "wfrun_a", correlationId: "wfrun_a",
      stepId: "analyze", attemptNumber: 1,
    });
    events.recordEvent({
      eventType: "step_failed", runId: "wfrun_b", correlationId: "wfrun_b",
      stepId: "verify", attemptNumber: 1, error: "verifier failed",
    });
    events.recordEvent({
      eventType: "step_succeeded", runId: "wfrun_a", correlationId: "wfrun_a",
      stepId: "analyze", attemptNumber: 1,
    });

    const runA = events.listEvents("wfrun_a");
    const runB = events.listEvents("wfrun_b");
    expect(runA.map((event) => [event.seq, event.eventType])).toEqual([
      [1, "run_started"],
      [2, "step_started"],
      [3, "step_succeeded"],
    ]);
    expect(runB.map((event) => [event.seq, event.eventType])).toEqual([
      [1, "run_started"],
      [2, "step_failed"],
    ]);
    expect(runB[1]!.error).toBe("verifier failed");
    expect(runB[1]!.toState).toBe("failed");
    expect(events.countEvents("wfrun_a")).toBe(3);
    expect(events.countEvents("wfrun_b")).toBe(2);
    // Unknown run reads as empty (ordered query API stays total).
    expect(events.listEvents("wfrun_missing")).toEqual([]);
  });

  it("TEST E3: redacts suspected token/key strings before they reach the database", () => {
    const database = makeMemoryDatabase();
    const store = new WorkflowRuntimeStore(database);
    const events = new WorkflowRuntimeEventStore(database);
    store.insertRun({ ...RUN_INPUT, runId: "wfrun_redact" });

    const syntheticToken = "ghp_" + "F".repeat(36);
    events.recordEvent({
      eventType: "step_failed",
      runId: "wfrun_redact",
      correlationId: "wfrun_redact",
      stepId: "analyze",
      attemptNumber: 1,
      error: "request failed: Authorization: Bearer sk-abcdefghijklmnopqrstuvwx",
      payload: {
        apiKey: "sk-abcdefghijklmnopqrstuvwx",
        nested: { accessToken: syntheticToken, note: "plain" },
        detail: "failed to fetch https://user:secret@example.com/api token=" + syntheticToken,
      },
    });

    const [event] = events.listEvents("wfrun_redact");
    expect(event).toBeDefined();
    // Sensitive keys are redacted as values; safe keys survive.
    expect(event!.payload.apiKey).toBe("[REDACTED]");
    expect((event!.payload.nested as Record<string, unknown>).accessToken).toBe("[REDACTED]");
    expect((event!.payload.nested as Record<string, unknown>).note).toBe("plain");
    // Credential-shaped strings and URL userinfo never survive...
    const detail = String(event!.payload.detail);
    expect(detail).not.toContain("ghp_");
    expect(detail).not.toContain("user:secret");
    expect(detail).toContain("https://example.com/api");
    // ...including the error string carried under the reserved payload key —
    // asserted by safety properties (the repo's shared sanitizer replaces
    // "Authorization: Bearer" and token material; see redact.test.ts).
    expect(event!.error).not.toContain("sk-");
    expect(event!.error).not.toContain("Bearer");
    expect(event!.error).toContain("[REDACTED]");
    expect(event!.payload.error).toBe(event!.error);

    // The row ON DISK is already redacted — redaction happens before persistence.
    const raw = database
      .prepare("SELECT payload_json FROM workflow_runtime_events WHERE run_id = ?")
      .get("wfrun_redact") as { payload_json: string };
    expect(raw.payload_json).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(raw.payload_json).not.toContain(syntheticToken);
    expect(raw.payload_json).not.toContain("user:secret");
    expect(raw.payload_json).toContain("[REDACTED]");
  });

  it("TEST E4a: a failing event write rolls back the coupled run-state update", () => {
    const database = makeMemoryDatabase();
    const store = new WorkflowRuntimeStore(database);
    const events = new WorkflowRuntimeEventStore(database);
    store.insertRun({ ...RUN_INPUT, runId: "wfrun_atomic" });

    // The payload poisons the append AFTER the run-state update has already
    // executed inside the same transaction — the whole transaction must roll
    // back, leaving the existing run row untouched.
    const poison = {
      get nested(): Record<string, unknown> {
        throw new Error("payload enumeration failure");
      },
    };
    expect(() =>
      events.recordEvent(
        { eventType: "run_succeeded", runId: "wfrun_atomic", correlationId: "wfrun_atomic", payload: poison },
        {
          applyRunUpdate: () =>
            store.updateRunTerminal({
              runId: "wfrun_atomic",
              status: "succeeded",
              finishedAt: "2026-01-01T00:02:00.000Z",
              evidence: [],
            }),
        },
      ),
    ).toThrow();

    const run = store.getRun("wfrun_atomic");
    expect(run?.status).toBe("running");
    expect(run?.finishedAt).toBeUndefined();
    expect(events.countEvents("wfrun_atomic")).toBe(0);
  });

  it("TEST E4b: a failing run-state update appends no orphan event", () => {
    const database = makeMemoryDatabase();
    const store = new WorkflowRuntimeStore(database);
    const events = new WorkflowRuntimeEventStore(database);
    store.insertRun({ ...RUN_INPUT, runId: "wfrun_atomic2" });

    expect(() =>
      events.recordEvent(
        { eventType: "run_succeeded", runId: "wfrun_ghost", correlationId: "wfrun_ghost" },
        {
          applyRunUpdate: () =>
            store.updateRunTerminal({
              runId: "wfrun_ghost",
              status: "succeeded",
              finishedAt: "2026-01-01T00:03:00.000Z",
              evidence: [],
            }),
        },
      ),
    ).toThrowError(/not found/i);

    // No event for the missing run — and no event for anyone else either.
    expect(events.countEvents("wfrun_ghost")).toBe(0);
    expect(events.countEvents("wfrun_atomic2")).toBe(0);
    expect(store.getRun("wfrun_atomic2")?.status).toBe("running");
  });
});
