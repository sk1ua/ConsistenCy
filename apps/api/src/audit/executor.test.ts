/**
 * Audit execution bridge slice 2 — AuditRunExecutor contract tests.
 *
 *   E1  single-flight drain + fenced claim: one attempt per claimed run; an
 *       external claim wins and the executor skips it without re-executing.
 *   E2  active-run uniqueness backstop: the durable one-active-per-automation
 *       constraint still coalesces duplicate drafts even without the executor.
 *   E3  stop discipline: a stopped executor owns/cleans its timer and does not
 *       self-execute; start() is idempotent (kill switch wires this).
 *   E4  non-local repositories fail closed HONESTLY (never silently skipped):
 *       terminal failed + exact reason, zero launches.
 *   E5  launch errors are terminal with sanitized reasons (one attempt per
 *       run; absolute paths never reach execution_error).
 *   E6  terminal mirroring: the audit run tracks its linked workflow-runtime
 *       run and mirrors succeeded/failed outcomes across ticks.
 *   E7  restart honesty reconciliation matrix over legacy queued/running rows
 *       (terminal-link mirror / interrupted-without-link / unresolved link /
 *       preserving the immutable link / untouched fresh drafts).
 */

import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowSpec } from "@consistency/schema";
import { openDatabase, type ConsistencyDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { WorkflowDefinitionNotFoundError } from "../workflow-runtime/host";
import { WorkflowRuntimeStore } from "../workflow-runtime/store";
import {
  AUDIT_EXECUTION_LOCAL_REPOSITORY_REQUIRED_REASON,
  AuditRunExecutor,
  type WorkflowRuntimeRunStatusView
} from "./executor";
import { SQLiteAuditDomainStore } from "./store";

const SPEC = {
  version: 2,
  name: "vibe-safety",
  nodes: [{ id: "security", uses: "engine.security" }],
  verifiers: [{ id: "syntax-gate", uses: "verify.syntax", needs: ["security"] }],
  synthesizer: { needs: ["syntax-gate"] }
} as WorkflowSpec;

interface Rig {
  database: ConsistencyDatabase;
  store: SQLiteAuditDomainStore;
  workflowRuntimeStore: WorkflowRuntimeStore;
  repositoryIds: { local: string; remote: string };
  /** Mapped automation slots (distinct rows dodge the active-run UNIQUE). */
  localAutomations: string[];
  remoteAutomations: string[];
  workflowRevisionId: string;
  policyRevisionId: string;
}

const DATABASES: ConsistencyDatabase[] = [];
afterEach(() => {
  for (const database of DATABASES.splice(0)) database.close();
});

function makeRig(options: { localAutomations?: number; remoteAutomations?: number } = {}):
  Rig {
  const database = openDatabase(":memory:");
  DATABASES.push(database);
  runMigrations(database);
  // Mapping gate fake: createAutomation validation passes without seeding a
  // real definition row; launch behavior is exercised through test fakes.
  const store = new SQLiteAuditDomainStore(database, {
    workflowRuntime: {
      definitionExists: () => true,
      getLatestValidatedRevision: () => ({ revisionId: "rev-seed" }) as any
    }
  });
  const localRepository = store.createRepository({
    displayName: "Fixture Local",
    source: "local_git",
    monitoringEnabled: false
  }, { serverLocator: "\\\\fixture\\server\\checkout" });
  const remoteRepository = store.createRepository({
    displayName: "Fixture Remote",
    source: "github",
    remoteFullName: "owner/fixture-remote",
    monitoringEnabled: false
  });
  const workflow = store.createWorkflowRevision({ workflowId: "vibe-safety", spec: SPEC });
  const policy = store.createPolicyRevision({ policyId: "default-safety", name: "Default safety" });
  const mapDefinition = (repositoryId: string, name: string) => store.createAutomation({
    repositoryId,
    name,
    trigger: { type: "manual" },
    workflowRevisionId: workflow.id,
    policyRevisionId: policy.id,
    runtimeDefinitionId: "def-runtime-x",
    executionProfile: "static_readonly",
    enabled: true
  }).id;

  const localAutomations = Array.from(
    { length: options.localAutomations ?? 1 },
    (_, index) => mapDefinition(localRepository.id, `Mapped local ${index}`)
  );
  const remoteAutomations = Array.from(
    { length: options.remoteAutomations ?? 1 },
    (_, index) => mapDefinition(remoteRepository.id, `Mapped remote ${index}`)
  );

  return {
    database,
    store,
    workflowRuntimeStore: new WorkflowRuntimeStore(database),
    repositoryIds: { local: localRepository.id, remote: remoteRepository.id },
    localAutomations,
    remoteAutomations,
    workflowRevisionId: workflow.id,
    policyRevisionId: policy.id
  };
}

function makeDraft(rig: Rig, automationId: string) {
  const automation = rig.store.getAutomation(automationId)!;
  return rig.store.createAuditRunDraft({
    repositoryId: automation.repositoryId,
    source: "manual",
    automationId: automation.id,
    workflowRevisionId: automation.workflowRevisionId!,
    policyRevisionId: automation.policyRevisionId
  });
}

/** Deterministic linked-run view backed by a controllable table. */
function makeWorkflowRunView() {
  const rows = new Map<string, WorkflowRuntimeRunStatusView>();
  return {
    rows,
    lookup: (runId: string) => {
      const found = rows.get(runId);
      return found === undefined ? undefined : { ...found };
    }
  };
}

describe("AuditRunExecutor", () => {
  it("executes a runtime-only automation draft without consulting a legacy workflow", async () => {
    const rig = makeRig({ localAutomations: 0, remoteAutomations: 0 });
    const runtimeOnly = rig.store.createAutomation({
      repositoryId: rig.repositoryIds.local,
      name: "Runtime only",
      trigger: { type: "manual" },
      runtimeDefinitionId: "def-runtime-only",
      policyRevisionId: rig.policyRevisionId,
      executionProfile: "static_readonly",
      enabled: true
    });
    const draft = rig.store.createAuditRunDraft({
      repositoryId: rig.repositoryIds.local,
      source: "manual",
      automationId: runtimeOnly.id,
      policyRevisionId: rig.policyRevisionId
    });
    const launches: string[] = [];
    const executor = new AuditRunExecutor({
      store: rig.store,
      launch: async input => {
        launches.push(input.definitionId);
        return { runId: "wfrun_runtime_only" };
      },
      getWorkflowRuntimeRun: () => ({ status: "succeeded" }),
      batchSize: 1
    });
    await executor.tick();
    await executor.tick();
    expect(launches).toEqual(["def-runtime-only"]);
    expect(rig.store.getAuditRun(draft.id)).toMatchObject({ status: "succeeded", workflowRuntimeRunId: "wfrun_runtime_only" });
  });

  it("E1 drains drafts single-flight with fenced claims and no double execution", async () => {
    const rig = makeRig({ localAutomations: 3 });
    const draftA = makeDraft(rig, rig.localAutomations[0]!);
    const draftB = makeDraft(rig, rig.localAutomations[1]!);
    const calls: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;

    const executor = new AuditRunExecutor({
      store: rig.store,
      launch: async input => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight -= 1;
        calls.push(`${input.repositoryId}:${input.definitionId}`);
        return { runId: `wfrun_${calls.length}` };
      },
      // Linked runs stay reported running: the drain keeps them in flight and
      // nothing is ever mirrored/terminated inside the same pass here.
      getWorkflowRuntimeRun: () => ({ status: "running" }),
      batchSize: 10
    });

    // Overlapping ticks are ignored (single-flight).
    await Promise.all([executor.tick(), executor.tick()]);
    expect(calls).toHaveLength(2);
    expect(maxConcurrent).toBe(1);

    for (const draft of [draftA, draftB]) {
      const run = rig.store.getAuditRun(draft.id)!;
      expect(run.status).toBe("running");
      expect(run.workflowRuntimeRunId).toMatch(/^wfrun_/);
    }

    // Fenced claim: a run claimed elsewhere is not re-taken by this executor;
    // the recoverable sweep settles the unlinked queued orphan fail-closed.
    const externallyClaimed = makeDraft(rig, rig.localAutomations[2]!);
    rig.store.markRunQueued(externallyClaimed.id);
    await executor.tick();
    expect(calls).toHaveLength(2);
    expect(rig.store.getAuditRun(externallyClaimed.id)!.status).toBe("failed");

    // One attempt per run: settled/drained work is never retried.
    await executor.tick();
    expect(calls).toHaveLength(2);
    expect(executor.status.launchedRuns).toBe(2);
  });

  it("E2 keeps the durable one-active-per-automation backstop against duplicate drafts", () => {
    const rig = makeRig();
    makeDraft(rig, rig.localAutomations[0]!);
    try {
      makeDraft(rig, rig.localAutomations[0]!);
      throw new Error("expected AUDIT_RUN_ALREADY_ACTIVE");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("AUDIT_RUN_ALREADY_ACTIVE");
    }
  });

  it("E3 start/stop own exactly one timer and a stopped executor does not self-execute", () => {
    const rig = makeRig();
    makeDraft(rig, rig.localAutomations[0]!);
    let intervalStarted = 0;
    const clearedHandles: unknown[] = [];
    const executor = new AuditRunExecutor({
      store: rig.store,
      launch: async () => ({ runId: "wfrun_never" }),
      getWorkflowRuntimeRun: () => undefined,
      pollIntervalMs: 5_000,
      timer: {
        setInterval: callback => {
          intervalStarted += 1;
          // Never registered with a real event loop under test: the kill
          // switch contract is that stop() detaches the handle outright.
          void callback;
          return { id: intervalStarted };
        },
        clearInterval: handle => clearedHandles.push(handle)
      }
    });

    executor.start();
    expect(executor.status.running).toBe(true);
    expect(intervalStarted).toBe(1);
    executor.start(); // idempotent
    expect(intervalStarted).toBe(1);

    executor.stop();
    expect(executor.status.running).toBe(false);
    expect(clearedHandles).toEqual([{ id: 1 }]);
    // No lastPollAt exists because no tick ran while disarmed.
    expect(executor.status.lastPollAt).toBeUndefined();
  });

  it("E4 fails non-local repositories honestly instead of skipping them", async () => {
    const rig = makeRig();
    const draft = makeDraft(rig, rig.remoteAutomations[0]!);
    const failures: Array<{ runId?: string }> = [];
    const executor = new AuditRunExecutor({
      store: rig.store,
      launch: async () => {
        throw new Error("launch must never be reached for a remote repository");
      },
      getWorkflowRuntimeRun: () => undefined,
      onError: failure => failures.push(failure)
    });

    await executor.tick();

    const run = rig.store.getAuditRun(draft.id)!;
    expect(run.status).toBe("failed");
    expect(run.executionError).toBe(AUDIT_EXECUTION_LOCAL_REPOSITORY_REQUIRED_REASON);
    expect(run.workflowRuntimeRunId).toBeUndefined();
    expect(failures.map(failure => failure.runId)).toContain(draft.id);
    const events = rig.store.listRunEvents(draft.id).map(event => event.eventType);
    expect(events).toEqual(["run_queued", "run_failed"]);
  });

  it("E5 marks launch errors terminal once with sanitized reasons", async () => {
    const rig = makeRig({ localAutomations: 2 });
    const leaking = makeDraft(rig, rig.localAutomations[0]!);
    // Distinct created_at keeps the FIFO drain order deterministic.
    await new Promise(resolve => setTimeout(resolve, 4));
    const notFound = makeDraft(rig, rig.localAutomations[1]!);
    let attempt = 0;
    const executor = new AuditRunExecutor({
      store: rig.store,
      launch: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("snapshot build exploded at C:\\secret\\path\\repo.git");
        }
        throw new WorkflowDefinitionNotFoundError("def-runtime-x");
      },
      getWorkflowRuntimeRun: () => undefined,
      batchSize: 10
    });

    await executor.tick();

    const leakedRun = rig.store.getAuditRun(leaking.id)!;
    expect(leakedRun.status).toBe("failed");
    expect(leakedRun.executionError).not.toContain("C:\\secret");
    expect(leakedRun.executionError).toContain("PATH_REDACTED");

    const missingRun = rig.store.getAuditRun(notFound.id)!;
    expect(missingRun.status).toBe("failed");
    expect(missingRun.executionError).toContain("def-runtime-x");

    // One attempt per run: no retry storm.
    expect(attempt).toBe(2);
    await executor.tick();
    expect(attempt).toBe(2);
    expect(executor.status.failedRuns).toBe(2);
  });

  it("E6 mirrors the linked workflow-runtime run outcome across ticks", async () => {
    const rig = makeRig();
    const draft = makeDraft(rig, rig.localAutomations[0]!);

    const view = makeWorkflowRunView();
    view.rows.set("wfrun_mirror_1", { status: "running" });

    const executor = new AuditRunExecutor({
      store: rig.store,
      launch: async () => ({ runId: "wfrun_mirror_1" }),
      getWorkflowRuntimeRun: view.lookup
    });

    await executor.tick();
    const inFlight = rig.store.getAuditRun(draft.id)!;
    expect(inFlight.status).toBe("running");
    expect(inFlight.workflowRuntimeRunId).toBe("wfrun_mirror_1");

    // The linked run's own outcome is authoritative: failure first.
    view.rows.set("wfrun_mirror_1", { status: "failed", error: "verifier refused evidence" });
    await executor.tick();
    const failedMirror = rig.store.getAuditRun(draft.id)!;
    expect(failedMirror.status).toBe("failed");
    expect(failedMirror.executionError).toContain("wfrun_mirror_1");
    expect(failedMirror.executionError).toContain("verifier refused evidence");

    // Success mirroring on a second lifecycle of the same automation; even in
    // one pass an already-terminal link mirrors immediately.
    view.rows.set("wfrun_mirror_2", { status: "succeeded" });
    const secondDraft = makeDraft(rig, rig.localAutomations[0]!);
    const successExecutor = new AuditRunExecutor({
      store: rig.store,
      launch: async () => ({ runId: "wfrun_mirror_2" }),
      getWorkflowRuntimeRun: view.lookup
    });
    await successExecutor.tick();
    const succeeded = rig.store.getAuditRun(secondDraft.id)!;
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.workflowRuntimeRunId).toBe("wfrun_mirror_2");
    expect(successExecutor.status.mirroredSucceededRuns).toBe(1);

    const eventTypes = rig.store.listRunEvents(secondDraft.id).map(event => event.eventType);
    expect(eventTypes).toEqual(["run_queued", "run_running", "run_succeeded"]);
  });

  it("E7 reconciles legacy queued/running runs honestly at startup", () => {
    const rig = makeRig({ localAutomations: 3, remoteAutomations: 2 });
    const view = makeWorkflowRunView();

    // queued WITH a terminal link → mirrored faithfully.
    const mirrored = makeDraft(rig, rig.localAutomations[0]!);
    rig.store.markRunQueued(mirrored.id, { workflowRuntimeRunId: "wfrun_done" });
    view.rows.set("wfrun_done", { status: "succeeded" });

    // running WITHOUT a link → interrupted honestly (before it could execute).
    const orphanRunning = makeDraft(rig, rig.remoteAutomations[0]!);
    rig.store.markRunQueued(orphanRunning.id);
    rig.store.markRunRunning(orphanRunning.id);

    // queued WITH an unresolvable link → failed naming the exact missing link,
    // and the immutable link survives the honest settling.
    const unresolvedLink = makeDraft(rig, rig.localAutomations[1]!);
    rig.store.markRunQueued(unresolvedLink.id, { workflowRuntimeRunId: "wfrun_gone" });

    const lostLink = makeDraft(rig, rig.remoteAutomations[1]!);
    rig.store.markRunQueued(lostLink.id, { workflowRuntimeRunId: "wfrun_lost" });
    view.rows.delete("wfrun_lost");

    // Fresh drafts stay untouched until the normal loop claims them.
    const untouchedCreated = makeDraft(rig, rig.localAutomations[2]!);

    const executor = new AuditRunExecutor({
      store: rig.store,
      launch: async () => ({ runId: "wfrun_never_during_reconcile" }),
      getWorkflowRuntimeRun: view.lookup
    });

    const reconciled = executor.reconcileInterruptedRuns();
    expect(reconciled).toBe(4);

    expect(rig.store.getAuditRun(mirrored.id)!.status).toBe("succeeded");
    const orphaned = rig.store.getAuditRun(orphanRunning.id)!;
    expect(orphaned.status).toBe("failed");
    expect(orphaned.executionError).toContain("interrupted by API restart before it could execute");
    const unresolved = rig.store.getAuditRun(unresolvedLink.id)!;
    expect(unresolved.status).toBe("failed");
    expect(unresolved.executionError).toContain("'wfrun_gone' could not be resolved");
    expect(unresolved.workflowRuntimeRunId).toBe("wfrun_gone");
    const lost = rig.store.getAuditRun(lostLink.id)!;
    expect(lost.status).toBe("failed");
    expect(lost.executionError).toContain("'wfrun_lost' could not be resolved");
    expect(lost.workflowRuntimeRunId).toBe("wfrun_lost");

    expect(rig.store.getAuditRun(untouchedCreated.id)!.status).toBe("created");
    expect(executor.status.reconciledRuns).toBe(4);
  });
});
