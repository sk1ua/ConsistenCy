/**
 * Completion sink + outbox tests — H15.
 *
 *   TEST S1  idempotency: a duplicate terminal trigger enqueues nothing and
 *            never sends a second notification.
 *   TEST S2  receiver errors don't lose the task: non-2xx keeps the row
 *            persistent under bounded exponential backoff; exhaustion
 *            settles it in `failed` with a sanitized, locally visible error.
 *   TEST S3  recovery replay: after an outage passes, the pending notice is
 *            delivered exactly once on the next trigger.
 *   TEST S4  redaction end-to-end: stored payload, wire payload, and
 *            recorded errors carry no secrets; the bearer credential never
 *            appears in the outbox and is sent only in the Authorization
 *            header when explicitly configured.
 *   TEST S5  durability: a pending notice survives a process restart
 *            (file database, close + reopen) and is replayed once.
 *   TEST S6  failure containment + stop: sink errors never throw out of
 *            recordTerminal; stop() halts new drains without losing rows.
 *   TEST S7  configuration gate: the feature exists only with an explicit
 *            destination; blank config stays off and production requires HTTPS.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../config/env";
import { openDatabase, type ConsistencyDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { CompletionOutboxStore } from "./store";
import { CompletionSink, type CompletionDeliverer, type CompletionDeliveryOutcome, type CompletionDeliveryRequest } from "./sink";

const TMP_DIRS: string[] = [];
const OPEN_DBS: ConsistencyDatabase[] = [];
afterEach(() => {
  for (const database of OPEN_DBS.splice(0)) {
    try {
      database.close();
    } catch {
      // Already closed by the test itself.
    }
  }
  TMP_DIRS.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
});

function makeMemoryDatabase(): ConsistencyDatabase {
  const database = openDatabase(":memory:");
  runMigrations(database);
  OPEN_DBS.push(database);
  return database;
}

function makeFileDatabase(): { databasePath: string; database: ConsistencyDatabase } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-cmpl-"));
  TMP_DIRS.push(dir);
  const database = openDatabase(path.join(dir, "completion.db"));
  runMigrations(database);
  OPEN_DBS.push(database);
  return { databasePath: path.join(dir, "completion.db"), database };
}

function makeClock(start = Date.parse("2026-09-26T00:00:00.000Z")) {
  let current = start;
  return {
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    advance: (ms: number) => { current += ms; },
  };
}

/** Recording deliverer; scripts map call index → outcome (default: ok). */
function makeDeliverer(scripts: CompletionDeliveryOutcome[] = []): {
  deliverer: CompletionDeliverer;
  requests: CompletionDeliveryRequest[];
  outcomes: CompletionDeliveryOutcome[];
} {
  const requests: CompletionDeliveryRequest[] = [];
  const outcomes: CompletionDeliveryOutcome[] = [];
  const deliverer: CompletionDeliverer = async (request) => {
    requests.push(request);
    const outcome = scripts[requests.length - 1] ?? { ok: true } as CompletionDeliveryOutcome;
    outcomes.push(outcome);
    return outcome;
  };
  return { deliverer, requests, outcomes };
}

function successfulSink(database: ConsistencyDatabase, clock = makeClock(), overrides: Record<string, unknown> = {}) {
  const store = new CompletionOutboxStore(database);
  const { deliverer, requests } = makeDeliverer();
  const sink = new CompletionSink({
    store,
    destination: { url: "https://supervisor.example.invalid/hook" },
    deliver: deliverer,
    now: clock.now,
    ...overrides,
  });
  return { store, sink, requests, clock };
}

function terminalInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: "wfrun_test-0001",
    status: "succeeded" as const,
    finishedAt: "2026-09-26T00:01:00.000Z",
    evidence: [{ id: "wfev_0", path: "src/a.ts", fingerprint: "fp0" }],
    miniReport: {
      definitionId: "def-mini-review",
      repository: "test/fixture-canonical",
      headSha: "b".repeat(40),
      evidenceCount: 1,
      findings: [],
    },
    ...overrides,
  };
}

async function drainMicrotasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe("CompletionSink (H15)", () => {
  it("TEST S1: duplicate terminal triggers enqueue once and notify once", async () => {
    const { database } = makeFileDatabase();
    const { store, sink, requests, clock } = successfulSink(database);

    const first = sink.recordTerminal(terminalInput());
    expect(first.enqueued).toBe(true);
    // A duplicate terminal trigger for the same run (e.g. the host's
    // defensive fallback path) derives the SAME idempotency key.
    const duplicate = sink.recordTerminal(terminalInput());
    expect(duplicate.enqueued).toBe(false);

    await sink.flushOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.idempotencyKey).toBe("completion:wfrun_test-0001:1");
    expect(store.stats()).toMatchObject({ delivered: 1, pending: 0, retrying: 0, failed: 0 });

    // Repeating the terminal event later still never re-notifies.
    clock.advance(60_000);
    sink.recordTerminal(terminalInput());
    await sink.flushOnce();
    expect(requests).toHaveLength(1);
  });

  it("TEST S2: receiver errors keep the task; bounded backoff then visible failure", async () => {
    const { database } = makeFileDatabase();
    const store = new CompletionOutboxStore(database);
    const clock = makeClock();
    const { deliverer, requests } = makeDeliverer([
      { ok: false, status: 500, error: "completion destination responded with HTTP 500" },
      { ok: false, status: 500, error: "completion destination responded with HTTP 500" },
      { ok: false, status: 503, error: "completion destination responded with HTTP 503" },
      { ok: false, status: 500, error: "completion destination responded with HTTP 500" },
      { ok: false, status: 500, error: "completion destination responded with HTTP 500" },
    ]);
    const sink = new CompletionSink({
      store,
      destination: { url: "https://supervisor.example.invalid/hook" },
      deliver: deliverer,
      now: clock.now,
    });

    sink.recordTerminal(terminalInput());

    // Attempt 1 fails → retrying, next attempt after base backoff (1s).
    const first = await sink.flushOnce();
    expect(first).toMatchObject({ attempted: 1, delivered: 0, retried: 1, failed: 0 });
    expect(store.stats()).toMatchObject({ retrying: 1 });

    // Backoff gate: an immediate re-flush must NOT touch the destination.
    const gated = await sink.flushOnce();
    expect(gated.attempted).toBe(0);
    expect(requests).toHaveLength(1);

    // Attempt 2 after 1s → next backoff 2s; attempt 3 after 2s → 4s;
    // attempt 4 after 4s → 8s; attempt 5 after 8s exhausts the budget.
    clock.advance(1_000);
    await sink.flushOnce();
    expect(requests).toHaveLength(2);
    clock.advance(2_000);
    await sink.flushOnce();
    expect(requests).toHaveLength(3);
    clock.advance(4_000);
    await sink.flushOnce();
    expect(requests).toHaveLength(4);
    clock.advance(8_000);
    const last = await sink.flushOnce();
    expect(last).toMatchObject({ attempted: 1, failed: 1 });

    // Bounded: settled as failed with a sanitized error — visible locally.
    expect(requests).toHaveLength(5);
    expect(store.stats()).toMatchObject({ failed: 1, retrying: 0, delivered: 0 });
    const failures = store.listFailures(10);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.attemptCount).toBe(5);
    expect(failures[0]!.lastError).toContain("HTTP 500");
    // Exhausted rows are never re-sent.
    clock.advance(10 * 60_000);
    await sink.flushOnce();
    expect(requests).toHaveLength(5);
  });

  it("TEST S3: after an outage passes, the pending notice is delivered exactly once", async () => {
    const { database } = makeFileDatabase();
    const store = new CompletionOutboxStore(database);
    const clock = makeClock();
    const { deliverer, requests } = makeDeliverer([
      { ok: false, error: "fetch failed: network unreachable" },
    ]);
    const sink = new CompletionSink({
      store,
      destination: { url: "https://supervisor.example.invalid/hook" },
      deliver: deliverer,
      now: clock.now,
    });

    // Network down: the terminal notice stays persisted, not lost.
    sink.recordTerminal(terminalInput());
    await sink.flushOnce();
    expect(store.stats()).toMatchObject({ retrying: 1 });
    expect(requests[0]!.idempotencyKey).toBe("completion:wfrun_test-0001:1");

    // Connectivity restored + the next trigger (any later event or explicit
    // flush) → the backlog is re-sent and delivered once.
    clock.advance(1_000);
    const replay = await sink.flushOnce();
    expect(replay).toMatchObject({ delivered: 1 });
    expect(store.stats()).toMatchObject({ delivered: 1, retrying: 0 });
    const keys = requests.map(request => request.idempotencyKey);
    expect(keys.filter(key => key === "completion:wfrun_test-0001:1")).toHaveLength(2); // 1 failed try + 1 recovery send
    expect(new Set(keys)).toEqual(new Set(["completion:wfrun_test-0001:1"]));

    // Delivered rows are never claimed again.
    clock.advance(60_000);
    await sink.flushOnce();
    expect(requests).toHaveLength(2);
  });

  it("TEST S4: payload and errors are redacted end-to-end; credential only in the header", async () => {
    const { database } = makeFileDatabase();
    const store = new CompletionOutboxStore(database);
    const clock = makeClock();
    const secretError = "provider failed: Authorization: Bearer sk-probe-aaaaaaaaaaaaaaaaaaaa at D:\\Users\\dev\\proj\\src\\a.ts";
    const { deliverer, requests } = makeDeliverer([
      { ok: false, error: `connection refused for ${secretError}` },
    ]);
    const token = "sup3rs3cretbearertoken";
    const sink = new CompletionSink({
      store,
      destination: { url: "https://supervisor.example.invalid/hook", token },
      deliver: deliverer,
      now: clock.now,
    });

    sink.recordTerminal(terminalInput({ status: "failed", error: secretError }));
    await sink.flushOnce();

    // Wire surface: credential present ONLY in the Authorization header.
    expect(requests[0]!.token).toBe(token);
    const wirePayload = JSON.parse(requests[0]!.payload);
    expect(requests[0]!.payload).not.toContain(token);
    expect(wirePayload.error).not.toContain("sk-probe-aaaaaaaaaaaaaaaaaaaa");
    expect(wirePayload.error).not.toContain("D:\\Users\\dev");
    expect(wirePayload.error).toContain("[REDACTED]");

    // Persisted surface (raw SQL): no secret, no credential anywhere.
    const rows = database.prepare("SELECT payload_json, last_error FROM completion_outbox").all() as Array<{ payload_json: string; last_error: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload_json).not.toContain(token);
    expect(rows[0]!.payload_json).toContain("[REDACTED]");
    expect(rows[0]!.last_error).not.toContain(token);
    expect(rows[0]!.last_error).toContain("[REDACTED]");

    // Without a configured credential no Authorization header surface exists.
    const anonymous = successfulSink(database, clock);
    anonymous.sink.recordTerminal(terminalInput({ runId: "wfrun_test-0002" }));
    await anonymous.sink.flushOnce();
    expect("token" in anonymous.requests[0]!).toBe(false);
  });

  it("TEST S5: a pending notice survives a process restart and replays once", async () => {
    const { databasePath, database } = makeFileDatabase();
    const clock = makeClock();
    const down = makeDeliverer([{ ok: false, error: "network unreachable" }]);
    const firstSink = new CompletionSink({
      store: new CompletionOutboxStore(database),
      destination: { url: "https://supervisor.example.invalid/hook" },
      deliver: down.deliverer,
      now: clock.now,
    });
    firstSink.recordTerminal(terminalInput());
    await firstSink.flushOnce();
    database.close();

    // Simulated restart: reopen the same file, migrations no-op, and the
    // one-shot startup recovery replay delivers the backlog.
    const reopened = openDatabase(databasePath);
    OPEN_DBS.push(reopened);
    expect(runMigrations(reopened)).toEqual([]);
    clock.advance(1_000);
    const replay = makeDeliverer();
    const recoverySink = new CompletionSink({
      store: new CompletionOutboxStore(reopened),
      destination: { url: "https://supervisor.example.invalid/hook" },
      deliver: replay.deliverer,
      now: clock.now,
    });
    const summary = await recoverySink.flushOnce();
    expect(summary).toMatchObject({ delivered: 1 });
    expect(replay.requests).toHaveLength(1);
    expect(replay.requests[0]!.idempotencyKey).toBe("completion:wfrun_test-0001:1");
    expect(recoverySink.status().outbox).toMatchObject({ delivered: 1, failed: 0 });
  });

  it("TEST S6: recordTerminal never throws on store failure and stop() halts drains", async () => {
    const { database } = makeFileDatabase();
    const store = new CompletionOutboxStore(database);
    const { deliverer, requests } = makeDeliverer();
    const onError = vi.fn();
    const sink = new CompletionSink({
      store,
      destination: { url: "https://supervisor.example.invalid/hook" },
      deliver: deliverer,
      now: makeClock().now,
      onError,
    });

    // Persistence failure inside the run's finalization path must not throw.
    database.close();
    expect(() => sink.recordTerminal(terminalInput())).not.toThrow();
    expect(onError).toHaveBeenCalled();
    await drainMicrotasks();
    expect(requests).toHaveLength(0);

    // stop(): no new drains after shutdown; nothing was lost silently — the
    // row stays durable for the next process's recovery replay.
    const fresh = makeMemoryDatabase();
    const freshStore = new CompletionOutboxStore(fresh);
    const stoppedSink = new CompletionSink({
      store: freshStore,
      destination: { url: "https://supervisor.example.invalid/hook" },
      deliver: deliverer,
      now: makeClock().now,
    });
    await stoppedSink.stop();
    expect(stoppedSink.recordTerminal(terminalInput({ runId: "wfrun_stopped" })).enqueued).toBe(true);
    const summary = await stoppedSink.flushOnce();
    expect(summary.attempted).toBe(0);
    expect(requests).toHaveLength(0);
    expect(freshStore.stats()).toMatchObject({ pending: 1 });
  });

  it("TEST S7: blank configuration stays off and production requires HTTPS", () => {
    const development = loadEnv({ NODE_ENV: "development" });
    expect(development.CONSISTENCY_COMPLETION_WEBHOOK_URL).toBeUndefined();

    // Explicit destination is accepted and surfaced server-side only.
    const configured = loadEnv({
      NODE_ENV: "development",
      CONSISTENCY_COMPLETION_WEBHOOK_URL: "http://127.0.0.1:9999/supervisor",
      CONSISTENCY_COMPLETION_WEBHOOK_TOKEN: "tok",
    });
    expect(configured.CONSISTENCY_COMPLETION_WEBHOOK_URL).toBe("http://127.0.0.1:9999/supervisor");
    expect(configured.CONSISTENCY_COMPLETION_WEBHOOK_TOKEN).toBe("tok");

    expect(() => loadEnv({
      NODE_ENV: "production",
      CONSISTENCY_API_TOKEN: "api-token",
      CONSISTENCY_ALLOWED_ORIGINS: "https://consistency.example",
      CONSISTENCY_COMPLETION_WEBHOOK_URL: "http://supervisor.example.invalid/hook",
    })).toThrow(/CONSISTENCY_COMPLETION_WEBHOOK_URL must use HTTPS in production/);
  });
});
