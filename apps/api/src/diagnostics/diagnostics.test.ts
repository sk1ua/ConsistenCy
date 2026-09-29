/**
 * H26 diagnostics tests.
 *
 *   TEST D1  aggregation correctness: latency, failures, retries, usage sums,
 *            H10 trace contexts, and cancellation timing derived from H11
 *            ledger facts (synthetic events, pure view).
 *   TEST D2  unknown stays unknown: missing usage/quota facts are reported as
 *            "unknown" with a reason — never as zero — and partial budget
 *            facts keep the missing halves absent.
 *   TEST D3  sanitized export, byte-level: the exported bundle bytes contain
 *            no credential material (sk- / ghp_ / Bearer / token) and none of
 *            the planted test secrets, through BOTH the real redaction-before-
 *            persistence ledger and a hostile run reader.
 *   TEST D4  retention cleans only its own artifacts: size/count/age limits,
 *            foreign files untouched, and deleting one run never breaks
 *            another run's shared artifact references.
 *   TEST D5  observability failure containment: throwing readers never throw
 *            out of the service (failures stay locally visible), and a
 *            diagnostics failure never breaks the HTTP pipeline (the next
 *            health request still answers).
 *
 * All tests are offline: no network, no real credentials — every secret below
 * is a planted marker value.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type ConsistencyDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { WorkflowRuntimeStore } from "../workflow-runtime/store";
import { WorkflowRuntimeEventStore } from "../workflow-runtime/eventStore";
import { createApiServer } from "../http";
import { buildRunTraceView, type DiagnosticsEventLike } from "./traceView";
import { DiagnosticsRetentionIndex } from "./retention";
import { DiagnosticsService, type DiagnosticsServiceOptions } from "./service";

const TMP_DIRS: string[] = [];
const OPEN_DBS: ConsistencyDatabase[] = [];
const SERVERS: http.Server[] = [];
afterEach(() => {
  for (const server of SERVERS.splice(0)) {
    try {
      server.close();
    } catch {
      // Already closed.
    }
  }
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

function makeMemoryDatabase(): ConsistencyDatabase {
  const database = openDatabase(":memory:");
  runMigrations(database);
  OPEN_DBS.push(database);
  return database;
}

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-diag-"));
  TMP_DIRS.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Fixtures — fixed-clock synthetic ledger events.
// ---------------------------------------------------------------------------

const T0 = "2026-01-01T00:00:00.000Z";
function at(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

function event(overrides: Partial<DiagnosticsEventLike> & { seq: number; eventType: string }): DiagnosticsEventLike {
  return {
    eventId: `wfevt_${overrides.seq}`,
    runId: "wfrun_test-0001",
    correlationId: "wfrun_test-0001",
    timestamp: at(overrides.seq * 100),
    payload: {},
    ...overrides,
  };
}

function baseRun() {
  return { runId: "wfrun_test-0001", status: "failed", createdAt: T0 };
}

// ---------------------------------------------------------------------------
// TEST D1 — aggregation correctness
// ---------------------------------------------------------------------------

describe("H26 trace view aggregation (TEST D1)", () => {
  const RUN_ID = "wfrun_test-0001";

  it("aggregates latency, failures, retries, usage, and H10 contexts from ledger facts", () => {
    const events: DiagnosticsEventLike[] = [
      event({ seq: 1, eventType: "run_started", timestamp: at(0) }),
      event({ seq: 2, eventType: "step_started", stepId: "analyze", attemptNumber: 1, timestamp: at(100), payload: { serviceRef: "deterministic-evidence.analyzer", agentId: "agent-1" } }),
      event({ seq: 3, eventType: "step_succeeded", stepId: "analyze", attemptNumber: 1, timestamp: at(300) }),
      event({ seq: 4, eventType: "step_started", stepId: "verify", attemptNumber: 1, timestamp: at(400) }),
      event({ seq: 5, eventType: "step_failed", stepId: "verify", attemptNumber: 1, timestamp: at(900), error: "fingerprint mismatch" }),
      event({ seq: 6, eventType: "run_failed", timestamp: at(1_000), error: "verify: fingerprint mismatch" }),
      // A retried step (H18-style): two attempts, second one succeeded.
      event({ seq: 7, eventType: "step_started", stepId: "report", attemptNumber: 1, timestamp: at(1_100) }),
      event({ seq: 8, eventType: "step_failed", stepId: "report", attemptNumber: 1, timestamp: at(1_200), error: "transient" }),
      event({ seq: 9, eventType: "step_started", stepId: "report", attemptNumber: 2, timestamp: at(1_300) }),
      event({ seq: 10, eventType: "step_succeeded", stepId: "report", attemptNumber: 2, timestamp: at(1_500) }),
    ];
    const view = buildRunTraceView({ run: baseRun(), events });

    // Latency: run start → terminal event.
    expect(view.latency.runStartedAt).toBe(at(0));
    expect(view.latency.runFinishedAt).toBe(at(1_000));
    expect(view.latency.totalMs).toBe(1_000);
    // Per-step durations are wall-clock spans (first start → last terminal,
    // retries included): analyze 200ms, verify 500ms, report 400ms.
    const byStep = new Map(view.latency.perStep.map((step) => [step.stepId, step]));
    expect(byStep.get("analyze")?.durationMs).toBe(200);
    expect(byStep.get("verify")?.durationMs).toBe(500);
    expect(view.latency.stepTotalMs).toBe(200 + 500 + 400);

    // Failures: verify failed terminally; report failed once but its retry
    // succeeded, so only verify counts as a failed step.
    expect(view.failures.failedStepCount).toBe(1);
    expect(view.failures.failedStepIds).toEqual(["verify"]);
    expect(view.failures.runFailed).toBe(true);
    expect(view.failures.runError).toBe("verify: fingerprint mismatch");

    // Retries: report ran twice.
    expect(view.retries.distinctSteps).toBe(3);
    expect(view.retries.totalAttempts).toBe(4);
    expect(view.retries.retriedStepCount).toBe(1);

    // Outcomes: report ultimately succeeded; verify failed; none unknown here.
    const outcomes = new Map(view.steps.map((step) => [step.stepId, step.outcome]));
    expect(outcomes.get("analyze")).toBe("succeeded");
    expect(outcomes.get("verify")).toBe("failed");
    expect(outcomes.get("report")).toBe("succeeded");

    // Usage sums: two usage facts (analyze + report attempt 1 fixture payloads below).
    const withUsage = buildRunTraceView({
      run: baseRun(),
      events: [
        event({ seq: 1, eventType: "run_started", timestamp: at(0) }),
        event({ seq: 2, eventType: "step_succeeded", stepId: "a", timestamp: at(100), payload: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }),
        event({ seq: 3, eventType: "step_succeeded", stepId: "b", timestamp: at(200), payload: { usage: { inputTokens: 30, outputTokens: 15 } } }),
      ],
    });
    expect(withUsage.usage.status).toBe("known");
    if (withUsage.usage.status === "known") {
      expect(withUsage.usage.modelCallFacts).toBe(2);
      expect(withUsage.usage.totals.inputUnits).toBe(40);
      expect(withUsage.usage.totals.outputUnits).toBe(20);
      expect(withUsage.usage.totals.totalUnits).toBe(15);
    }

    // H10 contexts: run + step + attempt contexts validate against the shared schemas.
    expect(view.correlation.runContextValidated).toBe(true);
    expect(view.correlation.correlationId).toBe(RUN_ID);
    expect(view.correlation.stepContextsValidated).toBe(3);
    expect(view.correlation.attemptContextsValidated).toBe(4);
  });

  it("derives cancellation facts (cancel id + observed wait) only when the ledger reports them", () => {
    const cancelled = buildRunTraceView({
      run: { runId: "wfrun_test-0001", status: "failed", createdAt: T0 },
      events: [
        event({ seq: 1, eventType: "run_started", timestamp: at(0) }),
        event({ seq: 2, eventType: "step_started", stepId: "analyze", attemptNumber: 1, timestamp: at(1_500) }),
        event({
          seq: 3,
          eventType: "run_failed",
          timestamp: at(2_000),
          error: "run-cancelled (cancel_abc123): Scheduler cancelled the run before agent 'analyze'",
        }),
      ],
    });
    expect(cancelled.cancellation.detected).toBe(true);
    expect(cancelled.cancellation.cancelId).toBe("cancel_abc123");
    expect(cancelled.cancellation.observedWaitMs).toBe(500);
    expect(cancelled.cancellation.waitKnown).toBe(true);

    // No cancellation facts → detected:false (never fabricated), and the
    // failed run without terminal events keeps its latency honestly unknown.
    const notCancelled = buildRunTraceView({
      run: { runId: "wfrun_test-0001", status: "running", createdAt: T0 },
      events: [event({ seq: 1, eventType: "run_started", timestamp: at(0) })],
    });
    expect(notCancelled.cancellation.detected).toBe(false);
    expect(notCancelled.cancellation.cancelId).toBeNull();
    expect(notCancelled.latency.totalMs).toBeNull();
    expect(notCancelled.unknowns.some((reason) => reason.includes("no terminal run event"))).toBe(true);
  });

  it("marks a started-but-unterminated step as outcome_unknown with an explicit resume suggestion", () => {
    const view = buildRunTraceView({
      run: { runId: "wfrun_test-0001", status: "running", createdAt: T0 },
      events: [
        event({ seq: 1, eventType: "run_started", timestamp: at(0) }),
        event({ seq: 2, eventType: "step_started", stepId: "model-verify", attemptNumber: 1, timestamp: at(100) }),
      ],
    });
    const step = view.steps.find((candidate) => candidate.stepId === "model-verify");
    expect(step?.outcome).toBe("unknown");
    expect(step?.outcomeUnknown).toBe(true);
    expect(view.unknowns.some((reason) => reason.includes("no terminal event"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEST D2 — unknown usage/quota stays unknown, never zero
// ---------------------------------------------------------------------------

describe("H26 unknown usage honesty (TEST D2)", () => {
  it("reports usage and quota as unknown with reasons when no facts exist", () => {
    const view = buildRunTraceView({
      run: baseRun(),
      events: [
        event({ seq: 1, eventType: "run_started", timestamp: at(0) }),
        event({ seq: 2, eventType: "step_succeeded", stepId: "analyze", attemptNumber: 1, timestamp: at(100) }),
      ],
    });
    expect(view.usage.status).toBe("unknown");
    if (view.usage.status === "unknown") {
      expect(view.usage.reason).toContain("no model usage facts");
      expect("totals" in view.usage).toBe(false);
    }
    expect(view.quota.status).toBe("unknown");
    if (view.quota.status === "unknown") {
      expect(view.quota.reason).toContain("unknown");
      expect("usedUnits" in view.quota).toBe(false);
      expect("limitUnits" in view.quota).toBe(false);
    }
    // The serialized view never claims a zero usage/quota anywhere.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('"inputUnits":0');
    expect(serialized).not.toContain('"outputUnits":0');
    expect(serialized).not.toContain('"totalUnits":0');
    expect(serialized).not.toContain('"usedUnits":0');
    expect(serialized).not.toContain('"limitUnits":0');
  });

  it("keeps missing halves absent when the budget ledger reports a partial snapshot", () => {
    const partial = buildRunTraceView({
      run: baseRun(),
      events: [event({ seq: 1, eventType: "run_started", timestamp: at(0) })],
      budgetUsage: { known: true, used: 42 },
    });
    expect(partial.quota.status).toBe("known");
    if (partial.quota.status === "known") {
      expect(partial.quota.usedUnits).toBe(42);
      expect("limitUnits" in partial.quota).toBe(false);
    }
    expect(partial.unknowns.some((reason) => reason.includes("partially known"))).toBe(true);

    const unknownLedger = buildRunTraceView({
      run: baseRun(),
      events: [event({ seq: 1, eventType: "run_started", timestamp: at(0) })],
      budgetUsage: { known: false, reason: "no snapshot recorded" },
    });
    expect(unknownLedger.quota.status).toBe("unknown");
  });

  it("the service surfaces the same honesty through buildTrace with no budget reader wired", () => {
    const service = new DiagnosticsService(
      { runs: { getRun: () => ({ runId: "wfrun_test-0001", status: "succeeded", createdAt: T0 }) } },
      { enabled: true },
    );
    const result = service.buildTrace("wfrun_test-0001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.trace.quota.status).toBe("unknown");
      expect(result.trace.usage.status).toBe("unknown");
    }
  });
});

// ---------------------------------------------------------------------------
// TEST D3 — sanitized export, byte-level secret assertions
// ---------------------------------------------------------------------------

const PLANTED = {
  skValue: "sk-plantsecret00112233445566778899aabbccdd",
  ghpValue: "ghp_plantsecret00112233445566778899aabbcc",
  bearerLine: "Bearer plantsecretzz001122334455",
  plainSecret: "plainplantsecret001122334455",
  authSecret: "authplantsecret001122334455",
  pathMarker: "SECRETPATHMARKER",
};

describe("H26 sanitized bundle export (TEST D3)", () => {
  function seedLedger(): { store: WorkflowRuntimeStore; events: WorkflowRuntimeEventStore } {
    const database = makeMemoryDatabase();
    const store = new WorkflowRuntimeStore(database);
    const events = new WorkflowRuntimeEventStore(database);
    store.insertRun({
      runId: "wfrun_test-0001",
      definitionId: "def-mini-review",
      revisionId: "wfrev_test-1",
      origin: "builtin",
      status: "failed",
      repository: "test/fixture-canonical",
      headSha: "a".repeat(40),
      createdAt: T0,
      finishedAt: at(5_000),
      evidence: [],
      error: `verify: credential leak ${PLANTED.bearerLine} in ${PLANTED.pathMarker}\\cfg.json`,
    });
    const record = events.recordEvent.bind(events);
    record({ eventType: "run_started", runId: "wfrun_test-0001", correlationId: "wfrun_test-0001" });
    record({
      eventType: "step_started",
      runId: "wfrun_test-0001",
      correlationId: "wfrun_test-0001",
      stepId: "analyze",
      attemptNumber: 1,
      payload: { serviceRef: "deterministic-evidence.analyzer", agentId: "agent-1", usage: { requests: 3 } },
    });
    record({ eventType: "step_succeeded", runId: "wfrun_test-0001", correlationId: "wfrun_test-0001", stepId: "analyze", attemptNumber: 1 });
    // Step whose tool call went out but never came back → outcome_unknown.
    record({
      eventType: "step_started",
      runId: "wfrun_test-0001",
      correlationId: "wfrun_test-0001",
      stepId: "model-verify",
      attemptNumber: 1,
    });
    // Failed step carrying credential-shaped material in error AND payload:
    // redaction-before-persistence must scrub these inside the ledger itself.
    record({
      eventType: "step_failed",
      runId: "wfrun_test-0001",
      correlationId: "wfrun_test-0001",
      stepId: "publish",
      attemptNumber: 1,
      error: `leak ${PLANTED.skValue} and ${PLANTED.ghpValue}`,
      payload: {
        apiKey: PLANTED.plainSecret,
        authorization: PLANTED.authSecret,
        serviceRef: "publish.verifier",
      },
    });
    record({ eventType: "run_failed", runId: "wfrun_test-0001", correlationId: "wfrun_test-0001", error: "publish: leak" });
    return { store, events };
  }

  it("exports a bundle whose bytes contain no credential material or planted secrets", () => {
    const { events } = seedLedger();
    // Hostile run reader: extra secret fields that must never reach the bundle
    // (the run-summary whitelist drops them before any sanitization).
    const hostileRunReader = {
      getRun: () => ({
        runId: "wfrun_test-0001",
        status: "failed",
        createdAt: T0,
        error: `verify: credential leak ${PLANTED.bearerLine} in D:\\${PLANTED.pathMarker}\\cfg.json`,
        accessToken: PLANTED.ghpValue,
        localPath: `D:\\${PLANTED.pathMarker}\\repo`,
      }),
      runEventsAvailable: () => true,
    };
    const service = new DiagnosticsService(
      { events, runs: hostileRunReader, outbox: { stats: () => ({ pending: 1, retrying: 0, delivered: 2, failed: 0 }) } },
      { enabled: true },
    );

    const result = service.exportRunBundle("wfrun_test-0001");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.bundle);
    const bytes = Buffer.from(serialized, "utf8");
    // Byte-level accounting: the reported size is the real serialized size.
    expect(result.bytes).toBe(bytes.length);
    expect(bytes.length).toBeGreaterThan(0);

    // 1. Credential-shaped patterns are absent from the exported bytes.
    expect(serialized.includes("sk-")).toBe(false);
    expect(serialized.includes("ghp_")).toBe(false);
    expect(serialized.includes("Bearer")).toBe(false);
    expect(/token/i.test(serialized)).toBe(false);

    // 2. Every planted test secret is absent from the exported bytes.
    for (const secret of Object.values(PLANTED)) {
      expect(serialized.includes(secret)).toBe(false);
    }

    // 3. The bundle still carries the honest diagnostics content.
    const bundle = result.bundle as Record<string, unknown>;
    expect(bundle.kind).toBe("consistency-diagnostics-bundle");
    const run = bundle.run as Record<string, unknown>;
    expect(run.runId).toBe("wfrun_test-0001");
    expect(run.status).toBe("failed");
    // Hostile extra fields never enter the summary.
    expect("accessToken" in run).toBe(false);
    expect("localPath" in run).toBe(false);
    // The run error kept its meaning but lost the credential and the path.
    expect(String(run.error)).toContain("credential leak");
    expect(String(run.error)).not.toContain("Bearer");
    expect(String(run.error)).toContain("[PATH_REDACTED]");
    // Timeline kept the clean facts and redacted the sensitive-keyed ones.
    const timeline = bundle.timeline as { events: Array<Record<string, unknown>> };
    expect(timeline.events.length).toBe(6);
    const publishEvent = timeline.events.find((item) => item.stepId === "publish");
    expect(publishEvent).toBeDefined();
    const publishPayload = publishEvent?.payload as Record<string, unknown>;
    expect(publishPayload.apiKey).toBe("[REDACTED]");
    expect(publishPayload.authorization).toBe("[REDACTED]");
    expect(publishPayload.serviceRef).toBe("publish.verifier");
    // Usage was aggregated from the clean payload fact.
    const trace = bundle.trace as { usage: { status: string; totals?: Record<string, number> } };
    expect(trace.usage.status).toBe("known");
    // outcome_unknown step surfaced with the H14-aligned recovery suggestion.
    const failedSteps = bundle.failedSteps as Array<{ stepId: string; outcome: string; recovery: { action: string } }>;
    const unknownStep = failedSteps.find((step) => step.stepId === "model-verify");
    expect(unknownStep?.outcome).toBe("unknown");
    expect(unknownStep?.recovery.action).toBe("inspect-then-resume");
    // Outbox stats rode along from the H15 reader.
    const completion = bundle.completionReporting as { available: boolean; outbox: Record<string, number> };
    expect(completion.available).toBe(true);
    expect(completion.outbox.pending).toBe(1);
    expect(completion.outbox.delivered).toBe(2);
  });

  it("answers 404 for an unknown run and 503 when both readers fail", () => {
    const database = makeMemoryDatabase();
    const events = new WorkflowRuntimeEventStore(database);
    const service = new DiagnosticsService(
      { events, runs: { getRun: () => undefined } },
      { enabled: true },
    );
    const missing = service.exportRunBundle("wfrun_does-not-exist");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("DIAGNOSTICS_RUN_NOT_FOUND");
      expect(missing.statusCode).toBe(404);
    }

    const broken = new DiagnosticsService(
      {
        events: { listEvents: () => { throw new Error("ledger exploded"); } },
        runs: { getRun: () => { throw new Error("projection exploded"); } },
      },
      { enabled: true },
    );
    const unavailable = broken.exportRunBundle("wfrun_test-0001");
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.code).toBe("DIAGNOSTICS_UNAVAILABLE");
      expect(unavailable.statusCode).toBe(503);
    }
    // The failure is locally visible, not swallowed.
    expect(broken.lastFailures().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TEST D4 — retention cleans only its own artifacts
// ---------------------------------------------------------------------------

describe("H26 retention (TEST D4)", () => {
  it("enforces count/size/age limits over module artifacts without touching foreign files", () => {
    const dir = makeTmpDir();
    // Foreign files that must NEVER be cleaned by diagnostics.
    fs.writeFileSync(path.join(dir, "review-report-final.json"), "{}", "utf8");
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep me", "utf8");

    let clock = Date.parse(T0);
    // runRow undefined + empty ledger would 404, so persistence uses a run row
    // that exists; the shared dir and clock make eviction deterministic.
    const serviceWithRun = new DiagnosticsService(
      { runs: { getRun: () => ({ runId: "wfrun_test-0001", status: "succeeded", createdAt: T0 }) } },
      {
        enabled: true,
        retention: { dir, limits: { maxFiles: 2, maxTotalBytes: 1_048_576, maxAgeMs: 3_600_000 } },
        now: () => new Date(clock),
      },
    );

    const first = serviceWithRun.persistRunBundle("wfrun_test-0001");
    expect(first.ok).toBe(true);
    clock += 1_000;
    const second = serviceWithRun.persistRunBundle("wfrun_test-0001");
    expect(second.ok).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("consistency-diagnostics-")).length).toBe(2);

    // 条数: a third bundle exceeds maxFiles=2 → the OLDEST bundle is evicted.
    clock += 1_000;
    const third = serviceWithRun.persistRunBundle("wfrun_test-0001");
    expect(third.ok).toBe(true);
    const enforcement = serviceWithRun.enforceRetention();
    expect(enforcement.ok).toBe(true);
    if (enforcement.ok) {
      expect(enforcement.summary.evictedArtifactIds.length).toBe(1);
      expect(enforcement.summary.evictedArtifactIds[0]).toBe(first.ok ? first.artifactId : undefined);
      expect(enforcement.summary.retainedFiles).toBe(2);
    }
    expect(fs.existsSync(path.join(dir, first.ok ? first.artifactId! : ""))).toBe(false);
    expect(fs.existsSync(path.join(dir, third.ok ? third.artifactId! : ""))).toBe(true);

    // Foreign files and the surviving bundles are untouched.
    expect(fs.existsSync(path.join(dir, "review-report-final.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);

    // Adoption: a module-named file placed on disk out-of-band is adopted by
    // the sweep (restart durability), while foreign names are ignored. The
    // count limit still holds afterwards (maxFiles=2 → 2 retained).
    const adoptedName = "consistency-diagnostics-bundle-adopted-123.json";
    fs.writeFileSync(path.join(dir, adoptedName), "{}", "utf8");
    const adopted = serviceWithRun.enforceRetention();
    expect(adopted.ok).toBe(true);
    if (adopted.ok) {
      expect(adopted.summary.retainedFiles).toBe(2);
    }
    expect(fs.existsSync(path.join(dir, adoptedName))).toBe(true);
    expect(serviceWithRun.retentionRecords().some((record) => record.artifactId === adoptedName)).toBe(true);
    // Foreign names are never adopted and therefore never cleaned.
    expect(fs.existsSync(path.join(dir, "review-report-final.json"))).toBe(true);
  });

  it("deleting one run never breaks another run's shared artifact references", () => {
    const index = new DiagnosticsRetentionIndex();
    const blobs = new Map<string, string>();
    const remover = (artifactId: string) => {
      if (!blobs.has(artifactId)) return false;
      blobs.delete(artifactId);
      return true;
    };
    // runA owns one bundle; runA and runB share one evidence artifact.
    index.register({ artifactId: "bundle-a", kind: "diagnostics-bundle", bytes: 10, runIds: ["runA"], remove: remover });
    index.register({ artifactId: "shared-x", kind: "diagnostics-shared", bytes: 500, runIds: ["runA", "runB"], remove: remover });
    index.register({ artifactId: "bundle-b", kind: "diagnostics-bundle", bytes: 10, runIds: ["runB"], remove: remover });
    blobs.set("bundle-a", "a");
    blobs.set("shared-x", "x");
    blobs.set("bundle-b", "b");

    const deleteA = index.deleteRun("runA");
    expect(deleteA.removedArtifactIds).toEqual(["bundle-a"]);
    expect(deleteA.retainedSharedArtifactIds).toEqual(["shared-x"]);
    // runB's references are intact: the shared artifact still exists and still lists runB.
    expect(blobs.has("shared-x")).toBe(true);
    expect(index.get("shared-x")?.runIds).toEqual(["runB"]);

    const deleteB = index.deleteRun("runB");
    expect([...deleteB.removedArtifactIds].sort()).toEqual(["bundle-b", "shared-x"]);
    expect(deleteB.retainedSharedArtifactIds).toEqual([]);
    expect(blobs.size).toBe(0);
  });

  it("evicts by age (期限) before fresher artifacts", () => {
    const index = new DiagnosticsRetentionIndex();
    const blobs = new Map<string, string>();
    const remover = (artifactId: string) => {
      blobs.delete(artifactId);
      return true;
    };
    index.register({ artifactId: "old", kind: "diagnostics-bundle", bytes: 10, createdAt: "2026-01-01T00:00:00.000Z", runIds: ["run"], remove: remover });
    index.register({ artifactId: "new", kind: "diagnostics-bundle", bytes: 10, createdAt: "2026-01-02T01:30:00.000Z", runIds: ["run"], remove: remover });
    blobs.set("old", "o");
    blobs.set("new", "n");

    const summary = index.enforce("2026-01-02T02:00:00.000Z", { maxFiles: 100, maxTotalBytes: 1_048_576, maxAgeMs: 3_600_000 });
    expect(summary.evictedArtifactIds).toEqual(["old"]);
    expect(blobs.has("old")).toBe(false);
    expect(blobs.has("new")).toBe(true);
  });

  it("the service-level deleteRun removes only the deleted run's persisted bundles", () => {
    const dir = makeTmpDir();
    let clock = Date.parse(T0);
    const mk = () => new DiagnosticsService(
      { runs: { getRun: () => ({ runId: "wfrun_test-0001", status: "succeeded", createdAt: T0 }) } },
      {
        enabled: true,
        retention: { dir, limits: { maxFiles: 100, maxTotalBytes: 1_048_576, maxAgeMs: 3_600_000 } },
        now: () => new Date((clock += 1_000)),
      },
    );
    const service = mk();
    const bundleA = service.persistRunBundle("wfrun_aaaa");
    const bundleB = service.persistRunBundle("wfrun_bbbb");
    expect(bundleA.ok && bundleB.ok).toBe(true);

    const deletion = service.deleteRun("wfrun_aaaa");
    expect(deletion.ok).toBe(true);
    if (deletion.ok) {
      expect(deletion.summary.removedArtifactIds).toEqual([bundleA.ok ? bundleA.artifactId : ""]);
      expect(deletion.summary.retainedSharedArtifactIds).toEqual([]);
    }
    expect(fs.existsSync(path.join(dir, bundleA.ok ? bundleA.artifactId! : ""))).toBe(false);
    expect(fs.existsSync(path.join(dir, bundleB.ok ? bundleB.artifactId! : ""))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEST D5 — observability failure containment
// ---------------------------------------------------------------------------

function makeServiceOptions(overrides: Partial<DiagnosticsServiceOptions> = {}): DiagnosticsServiceOptions {
  return { enabled: true, ...overrides };
}

describe("H26 failure containment (TEST D5)", () => {
  it("a throwing reader set never throws out of the service and stays locally visible", () => {
    const service = new DiagnosticsService(
      {
        events: { listEvents: () => { throw new Error("ledger down"); } },
        runs: { getRun: () => { throw new Error("projection down"); } },
        outbox: { stats: () => { throw new Error("outbox down"); } },
        budget: { runUsage: () => { throw new Error("budget down"); } },
      },
      makeServiceOptions(),
    );
    expect(() => service.exportRunBundle("wfrun_test-0001")).not.toThrow();
    expect(() => service.buildTrace("wfrun_test-0001")).not.toThrow();
    expect(() => service.enforceRetention()).not.toThrow();
    expect(() => service.deleteRun("wfrun_test-0001")).not.toThrow();
    expect(() => service.capabilities()).not.toThrow();

    const exported = service.exportRunBundle("wfrun_test-0001");
    expect(exported.ok).toBe(false);
    // Failures are recorded locally with sanitized reasons.
    const failures = service.lastFailures();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((record) => record.operation === "getRun" && record.reason.includes("projection down"))).toBe(true);
  });

  it("the HTTP pipeline survives a diagnostics defect: 500 on the broken route, health still answers", async () => {
    const { httpJson } = await import("./httpTestHelpers");
    const bombService = {
      capabilities: () => ({ enabled: true, eventLedger: true, completionOutbox: false, budgetLedger: false, retention: { dir: false, maxFiles: 0, maxTotalBytes: 0, maxAgeMs: 0 } }),
      // Contract violation on purpose: even a THROWN defect must not break the server.
      exportRunBundle: () => { throw new Error("diagnostics bomb"); },
    };
    const server = createApiServer({ apiToken: "diag-test-token-1", diagnostics: bombService as never });
    SERVERS.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });

    const broken = await httpJson(port, "GET", "/diagnostics/runs/wfrun_x/bundle", undefined, { Authorization: "Bearer diag-test-token-1" });
    expect(broken.status).toBe(500);

    // The main task is unaffected: the very next health request still answers.
    const health = await httpJson(port, "GET", "/health", undefined, { Authorization: "Bearer diag-test-token-1" });
    expect(health.status).toBe(200);
  });

  it("the export endpoint is auth-protected, honors the disabled switch, and reports absence honestly", async () => {
    const { httpJson } = await import("./httpTestHelpers");
    const database = makeMemoryDatabase();
    const events = new WorkflowRuntimeEventStore(database);
    const store = new WorkflowRuntimeStore(database);
    store.insertRun({
      runId: "wfrun_test-0001",
      definitionId: "def-mini-review",
      revisionId: "wfrev_test-1",
      origin: "builtin",
      status: "succeeded",
      repository: "test/fixture-canonical",
      headSha: "a".repeat(40),
      createdAt: T0,
      evidence: [],
    });
    events.recordEvent({ eventType: "run_started", runId: "wfrun_test-0001", correlationId: "wfrun_test-0001" });
    const disabledService = new DiagnosticsService(
      { events, runs: { getRun: () => undefined } },
      { enabled: false },
    );

    const server = createApiServer({ apiToken: "diag-test-token-2", diagnostics: disabledService });
    SERVERS.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });

    // Auth protection: no token ⇒ 401.
    const unauthenticated = await httpJson(port, "GET", "/diagnostics/runs/wfrun_test-0001/bundle");
    expect(unauthenticated.status).toBe(401);

    // Disabled switch ⇒ honest 503 availability fact, never a fake bundle.
    const disabled = await httpJson(port, "GET", "/diagnostics/runs/wfrun_test-0001/bundle", undefined, { Authorization: "Bearer diag-test-token-2" });
    expect(disabled.status).toBe(503);
    expect((disabled.body as { error?: { code?: string } }).error?.code).toBe("DIAGNOSTICS_DISABLED");
    expect(disabledService.capabilities().enabled).toBe(false);

    // No diagnostics service wired at all ⇒ same honest 503.
    const bare = createApiServer({ apiToken: "diag-test-token-3" });
    SERVERS.push(bare);
    const barePort = await new Promise<number>((resolve) => {
      bare.listen(0, "127.0.0.1", () => resolve((bare.address() as AddressInfo).port));
    });
    const absent = await httpJson(barePort, "GET", "/diagnostics/runs/wfrun_test-0001/bundle", undefined, { Authorization: "Bearer diag-test-token-3" });
    expect(absent.status).toBe(503);
    expect((absent.body as { error?: { code?: string } }).error?.code).toBe("DIAGNOSTICS_UNAVAILABLE");
  });

  it("an enabled service exports a real run end-to-end over HTTP", async () => {
    const { httpJson } = await import("./httpTestHelpers");
    const database = makeMemoryDatabase();
    const events = new WorkflowRuntimeEventStore(database);
    const store = new WorkflowRuntimeStore(database);
    store.insertRun({
      runId: "wfrun_test-0001",
      definitionId: "def-mini-review",
      revisionId: "wfrev_test-1",
      origin: "builtin",
      status: "succeeded",
      repository: "test/fixture-canonical",
      headSha: "a".repeat(40),
      createdAt: T0,
      evidence: [],
    });
    events.recordEvent({ eventType: "run_started", runId: "wfrun_test-0001", correlationId: "wfrun_test-0001" });
    events.recordEvent({
      eventType: "step_succeeded",
      runId: "wfrun_test-0001",
      correlationId: "wfrun_test-0001",
      stepId: "analyze",
      attemptNumber: 1,
      payload: { usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } },
    });
    const service = new DiagnosticsService(
      { events, runs: { getRun: runId => store.getRun(runId), runEventsAvailable: () => true } },
      makeServiceOptions(),
    );
    const server = createApiServer({ apiToken: "diag-test-token-4", diagnostics: service });
    SERVERS.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });

    const response = await httpJson(port, "GET", "/diagnostics/runs/wfrun_test-0001/bundle", undefined, { Authorization: "Bearer diag-test-token-4" });
    expect(response.status).toBe(200);
    const bundle = response.body as Record<string, unknown>;
    expect(bundle.kind).toBe("consistency-diagnostics-bundle");
    const trace = bundle.trace as { usage: { status: string; totals: Record<string, number> } };
    expect(trace.usage.status).toBe("known");
    expect(trace.usage.totals.inputUnits).toBe(7);
  });
});
