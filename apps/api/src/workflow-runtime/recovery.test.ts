/**
 * H14 — checkpoint / restart-recovery tests.
 *
 *   R1  startup scan: a still-`running` run is honestly marked failed WITH
 *       its run_failed ledger event and an `interrupted` checkpoint marker;
 *       the recovery plan folds ledger + checkpoint facts (including
 *       outcome_unknown for a sent-but-unresulted step).
 *   R2  continue is BLOCKED for outcome_unknown steps (no blind replay) and
 *       `retry` stays framework-only (refused with structured blockers).
 *   R3  a corrupt checkpoint result is refused (explicit blocker, no reuse).
 *   R4  continue with an unavailable repository binding is refused.
 *   R5  continue after a HEAD change is refused — historical inputs are
 *       never re-based onto new history (rerun is the explicit alternative).
 *   R6  kill-restart reuse: with every step completed at crash time, a
 *       successor run restores the read-only results — the completed model
 *       call is NOT billed twice (successor backend invocations = 0).
 *   R7  executor-level restore: `resume.restoredSteps` reuses evidence
 *       inputs + fingerprint-keyed verdicts without a second model call.
 *
 * Every test runs the REAL host + REAL SQLite (in-memory, migrated) + REAL
 * git fixture repositories. The ONLY double is the isolated-test model
 * backend (offline MockLLMProvider discipline — no network, no credentials).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowRuntimeDefinition, WorkflowRuntimeExecutablePlan } from "@consistency/schema";
import { RepositorySnapshot } from "@consistency/repository";
import { compileWorkflowRuntimeDefinition } from "./compile";
import { WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS, VERIFIED_MINI_REVIEW_DEFINITION, WORKFLOW_RUNTIME_BUILTIN_METADATA, runtimeBuiltinChecksum } from "./definition";
import { executeWorkflowPlan, type WorkflowExecutorLlmEntry, type WorkflowExecutorStepCheckpointFact, type WorkflowRestoredStepResult, type WorkflowSnapshotInput } from "./executor";
import { WorkflowRuntimeHost, type WorkflowRepositoryResolver } from "./host";
import { WorkflowRuntimeStore, WorkflowRuntimeStoreError } from "./store";
import { WorkflowRuntimeEventStore } from "./eventStore";
import { WorkflowRuntimeCheckpointStore } from "./checkpointStore";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import type { ConsistencyDatabase } from "../db/connection";
import type { TrustedLLMBackend } from "@consistency/workload-review";
import type { TokenUsage } from "@consistency/schema";

const TMP_DIRS: string[] = [];
afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SYNTHETIC_TOKEN = `ghp_${"F".repeat(36)}`;
const HEAD_CONTENT = [
  "export function wide(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}  ",
  `export const token = "${SYNTHETIC_TOKEN}";`,
  "export const fine = 1;",
].join("\n");

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeFixtureRepo(): { repoPath: string; headSha: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wf-recovery-"));
  TMP_DIRS.push(repoPath);
  git(repoPath, ["init", "-q"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "src", "index.ts"), HEAD_CONTENT, "utf8");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", "fixture"]);
  return { repoPath, headSha: git(repoPath, ["rev-parse", "HEAD"]) };
}

function resolverFor(repoPath: string, repositoryId = "repo-fixture"): WorkflowRepositoryResolver {
  return (id) =>
    id === repositoryId
      ? {
          status: "ok",
          binding: {
            repositoryId,
            displayName: "Fixture Local Repo",
            remoteFullName: "test/fixture-canonical",
            localPath: repoPath,
          },
        }
      : undefined;
}

/** Offline, deterministic model backend double (counts every invocation). */
function makeModelBackend(options: {
  readonly mode: "valid" | "invalid" | "wait-for-abort";
} = { mode: "valid" }): {
  readonly entry: WorkflowExecutorLlmEntry;
  readonly calls: { count: number };
} {
  const calls = { count: 0 };
  const usage: TokenUsage = { inputTokens: 12, outputTokens: 34, totalTokens: 46 };
  // Cast: the workspace resolves two independent zod copies (apps/api vs
  // workload-review), so structural typing against TrustedLLMBackend fails
  // for test doubles even though the shape is exact.
  const backend = {
    invokeStructured: async (request: { userPrompt: string; signal?: AbortSignal }) => {
      calls.count += 1;
      if (request.signal?.aborted) throw request.signal.reason ?? new Error("aborted before dispatch");
      if (options.mode === "wait-for-abort") {
        await new Promise<never>((_, reject) => {
          const timeout = setTimeout(() => reject(new Error("model call timed out in test")), 10_000);
          request.signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(request.signal!.reason ?? new Error("aborted"));
          }, { once: true });
        });
      }
      // The deterministic verdict is derived from the prompt's fingerprint
      // digest — no fixture fingerprint can go stale.
      if (options.mode === "invalid") {
        return { data: { totally: "not the schema" }, tokenUsage: usage };
      }
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
  host(recoveryOptions?: { readonly resolver?: WorkflowRepositoryResolver; readonly modelBackend?: () => Promise<WorkflowExecutorLlmEntry> }): WorkflowRuntimeHost;
}

function makeRig(resolver: WorkflowRepositoryResolver, modelBackend?: () => Promise<WorkflowExecutorLlmEntry>): Rig {
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
    host(recoveryOptions = {}): WorkflowRuntimeHost {
      const effectiveModelBackend = recoveryOptions.modelBackend ?? modelBackend;
      const host = new WorkflowRuntimeHost({
        store,
        eventStore,
        checkpointStore,
        resolveRepository: recoveryOptions.resolver ?? resolver,
        ...(effectiveModelBackend === undefined ? {} : { modelBackend: effectiveModelBackend }),
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Simulates the crash window: last step_succeeded persisted, terminal write lost. */
function fabricateCrashBeforeTerminal(database: ConsistencyDatabase, runId: string): void {
  database
    .prepare("UPDATE workflow_runtime_runs SET status = 'running', finished_at = NULL, mini_report_json = NULL, error = NULL, lifecycle_state = NULL, terminal_reason = NULL WHERE id = ?")
    .run(runId);
  database.prepare("DELETE FROM workflow_runtime_events WHERE run_id = ? AND event_type IN ('run_succeeded', 'run_failed')").run(runId);
}

const MODEL_DEFINITION_ID = "verified-model-review";
const MODEL_REVISION_ID = WORKFLOW_RUNTIME_BUILTIN_METADATA[MODEL_DEFINITION_ID]!.revisionId;

function approvalModelDefinition(): WorkflowRuntimeDefinition {
  return {
    id: "approval-model-recovery",
    version: 1,
    nodes: [
      { id: "analyze", type: "analyzer.deterministic-evidence", serviceRef: "deterministic-evidence.analyzer", parameters: { analyzers: ["style", "secret"] }, failurePolicy: "fail-closed" },
      { id: "verify", type: "verifier.persisted-evidence", serviceRef: "persisted-evidence.verifier", parameters: {}, failurePolicy: "fail-closed" },
      { id: "model-verify", type: "verifier.model-structured", serviceRef: "model-structured.verifier", parameters: {}, failurePolicy: "fail-closed", approval: { ttlSeconds: 3600 } },
    ],
    edges: [{ from: "analyze", to: "verify" }, { from: "verify", to: "model-verify" }],
  };
}

describe("H19 restricted runtime plan revisions", () => {
  it("appends a durable verifier after an undispatched approval tail and executes it after restart", async () => {
    const fixture = makeFixtureRepo();
    const mock = makeModelBackend();
    const rig = makeRig(resolverFor(fixture.repoPath), async () => mock.entry);
    const firstHost = rig.host();
    const saved = firstHost.saveDefinition({ definition: approvalModelDefinition() });
    const launched = await firstHost.trigger({ repositoryId: "repo-fixture", definitionId: saved.definitionId, revisionId: saved.revisionId });
    const deadline = Date.now() + 10_000;
    while (rig.store.getRun(launched.runId)?.lifecycleState !== "awaiting_input") {
      if (Date.now() > deadline) throw new Error("approval wait was not persisted");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const revision = firstHost.reviseWaitingPlan({ runId: launched.runId, stepId: "model-verify", nodeId: "postcheck", expectedRevision: 0 });
    expect(revision.revision).toBe(1);
    expect(revision.plan.agentSpecs.at(-1)?.nodeId).toBe("postcheck");
    expect(rig.eventStore.listEvents(launched.runId).some(event => event.stepId === "postcheck")).toBe(false);
    const restarted = rig.host();
    expect(restarted.getWaitingPlanRevision(launched.runId).revision).toBe(1);
    expect(restarted.getRunRecoveryPlan(launched.runId).actions.find(action => action.action === "continue")?.available).toBe(false);
    await restarted.decideApproval({ runId: launched.runId, stepId: "model-verify", decision: "approved" });
    expect((await waitForTerminal(restarted, launched.runId)).status).toBe("succeeded");
    expect(rig.eventStore.listEvents(launched.runId).some(event => event.eventType === "step_succeeded" && event.stepId === "postcheck")).toBe(true);
    expect(mock.calls.count).toBe(1);
    rig.database.close();
  });

  it("fences CAS, stale approvals, collisions, tail mutation and fifth append without extra dispatch", async () => {
    const fixture = makeFixtureRepo();
    const mock = makeModelBackend();
    const rig = makeRig(resolverFor(fixture.repoPath), async () => mock.entry);
    const host = rig.host();
    const definition = host.saveDefinition({ definition: approvalModelDefinition() });
    const launched = await host.trigger({ repositoryId: "repo-fixture", definitionId: definition.definitionId, revisionId: definition.revisionId });
    const deadline = Date.now() + 10_000;
    while (rig.store.getRun(launched.runId)?.lifecycleState !== "awaiting_input") {
      if (Date.now() > deadline) throw new Error("approval wait was not persisted");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const append = (stepId: string, nodeId: string, expectedRevision: number) => host.reviseWaitingPlan({ runId: launched.runId, stepId, nodeId, expectedRevision });
    expect(() => append("analyze", "wrongtail", 0)).toThrow(/not pending/);
    expect(() => append("model-verify", "verify", 0)).toThrow(/already exists/);
    expect(() => append("model-verify", "bad.node", 0)).toThrow(/node id invalid/);
    for (const [index, nodeId] of ["postcheck-a", "postcheck-b", "postcheck-c", "postcheck-d"].entries()) {
      expect(append("model-verify", nodeId, index).revision).toBe(index + 1);
      expect(() => append("model-verify", "stale-node", index)).toThrow(/CAS lost/);
    }
    expect(() => append("model-verify", "fifth", 4)).toThrow(/budget/);
    expect(mock.calls.count).toBe(0);
    await host.decideApproval({ runId: launched.runId, stepId: "model-verify", decision: "rejected" });
    expect(() => append("model-verify", "late", 3)).toThrow(/not paused/);
    expect(mock.calls.count).toBe(0);
    rig.database.close();
  });

  it("refuses a corrupt persisted revision on restart and refuses replay of a revised interrupted run", async () => {
    const fixture = makeFixtureRepo();
    const mock = makeModelBackend();
    const rig = makeRig(resolverFor(fixture.repoPath), async () => mock.entry);
    const host = rig.host();
    const definition = host.saveDefinition({ definition: approvalModelDefinition() });
    const launched = await host.trigger({ repositoryId: "repo-fixture", definitionId: definition.definitionId, revisionId: definition.revisionId });
    const deadline = Date.now() + 10_000;
    while (rig.store.getRun(launched.runId)?.lifecycleState !== "awaiting_input") {
      if (Date.now() > deadline) throw new Error("approval wait was not persisted");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    host.reviseWaitingPlan({ runId: launched.runId, stepId: "model-verify", nodeId: "postcheck", expectedRevision: 0 });
    rig.database.prepare("UPDATE workflow_runtime_plan_revisions SET plan_json = ? WHERE run_id = ?").run("{}", launched.runId);
    const restarted = rig.host();
    expect(() => restarted.getWaitingPlanRevision(launched.runId)).toThrow(/differs from pinned graph/);
    expect(() => restarted.reviseWaitingPlan({ runId: launched.runId, stepId: "model-verify", nodeId: "next", expectedRevision: 1 })).toThrow(/differs from pinned graph/);
    expect(restarted.getRunRecoveryPlan(launched.runId).blockers.some(blocker => blocker.code === "plan_revision_recovery_unsupported")).toBe(true);
    await expect(restarted.decideApproval({ runId: launched.runId, stepId: "model-verify", decision: "approved" })).rejects.toThrow(/differs from pinned graph/);
    expect(mock.calls.count).toBe(0);
    rig.database.close();
  });

  it("refuses an expired wait, a ledger collision, and a tampered base checksum without dispatch", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const store = new WorkflowRuntimeStore(database);
    const events = new WorkflowRuntimeEventStore(database);
    const saved = store.appendRevision({
      definitionId: "approval-model-recovery",
      definition: approvalModelDefinition(),
      status: "validated",
      validationIssues: [],
    });
    const runId = "wfrun_revision_fence";
    store.insertRun({
      runId, definitionId: saved.definitionId, revisionId: saved.revisionId, origin: "user",
      status: "running", repository: "fixture/repo", headSha: "a".repeat(40),
      createdAt: "2026-09-27T00:00:00.000Z", evidence: [], lifecycleState: "awaiting_input",
    });
    store.requestApproval({ runId, stepId: "model-verify", expiresAt: "2026-09-27T00:00:01.000Z" });
    expect(() => store.appendWaitingPlanRevision({ runId, stepId: "model-verify", nodeId: "late", expectedRevision: 0 })).toThrow(/not pending/);
    database.prepare("UPDATE workflow_runtime_approvals SET expires_at = ? WHERE run_id = ?").run("2999-01-01T00:00:00.000Z", runId);
    events.recordEvent({ eventType: "step_started", runId, correlationId: runId, stepId: "postcheck", attemptNumber: 1 });
    expect(() => store.appendWaitingPlanRevision({ runId, stepId: "model-verify", nodeId: "postcheck", expectedRevision: 0 })).toThrow(/ledger facts/);
    database.prepare("DELETE FROM workflow_runtime_events WHERE run_id = ?").run(runId);
    store.appendWaitingPlanRevision({ runId, stepId: "model-verify", nodeId: "postcheck", expectedRevision: 0 });
    database.prepare("UPDATE workflow_runtime_plan_revisions SET base_definition_checksum = ? WHERE run_id = ?").run("0".repeat(64), runId);
    expect(() => store.getPlanRevision(runId)).toThrow(/corrupt/);
    expect(() => store.appendWaitingPlanRevision({ runId, stepId: "model-verify", nodeId: "next", expectedRevision: 1 })).toThrow(/corrupt/);
    database.close();
  });
});

describe("H18 approval — host restart fencing", () => {
  it("persists the wait across restart, records one decision, and never bills a model via an H14 replay", async () => {
    const fixture = makeFixtureRepo();
    const model = makeModelBackend();
    const rig = makeRig(resolverFor(fixture.repoPath), async () => model.entry);
    const host = rig.host();
    const definition = host.saveDefinition({ definition: approvalModelDefinition() });
    const launched = await host.trigger({ repositoryId: "repo-fixture", definitionId: definition.definitionId, revisionId: definition.revisionId });
    const deadline = Date.now() + 30_000;
    while (rig.store.getApproval(launched.runId, "model-verify") === undefined) {
      if (Date.now() > deadline) throw new Error("approval wait was not persisted");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(model.calls.count).toBe(0);
    expect(rig.store.getRun(launched.runId)?.lifecycleState).toBe("awaiting_input");
    const restarted = rig.host();
    expect(restarted.getRun(launched.runId)?.status).toBe("running");
    expect(restarted.getRun(launched.runId)?.lifecycleState).toBe("awaiting_input");
    expect(restarted.getRunRecoveryPlan(launched.runId).actions.find((action) => action.action === "continue")?.available).toBe(false);
    const approved = rig.store.decideApproval({ runId: launched.runId, stepId: "model-verify", decision: "approved" });
    expect(approved.decision).toBe("approved");
    expect(() => rig.store.decideApproval({ runId: launched.runId, stepId: "model-verify", decision: "approved" })).toThrow(/repeat click/);
    await expect(restarted.executeRecovery({ runId: launched.runId, action: "continue" })).rejects.toThrow(/blocked/);
    expect(rig.host().getRun(launched.runId)?.lifecycleState).toBe("awaiting_input");
    expect(model.calls.count).toBe(0);
  });

  it("resumes the same run exactly once after approval and never re-bills after restart", async () => {
    const fixture = makeFixtureRepo();
    const model = makeModelBackend();
    const rig = makeRig(resolverFor(fixture.repoPath), async () => model.entry);
    const host = rig.host();
    const definition = host.saveDefinition({ definition: approvalModelDefinition() });
    const launched = await host.trigger({ repositoryId: "repo-fixture", definitionId: definition.definitionId, revisionId: definition.revisionId });
    const deadline = Date.now() + 30_000;
    while (rig.store.getApproval(launched.runId, "model-verify") === undefined) {
      if (Date.now() > deadline) throw new Error("approval wait was not persisted");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const resumed = await host.decideApproval({ runId: launched.runId, stepId: "model-verify", decision: "approved" });
    expect(resumed).toMatchObject({ runId: launched.runId, accepted: true });
    const finished = await waitForTerminal(host, launched.runId);
    expect(finished.status).toBe("succeeded");
    expect(model.calls.count).toBe(1);

    const restarted = rig.host();
    await expect(restarted.decideApproval({ runId: launched.runId, stepId: "model-verify", decision: "approved" }))
      .rejects.toMatchObject({ code: "WORKFLOW_APPROVAL_REPLAY" });
    expect(model.calls.count).toBe(1);
    expect(restarted.getRun(launched.runId)?.status).toBe("succeeded");
  });

  it("records rejection without dispatching and lets a stranded approval claim fail closed", async () => {
    const fixture = makeFixtureRepo();
    const model = makeModelBackend();
    const rig = makeRig(resolverFor(fixture.repoPath), async () => model.entry);
    const host = rig.host();
    const definition = host.saveDefinition({ definition: approvalModelDefinition() });
    const launched = await host.trigger({ repositoryId: "repo-fixture", definitionId: definition.definitionId, revisionId: definition.revisionId });
    const deadline = Date.now() + 30_000;
    while (rig.store.getApproval(launched.runId, "model-verify") === undefined) {
      if (Date.now() > deadline) throw new Error("approval wait was not persisted");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const rejected = await host.decideApproval({ runId: launched.runId, stepId: "model-verify", decision: "rejected" });
    expect(rejected.accepted).toBe(true);
    expect((await waitForTerminal(host, launched.runId)).status).toBe("failed");
    expect(model.calls.count).toBe(0);

    const approvedWait = await host.trigger({ repositoryId: "repo-fixture", definitionId: definition.definitionId, revisionId: definition.revisionId });
    while (rig.store.getApproval(approvedWait.runId, "model-verify") === undefined) {
      if (Date.now() > deadline) throw new Error("second approval wait was not persisted");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    rig.store.decideApproval({ runId: approvedWait.runId, stepId: "model-verify", decision: "approved" });
    expect(rig.store.claimApprovedContinuation({ runId: approvedWait.runId, stepId: "model-verify" })).toBe(true);
    expect(rig.store.claimApprovedContinuation({ runId: approvedWait.runId, stepId: "model-verify" })).toBe(false);
    const restarted = rig.host();
    await expect(restarted.decideApproval({ runId: approvedWait.runId, stepId: "model-verify", decision: "approved" }))
      .rejects.toMatchObject({ code: "WORKFLOW_APPROVAL_REPLAY" });
    expect(model.calls.count).toBe(0);
  });
});

describe("H14 recovery — R1: startup scan marks interrupted runs failed + recoverable", () => {
  it("scan marks the run failed transactionally with its ledger event + interrupted marker; plan folds outcome_unknown", () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig(resolverFor(fixture.repoPath));
    const host = rig.host();
    // A run row (durable) + ledger facts: analyze succeeded (checkpointed),
    // verify started but its result never arrived (outcome_unknown).
    rig.store.insertRun({
      runId: "wfrun_interrupted",
      definitionId: VERIFIED_MINI_REVIEW_DEFINITION.id,
      revisionId: WORKFLOW_RUNTIME_BUILTIN_METADATA[VERIFIED_MINI_REVIEW_DEFINITION.id]!.revisionId,
      origin: "builtin",
      status: "running",
      repository: "test/fixture-canonical",
      repositoryOpaqueId: "repo-fixture",
      headSha: fixture.headSha,
      createdAt: new Date().toISOString(),
      evidence: [],
      lifecycleState: "running",
    });
    rig.eventStore.recordEvent({
      eventType: "step_succeeded",
      runId: "wfrun_interrupted",
      correlationId: "wfrun_interrupted",
      stepId: "analyze",
      attemptNumber: 1,
      payload: { serviceRef: "deterministic-evidence.analyzer" },
    });
    rig.checkpointStore.recordStepResult({
      runId: "wfrun_interrupted",
      definitionId: VERIFIED_MINI_REVIEW_DEFINITION.id,
      revisionId: WORKFLOW_RUNTIME_BUILTIN_METADATA[VERIFIED_MINI_REVIEW_DEFINITION.id]!.revisionId,
      repository: "test/fixture-canonical",
      headSha: fixture.headSha,
      snapshotFingerprint: "f".repeat(64),
      definitionChecksum: runtimeBuiltinChecksum(VERIFIED_MINI_REVIEW_DEFINITION),
      step: {
        stepId: "analyze",
        serviceRef: "deterministic-evidence.analyzer",
        nodeKind: "deterministic-analyzer",
        evidenceFingerprints: ["a".repeat(64)],
        result: { kind: "evidence-inputs", evidenceInputs: [] },
      },
    });
    rig.eventStore.recordEvent({
      eventType: "step_started",
      runId: "wfrun_interrupted",
      correlationId: "wfrun_interrupted",
      stepId: "verify",
      attemptNumber: 1,
      payload: { serviceRef: "persisted-evidence.verifier" },
    });

    const freshHost = rig.host();
    const run = freshHost.getRun("wfrun_interrupted");
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("interrupted");
    expect(run?.lifecycleState).toBe("failed");

    // The run_failed fact is IN the ledger (transactional with the update).
    const events = rig.eventStore.listEvents("wfrun_interrupted");
    const runFailed = events.find((event) => event.eventType === "run_failed");
    expect(runFailed).toBeDefined();
    expect(runFailed?.payload.reason).toBe("interrupted");
    expect(runFailed?.payload.recoverable).toBe(true);

    const plan = freshHost.getRunRecoveryPlan("wfrun_interrupted");
    expect(plan.interrupted).toBe(true);
    const analyze = plan.steps.find((step) => step.stepId === "analyze");
    const verify = plan.steps.find((step) => step.stepId === "verify");
    expect(analyze?.outcome).toBe("succeeded");
    expect(analyze?.reusable).toBe(true);
    expect(verify?.outcome).toBe("outcome_unknown");
    expect(verify?.reusable).toBe(false);
    const continueAction = plan.actions.find((action) => action.action === "continue");
    expect(continueAction?.available).toBe(false);
    expect(continueAction?.blockers.some((blocker) => blocker.code === "step_outcome_unknown" && blocker.stepId === "verify")).toBe(true);
    expect(plan.actions.find((action) => action.action === "rerun")?.available).toBe(true);
    expect(plan.actions.find((action) => action.action === "readonly_view")?.available).toBe(true);
  });
});

describe("H14 recovery — R2: outcome_unknown blocks continue; retry stays framework-only", () => {
  it("continue POST is refused 409 with the outcome_unknown blocker; retry is refused as framework-only", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig(resolverFor(fixture.repoPath));
    const host = rig.host();
    rig.store.insertRun({
      runId: "wfrun_unknown",
      definitionId: VERIFIED_MINI_REVIEW_DEFINITION.id,
      revisionId: WORKFLOW_RUNTIME_BUILTIN_METADATA[VERIFIED_MINI_REVIEW_DEFINITION.id]!.revisionId,
      origin: "builtin",
      status: "running",
      repository: "test/fixture-canonical",
      repositoryOpaqueId: "repo-fixture",
      headSha: fixture.headSha,
      createdAt: new Date().toISOString(),
      evidence: [],
      lifecycleState: "running",
    });
    rig.eventStore.recordEvent({
      eventType: "step_started",
      runId: "wfrun_unknown",
      correlationId: "wfrun_unknown",
      stepId: "analyze",
      attemptNumber: 1,
      payload: { serviceRef: "deterministic-evidence.analyzer" },
    });
    rig.checkpointStore.markInterrupted({
      runId: "wfrun_unknown",
      definitionId: VERIFIED_MINI_REVIEW_DEFINITION.id,
      revisionId: WORKFLOW_RUNTIME_BUILTIN_METADATA[VERIFIED_MINI_REVIEW_DEFINITION.id]!.revisionId,
      repository: "test/fixture-canonical",
      headSha: fixture.headSha,
    });
    const freshHost = rig.host();

    let blocked: unknown;
    try {
      await freshHost.executeRecovery({ runId: "wfrun_unknown", action: "continue" });
    } catch (error) {
      blocked = error;
    }
    expect(blocked).toBeInstanceOf(WorkflowRuntimeStoreError);
    expect((blocked as WorkflowRuntimeStoreError).statusCode).toBe(409);
    expect((blocked as WorkflowRuntimeStoreError).code).toBe("WORKFLOW_RECOVERY_BLOCKED");
    expect((blocked as WorkflowRuntimeStoreError).message).toContain("step_outcome_unknown");

    // retry is LISTED but never executable in this ticket.
    const retry = await freshHost.executeRecovery({ runId: "wfrun_unknown", action: "retry" });
    expect(retry.executed).toBe(false);
    expect(retry.message).toContain("framework");
    // readonly_view executes without touching anything.
    const view = await freshHost.executeRecovery({ runId: "wfrun_unknown", action: "readonly_view" });
    expect(view.executed).toBe(true);
  });
});

describe("H14 recovery — R3: corrupt checkpoint results are refused", () => {
  it("a corrupt result_json becomes an explicit blocker and continue is unavailable", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig(resolverFor(fixture.repoPath));
    const host = rig.host();
    rig.store.insertRun({
      runId: "wfrun_corrupt",
      definitionId: VERIFIED_MINI_REVIEW_DEFINITION.id,
      revisionId: WORKFLOW_RUNTIME_BUILTIN_METADATA[VERIFIED_MINI_REVIEW_DEFINITION.id]!.revisionId,
      origin: "builtin",
      status: "running",
      repository: "test/fixture-canonical",
      repositoryOpaqueId: "repo-fixture",
      headSha: fixture.headSha,
      createdAt: new Date().toISOString(),
      evidence: [],
      lifecycleState: "running",
    });
    rig.checkpointStore.recordStepResult({
      runId: "wfrun_corrupt",
      definitionId: VERIFIED_MINI_REVIEW_DEFINITION.id,
      revisionId: WORKFLOW_RUNTIME_BUILTIN_METADATA[VERIFIED_MINI_REVIEW_DEFINITION.id]!.revisionId,
      repository: "test/fixture-canonical",
      headSha: fixture.headSha,
      snapshotFingerprint: "f".repeat(64),
      definitionChecksum: runtimeBuiltinChecksum(VERIFIED_MINI_REVIEW_DEFINITION),
      step: {
        stepId: "analyze",
        serviceRef: "deterministic-evidence.analyzer",
        nodeKind: "deterministic-analyzer",
        evidenceFingerprints: ["a".repeat(64)],
        result: { kind: "evidence-inputs", evidenceInputs: [] },
      },
    });
    // Corrupt the durable row directly (simulated storage damage).
    rig.database
      .prepare("UPDATE workflow_runtime_checkpoint_steps SET result_json = '{not json' WHERE run_id = 'wfrun_corrupt' AND step_id = 'analyze'")
      .run();
    const freshHost = rig.host();
    const plan = freshHost.getRunRecoveryPlan("wfrun_corrupt");
    const analyze = plan.steps.find((step) => step.stepId === "analyze");
    expect(analyze?.corrupt).toBe(true);
    expect(analyze?.reusable).toBe(false);
    expect(plan.blockers.some((blocker) => blocker.code === "checkpoint_corrupt")).toBe(true);
    expect(plan.actions.find((action) => action.action === "continue")?.available).toBe(false);
    let blocked: unknown;
    try {
      await freshHost.executeRecovery({ runId: "wfrun_corrupt", action: "continue" });
    } catch (error) {
      blocked = error;
    }
    expect((blocked as WorkflowRuntimeStoreError).statusCode).toBe(409);
    expect((blocked as WorkflowRuntimeStoreError).message).toContain("checkpoint_corrupt");
  });
});

describe("H14 recovery — R4/R5: continue re-validates binding, snapshot, and HEAD", () => {
  it("R4: unavailable repository binding blocks continue with repository_binding_unavailable", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig(resolverFor(fixture.repoPath));
    const host = rig.host();
    const created = await host.trigger({ repositoryId: "repo-fixture", definitionId: VERIFIED_MINI_REVIEW_DEFINITION.id, revisionId: WORKFLOW_RUNTIME_BUILTIN_METADATA[VERIFIED_MINI_REVIEW_DEFINITION.id]!.revisionId });
    await waitForTerminal(host, created.runId);
    fabricateCrashBeforeTerminal(rig.database, created.runId);
    // Restart with a resolver that can no longer serve the binding.
    const freshHost = rig.host({ resolver: () => ({ status: "unavailable", reason: "repository local path is unavailable" }) });
    const plan = freshHost.getRunRecoveryPlan(created.runId);
    expect(plan.actions.find((action) => action.action === "continue")?.available).toBe(true); // static facts allow it
    let blocked: unknown;
    try {
      await freshHost.executeRecovery({ runId: created.runId, action: "continue" });
    } catch (error) {
      blocked = error;
    }
    expect((blocked as WorkflowRuntimeStoreError).statusCode).toBe(409);
    expect((blocked as WorkflowRuntimeStoreError).message).toContain("repository_binding_unavailable");
  });

  it("R5: a HEAD change blocks continue with head_changed (历史输入绝不静默重放)", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig(resolverFor(fixture.repoPath));
    const host = rig.host();
    const created = await host.trigger({ repositoryId: "repo-fixture", definitionId: VERIFIED_MINI_REVIEW_DEFINITION.id, revisionId: WORKFLOW_RUNTIME_BUILTIN_METADATA[VERIFIED_MINI_REVIEW_DEFINITION.id]!.revisionId });
    await waitForTerminal(host, created.runId);
    fabricateCrashBeforeTerminal(rig.database, created.runId);
    // History moved on: a new commit lands before the restart.
    fs.writeFileSync(path.join(fixture.repoPath, "src", "extra.ts"), "export const extra = 1;\n", "utf8");
    git(fixture.repoPath, ["add", "."]);
    git(fixture.repoPath, ["commit", "-q", "-m", "drift"]);
    const freshHost = rig.host();
    let blocked: unknown;
    try {
      await freshHost.executeRecovery({ runId: created.runId, action: "continue" });
    } catch (error) {
      blocked = error;
    }
    expect((blocked as WorkflowRuntimeStoreError).statusCode).toBe(409);
    expect((blocked as WorkflowRuntimeStoreError).message).toContain("head_changed");
    // The original run state was not touched by the refusal.
    const run = freshHost.getRun(created.runId);
    expect(run?.status).toBe("failed");
    expect(run?.snapshot.headSha).toBe(fixture.headSha);
  });
});

describe("H14 recovery — R6: kill-restart reuse (a completed model call is never billed twice)", () => {
  it("continue restores every completed read-only step; the successor makes ZERO model invocations", async () => {
    const fixture = makeFixtureRepo();
    const model = makeModelBackend({ mode: "valid" });
    const rig = makeRig(resolverFor(fixture.repoPath), async () => model.entry);
    const host = rig.host();
    const created = await host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    const finished = await waitForTerminal(host, created.runId);
    expect(finished.status).toBe("succeeded");
    expect(model.calls.count).toBe(1); // exactly ONE billed model call

    // Crash window: everything completed, only the terminal write was lost.
    fabricateCrashBeforeTerminal(rig.database, created.runId);

    // Restart: new host over the SAME database (the old process is gone).
    const successorModel = makeModelBackend({ mode: "valid" });
    const freshHost = rig.host({ modelBackend: async () => successorModel.entry });
    const plan = freshHost.getRunRecoveryPlan(created.runId);
    expect(plan.interrupted).toBe(true);
    const continueAction = plan.actions.find((action) => action.action === "continue");
    expect(continueAction?.available).toBe(true);

    const outcome = await freshHost.executeRecovery({ runId: created.runId, action: "continue" });
    expect(outcome.executed).toBe(true);
    expect(outcome.resumedFromRunId).toBe(created.runId);
    const successorId = outcome.runId!;
    const successor = await waitForTerminal(freshHost, successorId);
    expect(successor.status).toBe("succeeded");
    // 不重复结算: the successor reused the verdict — zero new model calls.
    expect(successorModel.calls.count).toBe(0);
    expect(model.calls.count).toBe(1);

    // Lineage + honest duplication-free report: the successor's findings are
    // evidence-grounded and the checkpoint header records resumedFrom.
    const successorCheckpoint = rig.checkpointStore.getCheckpoint(successorId);
    expect(successorCheckpoint?.header.resumedFromRunId).toBe(created.runId);
    expect(successor.miniReport?.findings.length).toBeGreaterThanOrEqual(1);
    for (const finding of successor.miniReport?.findings ?? []) {
      expect(finding.evidenceIds.length).toBeGreaterThanOrEqual(1);
      expect(finding.verified).toBe(true);
    }
    // The original interrupted run is unchanged (append-only history).
    expect(freshHost.getRun(created.runId)?.status).toBe("failed");
    // A recovery plan is a read, not a dispatch claim. Once consumed, two
    // callers (including one after restart) cannot launch another successor.
    expect(freshHost.getRunRecoveryPlan(created.runId).actions.find((action) => action.action === "continue")?.available).toBe(false);
    await expect(freshHost.executeRecovery({ runId: created.runId, action: "continue" }))
      .rejects.toMatchObject({ code: "WORKFLOW_RECOVERY_BLOCKED" });
    expect(successorModel.calls.count).toBe(0);
  });
});

describe("H14 recovery — one-shot continuation fence", () => {
  it("consumes a claim at most once even when a crash strands it before successor creation", async () => {
    const fixture = makeFixtureRepo();
    const model = makeModelBackend({ mode: "valid" });
    const rig = makeRig(resolverFor(fixture.repoPath), async () => model.entry);
    const host = rig.host();
    const created = await host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    expect((await waitForTerminal(host, created.runId)).status).toBe("succeeded");
    fabricateCrashBeforeTerminal(rig.database, created.runId);
    const freshHost = rig.host();
    expect(freshHost.getRunRecoveryPlan(created.runId).actions.find((action) => action.action === "continue")?.available).toBe(true);
    expect(rig.checkpointStore.claimInterruptedContinue(created.runId)).toBe(true);
    expect(rig.checkpointStore.claimInterruptedContinue(created.runId)).toBe(false);
    expect(freshHost.getRunRecoveryPlan(created.runId).actions.find((action) => action.action === "continue")?.available).toBe(false);
    await expect(freshHost.executeRecovery({ runId: created.runId, action: "continue" }))
      .rejects.toMatchObject({ code: "WORKFLOW_RECOVERY_BLOCKED" });
    expect(model.calls.count).toBe(1);
    expect(rig.store.listRuns(20).length).toBe(1);
  });
});

describe("H14 recovery — R7: executor-level restore reuses results without a second model call", () => {
  it("restoredSteps reuse evidence inputs + fingerprint-keyed verdicts; step_started carries resumed=true", async () => {
    const fixture = makeFixtureRepo();
    const model = makeModelBackend({ mode: "valid" });
    const compilation = compileWorkflowRuntimeDefinition(
      WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS[MODEL_DEFINITION_ID]!,
    );
    if (!compilation.ok || !compilation.plan) throw new Error("model definition must compile");
    const plan: WorkflowRuntimeExecutablePlan = compilation.plan;

    const makeInput = (headSha: string): WorkflowSnapshotInput => ({
      repository: "test/workflow-slice",
      headSha,
      paths: ["src/index.ts"],
      snapshot: RepositorySnapshot.create({
        repositoryPath: fixture.repoPath,
        repository: "test/workflow-slice",
        headSha,
        baseSha: headSha,
      }),
    });

    const checkpointFacts: WorkflowExecutorStepCheckpointFact[] = [];
    const first = await executeWorkflowPlan(plan, makeInput(fixture.headSha), {
      llm: model.entry,
      onStepCheckpoint: (fact) => {
        checkpointFacts.push(fact);
      },
    });
    expect(first.status).toBe("succeeded");
    expect(model.calls.count).toBe(1);
    expect(checkpointFacts.some((fact) => fact.nodeKind === "deterministic-analyzer")).toBe(true);
    expect(checkpointFacts.some((fact) => fact.nodeKind === "llm-structured-verifier")).toBe(true);

    // Build the restore map exactly as the host does from durable rows.
    const restoredSteps = new Map<string, WorkflowRestoredStepResult>();
    for (const fact of checkpointFacts) {
      if (fact.evidenceInputs !== undefined) restoredSteps.set(fact.stepId, { outcome: "succeeded", evidenceInputs: fact.evidenceInputs });
      else if (fact.modelVerdict !== undefined) restoredSteps.set(fact.stepId, { outcome: "succeeded", modelVerdict: fact.modelVerdict });
    }

    const resumedPayloads: Record<string, unknown>[] = [];
    const second = await executeWorkflowPlan(plan, { ...makeInput(fixture.headSha), resume: { restoredSteps } }, {
      llm: model.entry,
      onStepEvent: (event) => {
        if (event.eventType === "step_started" && event.payload?.resumed === true) resumedPayloads.push({ stepId: event.stepId });
      },
    });
    expect(second.status).toBe("succeeded");
    // 不重复结算: the restored verdict was re-applied — no second model call.
    expect(model.calls.count).toBe(1);
    expect(resumedPayloads.length).toBeGreaterThanOrEqual(2);
    // Restored evidence verifies identically (fingerprints are content-derived).
    const firstPrints = new Set(first.evidence.map((record) => record.fingerprint));
    const secondPrints = new Set(second.evidence.map((record) => record.fingerprint));
    expect(secondPrints).toEqual(firstPrints);
    expect(second.miniReport.findings.length).toBeGreaterThanOrEqual(1);
    for (const finding of second.miniReport.findings) {
      expect(finding.verified).toBe(true);
      for (const id of finding.evidenceIds) {
        expect(second.evidence.some((record) => String(record.id) === id)).toBe(true);
      }
    }
  });
});
