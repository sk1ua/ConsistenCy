/**
 * Wave 3 / R3 — ONE authoritative run-terminal mapping.
 *
 * The defect this file pins down: `EVENT_LIFECYCLE` hardcoded every
 * `run_failed` to `failed` / `fatal_error`, while the run row carried the
 * refined lifecycle. A cancelled, timed-out, budget-exhausted, degraded or
 * restart-interrupted run therefore read back from the ledger with a reason it
 * never had — the event projection conflicted with the run row.
 *
 * Contract under test (four faces must agree for every terminal class):
 *   1. the persisted run row (raw SQL, including the 0028 `terminal_detail`);
 *   2. the durable ledger event read back through listEvents;
 *   3. the API DTOs (`getRun` + the events page the HTTP layer parses);
 *   4. the shared timeline projection (`projectWorkflowRunTimeline`, the exact
 *      function the Web client rebuilds from the same events).
 *
 * Plus: repeated terminal writes are idempotent, a conflicting verdict is
 * refused with a typed 409, and a late `succeeded` never reverses an
 * already-recorded terminal state.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectRunTerminal,
  projectWorkflowRunTimeline,
  workflowRuntimeRunEventsPageSchema,
  type ExecutionLifecycleState,
  type TerminalReason,
  type TokenUsage,
} from "@consistency/schema";
import type { TrustedLLMBackend } from "@consistency/workload-review";
import { WORKFLOW_RUNTIME_BUILTIN_METADATA } from "./definition";
import type { WorkflowExecutorLlmEntry } from "./executor";
import { WorkflowRuntimeHost, type WorkflowRepositoryResolver } from "./host";
import { WorkflowRuntimeStore, WorkflowRuntimeStoreError } from "./store";
import { WorkflowRuntimeEventStore } from "./eventStore";
import { WorkflowRuntimeCheckpointStore } from "./checkpointStore";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import type { ConsistencyDatabase } from "../db/connection";

const TMP_DIRS: string[] = [];
afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MODEL_DEFINITION_ID = "verified-model-review";
const MODEL_REVISION_ID = WORKFLOW_RUNTIME_BUILTIN_METADATA[MODEL_DEFINITION_ID]!.revisionId;
const MINI_REVIEW_ID = "verified-mini-review";
const MINI_REVIEW_REVISION_ID = WORKFLOW_RUNTIME_BUILTIN_METADATA[MINI_REVIEW_ID]!.revisionId;

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeFixtureRepo(): { repoPath: string; headSha: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wf-terminal-"));
  TMP_DIRS.push(repoPath);
  git(repoPath, ["init", "-q"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repoPath, "src", "index.ts"),
    [
      "export function wide(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}  ",
      "export const fine = 1;",
    ].join("\n"),
    "utf8",
  );
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", "fixture"]);
  return { repoPath, headSha: git(repoPath, ["rev-parse", "HEAD"]) };
}

function resolverFor(repoPath: string, repositoryId = "repo-fixture"): WorkflowRepositoryResolver {
  return (id) =>
    id === repositoryId
      ? {
          status: "ok",
          binding: { repositoryId, displayName: "Fixture Local Repo", remoteFullName: "test/fixture-canonical", localPath: repoPath },
        }
      : undefined;
}

function makeModelBackend(options: { readonly mode: "valid" | "invalid" } = { mode: "valid" }): {
  readonly entry: WorkflowExecutorLlmEntry;
  readonly calls: { count: number };
} {
  const calls = { count: 0 };
  const usage: TokenUsage = { inputTokens: 12, outputTokens: 34, totalTokens: 46 };
  const backend = {
    invokeStructured: async (request: { userPrompt: string; signal?: AbortSignal }) => {
      calls.count += 1;
      if (request.signal?.aborted) throw request.signal.reason ?? new Error("aborted before dispatch");
      if (options.mode === "invalid") return { data: { totally: "not the schema" }, tokenUsage: usage };
      const fingerprints = [...request.userPrompt.matchAll(/"fingerprint":"([0-9a-f]{64})"/g)].map((match) => match[1]!);
      return {
        data: {
          findings: fingerprints.map((fingerprint) => ({ evidenceFingerprint: fingerprint, verdict: "confirmed", note: "模型复核确认该证据成立" })),
          summary: "所有证据均被模型复核确认",
        },
        tokenUsage: usage,
      };
    },
    invokeAgentFindings: async () => ({ findings: [] }),
    invokeText: async () => ({ text: "ok" }),
  } as unknown as TrustedLLMBackend;
  return { entry: { provider: "mock", model: "mock-fixture", backend }, calls };
}

interface Rig {
  readonly database: ConsistencyDatabase;
  readonly store: WorkflowRuntimeStore;
  readonly eventStore: WorkflowRuntimeEventStore;
  readonly checkpointStore: WorkflowRuntimeCheckpointStore;
  host(options?: {
    readonly modelBackend?: () => Promise<WorkflowExecutorLlmEntry>;
    readonly resolver?: WorkflowRepositoryResolver;
  }): WorkflowRuntimeHost;
}

function makeRig(): Rig {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const store = new WorkflowRuntimeStore(database);
  const eventStore = new WorkflowRuntimeEventStore(database);
  const checkpointStore = new WorkflowRuntimeCheckpointStore(database);
  return {
    database,
    store,
    eventStore,
    checkpointStore,
    host(options = {}): WorkflowRuntimeHost {
      const host = new WorkflowRuntimeHost({
        store,
        eventStore,
        checkpointStore,
        resolveRepository: options.resolver ?? (() => undefined),
        ...(options.modelBackend === undefined ? {} : { modelBackend: options.modelBackend }),
      });
      host.initialize();
      return host;
    },
  };
}

async function waitForTerminal(host: WorkflowRuntimeHost, runId: string, timeoutMs = 30_000): Promise<NonNullable<ReturnType<WorkflowRuntimeHost["getRun"]>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = host.getRun(runId);
    if (run && run.status !== "running") return run;
    if (Date.now() > deadline) throw new Error("run did not reach a terminal state in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function rawRunRow(database: ConsistencyDatabase, runId: string): {
  status: string;
  lifecycle_state: string | null;
  terminal_reason: string | null;
  terminal_detail: string | null;
  finished_at: string | null;
} {
  return database
    .prepare("SELECT status, lifecycle_state, terminal_reason, terminal_detail, finished_at FROM workflow_runtime_runs WHERE id = ?")
    .get(runId) as { status: string; lifecycle_state: string | null; terminal_reason: string | null; terminal_detail: string | null; finished_at: string | null };
}

/** The four faces of one terminal verdict, asserted together. */
function expectFourFaces(
  rig: Rig,
  host: WorkflowRuntimeHost,
  runId: string,
  expected: {
    readonly status: "succeeded" | "failed";
    readonly lifecycleState: ExecutionLifecycleState;
    readonly terminalReason: TerminalReason;
    readonly storedTerminalReason: string | null;
    readonly storedTerminalDetail: string | null;
  },
): void {
  // 1. the persisted run row
  expect(rawRunRow(rig.database, runId)).toEqual({
    status: expected.status,
    lifecycle_state: expected.lifecycleState,
    terminal_reason: expected.storedTerminalReason,
    terminal_detail: expected.storedTerminalDetail,
    finished_at: expect.any(String),
  });
  // 2. the durable ledger event read back
  const events = rig.eventStore.listEvents(runId);
  const terminalEvent = events.find((event) => event.eventType === "run_succeeded" || event.eventType === "run_failed");
  expect(terminalEvent).toBeDefined();
  expect(terminalEvent!.toState).toBe(expected.lifecycleState);
  expect(terminalEvent!.terminalReason).toBe(expected.terminalReason);
  // The reserved lifecycle carrier never leaks into the public payload.
  expect(Object.keys(terminalEvent!.payload)).not.toContain("__workflowLifecycle");
  // 3. the API DTOs (run + the page the HTTP layer parses)
  const dto = host.getRun(runId);
  expect(dto?.status).toBe(expected.status);
  expect(dto?.lifecycleState).toBe(expected.lifecycleState);
  expect(dto?.terminalReason).toBe(expected.terminalReason);
  const page = workflowRuntimeRunEventsPageSchema.parse(host.getRunEventPage(runId));
  expect(page.run).toMatchObject({
    status: expected.status,
    lifecycleState: expected.lifecycleState,
    terminalReason: expected.terminalReason,
  });
  expect(page.terminal).toBe(true);
  // 4. the shared timeline projection (the Web client rebuilds from these bytes)
  const timeline = projectWorkflowRunTimeline(page.run, page.events);
  expect(timeline.run.lifecycleState).toBe(expected.lifecycleState);
  expect(timeline.run.terminalReason).toBe(expected.terminalReason);
  expect(timeline.terminal).toBe(true);
}

describe("Wave3 R3 — the five terminal classes agree across run row / ledger / API / timeline", () => {
  it("R3-mapping: projectRunTerminal is the single mapping for all five classes", () => {
    const cases: readonly (readonly [ExecutionLifecycleState, TerminalReason | undefined, string, TerminalReason, string])[] = [
      ["succeeded", undefined, "succeeded", "completed", "run_succeeded"],
      ["cancelled", undefined, "failed", "user_cancelled", "run_failed"],
      ["failed", "timeout", "failed", "timeout", "run_failed"],
      ["failed", "quota_exceeded", "failed", "quota_exceeded", "run_failed"],
      ["degraded", undefined, "failed", "degraded_coverage", "run_failed"],
      ["degraded", "result_unavailable", "failed", "result_unavailable", "run_failed"],
      ["failed", "interrupted", "failed", "interrupted", "run_failed"],
    ];
    for (const [lifecycleState, reason, status, terminalReason, eventType] of cases) {
      const projection = projectRunTerminal({ lifecycleState, ...(reason === undefined ? {} : { terminalReason: reason }) });
      expect(projection).toEqual({ status, lifecycleState, terminalReason, eventType });
    }
    // A success can never carry a non-completed reason, and non-terminal states
    // have no terminal projection at all (fail-closed, not a silent default).
    expect(() => projectRunTerminal({ lifecycleState: "succeeded", terminalReason: "fatal_error" })).toThrow(/contradicts/);
    expect(() => projectRunTerminal({ lifecycleState: "running" })).toThrow(/not terminal/);
  });

  it("R3-a: a restart-interrupted run is interrupted everywhere — never fatal_error", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const host = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => model.entry });
    const created = await host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    await waitForTerminal(host, created.runId);

    // Controlled crash window (real SQL, as in the H14 simulations).
    rig.database
      .prepare("UPDATE workflow_runtime_runs SET status = 'running', finished_at = NULL, error = NULL, lifecycle_state = NULL, terminal_reason = NULL, terminal_detail = NULL WHERE id = ?")
      .run(created.runId);
    rig.database.prepare("DELETE FROM workflow_runtime_events WHERE run_id = ? AND event_type IN ('run_succeeded', 'run_failed')").run(created.runId);

    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => makeModelBackend().entry });
    expectFourFaces(rig, freshHost, created.runId, {
      status: "failed",
      lifecycleState: "failed",
      terminalReason: "interrupted",
      // 0027's CHECK vocabulary cannot express `interrupted`, so the precise
      // reason rides in terminal_detail — and the legacy column is NULL, NOT
      // the false `fatal_error`.
      storedTerminalReason: null,
      storedTerminalDetail: "interrupted",
    });
    const terminalEvent = rig.eventStore.listEvents(created.runId).find((event) => event.eventType === "run_failed")!;
    expect(terminalEvent.payload.reason).toBe("interrupted");
    expect(terminalEvent.payload.recoverable).toBe(true);
  });

  it("R3-b: a degraded run reads back as degraded/degraded_coverage (not failed/fatal_error)", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend({ mode: "invalid" });
    const host = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => model.entry });
    const created = await host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    const finished = await waitForTerminal(host, created.runId);
    expect(finished.lifecycleState).toBe("degraded");

    expectFourFaces(rig, host, created.runId, {
      status: "failed",
      lifecycleState: "degraded",
      terminalReason: "degraded_coverage",
      storedTerminalReason: "degraded_coverage",
      storedTerminalDetail: null,
    });
  });

  it("R3-b2: a completed run reads back as succeeded/completed on every face", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const host = rig.host({ resolver: resolverFor(fixture.repoPath) });
    const created = await host.trigger({ repositoryId: "repo-fixture", definitionId: MINI_REVIEW_ID, revisionId: MINI_REVIEW_REVISION_ID });
    await waitForTerminal(host, created.runId);
    expectFourFaces(rig, host, created.runId, {
      status: "succeeded",
      lifecycleState: "succeeded",
      terminalReason: "completed",
      storedTerminalReason: "completed",
      storedTerminalDetail: null,
    });
  });

  it("R3-c: cancelled / timeout / budget-exhausted runs keep their reason on every face", () => {
    // There is no production producer for these three classes in this ticket
    // (no workflow-run cancel/timeout/budget route exists yet), so the durable
    // write path itself is pinned here exactly as the host performs it: ONE
    // transaction, the SAME authoritative triple on both sides.
    const classes: readonly {
      readonly label: string;
      readonly lifecycleState: ExecutionLifecycleState;
      readonly terminalReason: TerminalReason;
    }[] = [
      { label: "cancel", lifecycleState: "cancelled", terminalReason: "user_cancelled" },
      { label: "timeout", lifecycleState: "failed", terminalReason: "timeout" },
      { label: "budget", lifecycleState: "failed", terminalReason: "quota_exceeded" },
    ];
    for (const entry of classes) {
      const rig = makeRig();
      const host = rig.host();
      const runId = "wfrun_" + entry.label;
      rig.store.insertRun({
        runId,
        definitionId: MINI_REVIEW_ID,
        revisionId: MINI_REVIEW_REVISION_ID,
        origin: "builtin",
        status: "running",
        repository: "test/fixture-canonical",
        headSha: "a".repeat(40),
        createdAt: new Date().toISOString(),
        evidence: [],
        lifecycleState: "running",
      });
      const projection = projectRunTerminal({ lifecycleState: entry.lifecycleState, terminalReason: entry.terminalReason });
      rig.eventStore.recordEvent(
        {
          eventType: projection.eventType,
          runId,
          correlationId: runId,
          fromState: "running",
          toState: projection.lifecycleState,
          terminalReason: projection.terminalReason,
          error: entry.label + " reason",
        },
        {
          applyRunUpdate: () => rig.store.updateRunTerminal({
            runId,
            status: projection.status,
            finishedAt: new Date().toISOString(),
            evidence: [],
            error: entry.label + " reason",
            lifecycleState: projection.lifecycleState,
            terminalReason: projection.terminalReason,
          }),
        },
      );
      expectFourFaces(rig, host, runId, {
        status: "failed",
        lifecycleState: entry.lifecycleState,
        terminalReason: entry.terminalReason,
        storedTerminalReason: entry.terminalReason,
        storedTerminalDetail: null,
      });
    }
  });

  it("R3-legacy: a pre-0027 row keeps the documented coarse fallback (no refined facts to report)", () => {
    const rig = makeRig();
    const host = rig.host();
    rig.database.prepare(`
      INSERT INTO workflow_runtime_runs
        (id, definition_id, revision_id, origin, status, repository, head_sha, created_at, finished_at, evidence_json)
      VALUES ('wfrun_legacy_row', 'verified-mini-review', 'wfrev_x', 'builtin', 'failed', 'test/repo', ?, ?, ?, '[]')
    `).run("a".repeat(40), "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:05.000Z");
    rig.eventStore.recordEvent({ eventType: "run_started", runId: "wfrun_legacy_row", correlationId: "wfrun_legacy_row" });
    const dto = host.getRun("wfrun_legacy_row");
    expect(dto?.status).toBe("failed");
    expect(dto?.lifecycleState).toBe("failed");
    expect(dto?.terminalReason).toBe("fatal_error");
  });
});

describe("Wave3 R3 — terminal writes are idempotent, conflicts are refused, late success never reverses", () => {
  it("R3-d: repeating identical terminal facts is a no-op (row + ledger stay single)", () => {
    const rig = makeRig();
    rig.store.insertRun({
      runId: "wfrun_idempotent",
      definitionId: MINI_REVIEW_ID,
      revisionId: MINI_REVIEW_REVISION_ID,
      origin: "builtin",
      status: "running",
      repository: "test/fixture-canonical",
      headSha: "a".repeat(40),
      createdAt: new Date().toISOString(),
      evidence: [],
      lifecycleState: "running",
    });
    const projection = projectRunTerminal({ lifecycleState: "degraded", terminalReason: "degraded_coverage" });
    const terminal = {
      runId: "wfrun_idempotent",
      status: projection.status,
      finishedAt: "2026-09-27T00:00:10.000Z",
      evidence: [],
      lifecycleState: projection.lifecycleState,
      terminalReason: projection.terminalReason,
      error: "degraded",
    };
    rig.store.updateRunTerminal(terminal);
    const first = rawRunRow(rig.database, "wfrun_idempotent");
    // Replay: identical facts are absorbed without error and WITHOUT rewriting
    // anything — not even the finish timestamp.
    expect(() => rig.store.updateRunTerminal({ ...terminal, finishedAt: "2026-09-27T00:00:59.000Z" })).not.toThrow();
    expect(rawRunRow(rig.database, "wfrun_idempotent")).toEqual(first);
    expect(rig.database.prepare("SELECT finished_at FROM workflow_runtime_runs WHERE id = 'wfrun_idempotent'").get())
      .toEqual({ finished_at: "2026-09-27T00:00:10.000Z" });
  });

  it("R3-e: a conflicting verdict is refused 409 and a late success cannot reverse the terminal state", () => {
    const rig = makeRig();
    rig.store.insertRun({
      runId: "wfrun_conflict",
      definitionId: MINI_REVIEW_ID,
      revisionId: MINI_REVIEW_REVISION_ID,
      origin: "builtin",
      status: "running",
      repository: "test/fixture-canonical",
      headSha: "a".repeat(40),
      createdAt: new Date().toISOString(),
      evidence: [],
      lifecycleState: "running",
    });
    // The startup scan records the interruption first.
    const interrupted = projectRunTerminal({ lifecycleState: "failed", terminalReason: "interrupted" });
    rig.eventStore.recordEvent(
      {
        eventType: interrupted.eventType,
        runId: "wfrun_conflict",
        correlationId: "wfrun_conflict",
        fromState: "running",
        toState: interrupted.lifecycleState,
        terminalReason: interrupted.terminalReason,
        error: "run interrupted by API restart",
        payload: { reason: "interrupted", recoverable: true },
      },
      {
        applyRunUpdate: () => rig.store.updateRunTerminal({
          runId: "wfrun_conflict",
          status: interrupted.status,
          finishedAt: "2026-09-27T00:01:00.000Z",
          evidence: [],
          error: "run interrupted by API restart",
          lifecycleState: interrupted.lifecycleState,
          terminalReason: interrupted.terminalReason,
        }),
      },
    );
    const before = rawRunRow(rig.database, "wfrun_conflict");
    expect(before).toEqual({ status: "failed", lifecycle_state: "failed", terminal_reason: null, terminal_detail: "interrupted", finished_at: "2026-09-27T00:01:00.000Z" });

    // A late success arrives: refused, and NOTHING is appended to the ledger.
    const eventsBefore = rig.eventStore.countEvents("wfrun_conflict");
    expect(() =>
      rig.eventStore.recordEvent(
        { eventType: "run_succeeded", runId: "wfrun_conflict", correlationId: "wfrun_conflict", fromState: "running", toState: "succeeded", terminalReason: "completed" },
        {
          applyRunUpdate: () => rig.store.updateRunTerminal({
            runId: "wfrun_conflict",
            status: "succeeded",
            finishedAt: "2026-09-27T00:02:00.000Z",
            evidence: [],
            lifecycleState: "succeeded",
            terminalReason: "completed",
          }),
        },
      ),
    ).toThrowError(/terminal/i);

    expect(rawRunRow(rig.database, "wfrun_conflict")).toEqual(before);
    expect(rig.eventStore.countEvents("wfrun_conflict")).toBe(eventsBefore);
    // A different failure is a conflict too — history is not rewritten.
    expect(() => rig.store.updateRunTerminal({
      runId: "wfrun_conflict",
      status: "failed",
      finishedAt: "2026-09-27T00:03:00.000Z",
      evidence: [],
      lifecycleState: "failed",
      terminalReason: "fatal_error",
    })).toThrowError(WorkflowRuntimeStoreError);
  });

  it("R3-f: the API surfaces the conflict as a typed 409, never as a silent rewrite", () => {
    const rig = makeRig();
    rig.store.insertRun({
      runId: "wfrun_conflict_code",
      definitionId: MINI_REVIEW_ID,
      revisionId: MINI_REVIEW_REVISION_ID,
      origin: "builtin",
      status: "running",
      repository: "test/fixture-canonical",
      headSha: "a".repeat(40),
      createdAt: new Date().toISOString(),
      evidence: [],
      lifecycleState: "running",
    });
    rig.store.updateRunTerminal({
      runId: "wfrun_conflict_code",
      status: "failed",
      finishedAt: "2026-09-27T00:00:00.000Z",
      evidence: [],
      lifecycleState: "cancelled",
      terminalReason: "user_cancelled",
    });
    let thrown: unknown;
    try {
      rig.store.updateRunTerminal({
        runId: "wfrun_conflict_code",
        status: "succeeded",
        finishedAt: "2026-09-27T00:01:00.000Z",
        evidence: [],
        lifecycleState: "succeeded",
        terminalReason: "completed",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowRuntimeStoreError);
    expect((thrown as WorkflowRuntimeStoreError).code).toBe("WORKFLOW_RUN_TERMINAL_CONFLICT");
    expect((thrown as WorkflowRuntimeStoreError).statusCode).toBe(409);
    // 取消的原因没有被覆盖成 completed.
    expect(rawRunRow(rig.database, "wfrun_conflict_code")).toEqual({
      status: "failed",
      lifecycle_state: "cancelled",
      terminal_reason: "user_cancelled",
      terminal_detail: null,
      finished_at: "2026-09-27T00:00:00.000Z",
    });
  });
});
