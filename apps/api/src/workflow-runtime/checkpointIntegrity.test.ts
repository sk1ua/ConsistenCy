/**
 * Wave 3 / R2 — checkpoint integrity: a checkpoint is reused ONLY when its
 * payload is structurally valid for its node kind AND belongs to this run's
 * inputs.
 *
 * The defect this file pins down: `#stepFromRow` only checked that
 * `result_json` parsed and that the fingerprint column had array SHAPE, so a
 * perfectly valid JSON object such as `{}` came back `corrupt: false,
 * reusable: true`. The recovery planner therefore advertised `continue`, the
 * restore map silently skipped the shape-less row, and the successor re-ran a
 * PAID model call that had already been billed. The same silent absorption
 * happened when a checkpoint was written twice with a different input identity
 * (header definition/revision/repository/headSha/snapshotFingerprint/checksum).
 *
 * Contract under test:
 *   - full result-schema validation per nodeKind / serviceRef / result.kind
 *     happens BEFORE the recovery plan is computed;
 *   - fingerprints must all be non-empty strings;
 *   - a checkpoint row must correspond to the ledger facts it cites;
 *   - invalid / mismatched rows surface as `checkpoint_corrupt` blockers,
 *     `continue` becomes unavailable, the provider invocation count stays 0,
 *     and the stored rows are preserved;
 *   - a second write of the same (run, step) key with a DIFFERENT input
 *     identity is REJECTED instead of silently absorbed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { TokenUsage } from "@consistency/schema";
import type { TrustedLLMBackend } from "@consistency/workload-review";
import { WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS, WORKFLOW_RUNTIME_BUILTIN_METADATA, runtimeBuiltinChecksum } from "./definition";
import type { WorkflowExecutorLlmEntry } from "./executor";
import { WorkflowRuntimeHost, type WorkflowRepositoryResolver } from "./host";
import { WorkflowRuntimeStore } from "./store";
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
const MODEL_STEP_ID = "model-verify";
const ANALYZE_STEP_ID = "analyze";

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeFixtureRepo(): { repoPath: string; headSha: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wf-checkpoint-"));
  TMP_DIRS.push(repoPath);
  git(repoPath, ["init", "-q"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repoPath, "src", "index.ts"),
    [
      "export function wide(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}  ",
      `export const token = "ghp_${"F".repeat(36)}";`,
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

function makeModelBackend(): { readonly entry: WorkflowExecutorLlmEntry; readonly calls: { count: number } } {
  const calls = { count: 0 };
  const usage: TokenUsage = { inputTokens: 12, outputTokens: 34, totalTokens: 46 };
  const backend = {
    invokeStructured: async (request: { userPrompt: string; signal?: AbortSignal }) => {
      calls.count += 1;
      if (request.signal?.aborted) throw request.signal.reason ?? new Error("aborted before dispatch");
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

/** A completed model run whose terminal write was lost (the H14 crash window). */
function fabricateCrashBeforeTerminal(database: ConsistencyDatabase, runId: string): void {
  database
    .prepare("UPDATE workflow_runtime_runs SET status = 'running', finished_at = NULL, mini_report_json = NULL, error = NULL, lifecycle_state = NULL, terminal_reason = NULL, terminal_detail = NULL WHERE id = ?")
    .run(runId);
  database.prepare("DELETE FROM workflow_runtime_events WHERE run_id = ? AND event_type IN ('run_succeeded', 'run_failed')").run(runId);
}

async function completedModelRun(rig: Rig, fixture: { repoPath: string; headSha: string }, model: ReturnType<typeof makeModelBackend>) {
  const host = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => model.entry });
  const created = await host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
  const finished = await waitForTerminal(host, created.runId);
  expect(finished.status).toBe("succeeded");
  expect(model.calls.count).toBe(1);
  fabricateCrashBeforeTerminal(rig.database, created.runId);
  return created.runId;
}

describe("Wave3 R2 — checkpoint payloads are validated BEFORE a recovery plan is offered", () => {
  it("R2-a1: a valid-JSON placeholder ({}), blocks continue and never re-bills the model", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const runId = await completedModelRun(rig, fixture, model);

    // Simulated storage damage that JSON.parse accepts happily.
    rig.database
      .prepare("UPDATE workflow_runtime_checkpoint_steps SET result_json = '{}' WHERE run_id = ? AND step_id = ?")
      .run(runId, MODEL_STEP_ID);

    const successorModel = makeModelBackend();
    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => successorModel.entry });
    const plan = freshHost.getRunRecoveryPlan(runId);
    const step = plan.steps.find((entry) => entry.stepId === MODEL_STEP_ID);
    expect(step?.corrupt).toBe(true);
    expect(step?.reusable).toBe(false);
    expect(plan.blockers.some((blocker) => blocker.code === "checkpoint_corrupt")).toBe(true);
    const continueAction = plan.actions.find((action) => action.action === "continue");
    expect(continueAction?.available).toBe(false);

    let blocked: unknown;
    try {
      await freshHost.executeRecovery({ runId, action: "continue" });
    } catch (error) {
      blocked = error;
    }
    expect((blocked as { code?: string }).code).toBe("WORKFLOW_RECOVERY_BLOCKED");
    // 不重复计费: the paid result was never silently re-executed.
    expect(successorModel.calls.count).toBe(0);
    expect(model.calls.count).toBe(1);
    // The (damaged) row is preserved for inspection — never deleted.
    expect(rig.database.prepare("SELECT result_json FROM workflow_runtime_checkpoint_steps WHERE run_id = ? AND step_id = ?").get(runId, MODEL_STEP_ID))
      .toEqual({ result_json: "{}" });
  });

  it("R2-a2: an envelope whose kind contradicts its node kind blocks reuse", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const runId = await completedModelRun(rig, fixture, model);

    // A model step carrying the ANALYZER envelope (wrong result.kind).
    rig.database
      .prepare("UPDATE workflow_runtime_checkpoint_steps SET result_json = ? WHERE run_id = ? AND step_id = ?")
      .run(JSON.stringify({ kind: "evidence-inputs", evidenceInputs: [] }), runId, MODEL_STEP_ID);
    // And the analyzer step carrying a verdict envelope (also wrong).
    rig.database
      .prepare("UPDATE workflow_runtime_checkpoint_steps SET result_json = ? WHERE run_id = ? AND step_id = ?")
      .run(JSON.stringify({ kind: "model-verdict", modelVerdict: { findings: [], summary: "x" } }), runId, ANALYZE_STEP_ID);

    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => makeModelBackend().entry });
    const plan = freshHost.getRunRecoveryPlan(runId);
    expect(plan.steps.find((entry) => entry.stepId === MODEL_STEP_ID)?.corrupt).toBe(true);
    expect(plan.steps.find((entry) => entry.stepId === ANALYZE_STEP_ID)?.corrupt).toBe(true);
    expect(plan.actions.find((action) => action.action === "continue")?.available).toBe(false);
    expect(plan.blockers.filter((blocker) => blocker.code === "checkpoint_corrupt").length).toBeGreaterThanOrEqual(2);
  });

  it("R2-a3: a schema-invalid model verdict blocks reuse (no silent re-run)", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const runId = await completedModelRun(rig, fixture, model);

    rig.database
      .prepare("UPDATE workflow_runtime_checkpoint_steps SET result_json = ? WHERE run_id = ? AND step_id = ?")
      .run(JSON.stringify({ kind: "model-verdict", modelVerdict: { totally: "not the schema" } }), runId, MODEL_STEP_ID);

    const successorModel = makeModelBackend();
    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => successorModel.entry });
    const plan = freshHost.getRunRecoveryPlan(runId);
    expect(plan.steps.find((entry) => entry.stepId === MODEL_STEP_ID)?.corrupt).toBe(true);
    expect(plan.actions.find((action) => action.action === "continue")?.available).toBe(false);
    expect(successorModel.calls.count).toBe(0);
  });

  it("R2-a4: fingerprint entries that are not non-empty strings block reuse", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const runId = await completedModelRun(rig, fixture, model);

    rig.database
      .prepare("UPDATE workflow_runtime_checkpoint_steps SET evidence_ids_json = ? WHERE run_id = ? AND step_id = ?")
      .run(JSON.stringify(["a".repeat(64), 42, ""]), runId, MODEL_STEP_ID);

    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => makeModelBackend().entry });
    const plan = freshHost.getRunRecoveryPlan(runId);
    expect(plan.steps.find((entry) => entry.stepId === MODEL_STEP_ID)?.corrupt).toBe(true);
    expect(plan.actions.find((action) => action.action === "continue")?.available).toBe(false);
    // Non-string entries are never surfaced as reuse facts.
    expect(plan.steps.find((entry) => entry.stepId === MODEL_STEP_ID)?.evidenceFingerprints).toEqual([]);
  });

  it("R2-a5: a checkpoint citing a ledger seq that is not this step's success blocks reuse", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const runId = await completedModelRun(rig, fixture, model);

    // Point the model step's checkpoint at the analyzer's success seq.
    const analyzeSeq = rig.eventStore.listEvents(runId).find((event) => event.stepId === ANALYZE_STEP_ID && event.eventType === "step_succeeded")!.seq;
    rig.database
      .prepare("UPDATE workflow_runtime_checkpoint_steps SET event_seq = ? WHERE run_id = ? AND step_id = ?")
      .run(analyzeSeq, runId, MODEL_STEP_ID);

    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => makeModelBackend().entry });
    const plan = freshHost.getRunRecoveryPlan(runId);
    expect(plan.steps.find((entry) => entry.stepId === MODEL_STEP_ID)?.corrupt).toBe(true);
    expect(plan.actions.find((action) => action.action === "continue")?.available).toBe(false);
  });

  it("R2-a6: a paid checkpoint missing its ledger success reference cannot authorize replay", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const runId = await completedModelRun(rig, fixture, model);
    rig.database.prepare("UPDATE workflow_runtime_checkpoint_steps SET event_seq = NULL WHERE run_id = ? AND step_id = ?")
      .run(runId, MODEL_STEP_ID);

    const successorModel = makeModelBackend();
    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => successorModel.entry });
    const plan = freshHost.getRunRecoveryPlan(runId);
    expect(plan.steps.find((entry) => entry.stepId === MODEL_STEP_ID)?.corrupt).toBe(true);
    expect(plan.blockers.some((blocker) => blocker.code === "checkpoint_corrupt" && blocker.stepId === MODEL_STEP_ID)).toBe(true);
    await expect(freshHost.executeRecovery({ runId, action: "continue" })).rejects.toMatchObject({ code: "WORKFLOW_RECOVERY_BLOCKED" });
    expect(model.calls.count).toBe(1);
    expect(successorModel.calls.count).toBe(0);
  });

  it("R2-a7: a paid result without a surviving success fact cannot mask an unknown dispatch", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const runId = await completedModelRun(rig, fixture, model);
    rig.database.prepare("DELETE FROM workflow_runtime_events WHERE run_id = ? AND step_id = ? AND event_type = 'step_succeeded'")
      .run(runId, MODEL_STEP_ID);

    const successorModel = makeModelBackend();
    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => successorModel.entry });
    const plan = freshHost.getRunRecoveryPlan(runId);
    expect(plan.steps.find((entry) => entry.stepId === MODEL_STEP_ID)?.corrupt).toBe(true);
    expect(plan.actions.find((action) => action.action === "continue")?.available).toBe(false);
    await expect(freshHost.executeRecovery({ runId, action: "continue" })).rejects.toMatchObject({ code: "WORKFLOW_RECOVERY_BLOCKED" });
    expect(successorModel.calls.count).toBe(0);
  });

  it("R2-a8: a later paid dispatch with no outcome overrides an earlier successful checkpoint", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const runId = await completedModelRun(rig, fixture, model);
    rig.eventStore.recordEvent({
      eventType: "step_started", runId, correlationId: runId, stepId: MODEL_STEP_ID,
      attemptNumber: 2, payload: { serviceRef: "model-structured.verifier" },
    });

    const successorModel = makeModelBackend();
    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => successorModel.entry });
    const plan = freshHost.getRunRecoveryPlan(runId);
    expect(plan.steps.find((entry) => entry.stepId === MODEL_STEP_ID)).toMatchObject({ outcome: "outcome_unknown", corrupt: true, reusable: false });
    expect(plan.blockers.some((blocker) => blocker.code === "step_outcome_unknown" && blocker.stepId === MODEL_STEP_ID)).toBe(true);
    await expect(freshHost.executeRecovery({ runId, action: "continue" })).rejects.toMatchObject({ code: "WORKFLOW_RECOVERY_BLOCKED" });
    expect(successorModel.calls.count).toBe(0);
  });

  it("R2-a9: a paid success without its checkpoint stays blocked even if the ledger says succeeded", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const runId = await completedModelRun(rig, fixture, model);
    rig.database.prepare("DELETE FROM workflow_runtime_checkpoint_steps WHERE run_id = ? AND step_id = ?")
      .run(runId, MODEL_STEP_ID);

    const successorModel = makeModelBackend();
    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => successorModel.entry });
    const plan = freshHost.getRunRecoveryPlan(runId);
    expect(plan.steps.find((entry) => entry.stepId === MODEL_STEP_ID)).toMatchObject({
      nodeKind: "llm-structured-verifier", outcome: "succeeded", reusable: false,
    });
    expect(plan.blockers.some((blocker) => blocker.code === "step_without_reusable_result" && blocker.stepId === MODEL_STEP_ID)).toBe(true);
    expect(plan.actions.find((action) => action.action === "continue")?.available).toBe(false);
    await expect(freshHost.executeRecovery({ runId, action: "continue" })).rejects.toMatchObject({ code: "WORKFLOW_RECOVERY_BLOCKED" });
    expect(successorModel.calls.count).toBe(0);
  });

  it("R2-a10: a paid success without an earlier dispatch intent cannot authorize reuse", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const runId = await completedModelRun(rig, fixture, model);
    rig.database.prepare("DELETE FROM workflow_runtime_events WHERE run_id = ? AND step_id = ? AND event_type = 'step_started'")
      .run(runId, MODEL_STEP_ID);

    const successorModel = makeModelBackend();
    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => successorModel.entry });
    const plan = freshHost.getRunRecoveryPlan(runId);
    expect(plan.steps.find((entry) => entry.stepId === MODEL_STEP_ID)?.corrupt).toBe(true);
    expect(plan.actions.find((action) => action.action === "continue")?.available).toBe(false);
    await expect(freshHost.executeRecovery({ runId, action: "continue" })).rejects.toMatchObject({ code: "WORKFLOW_RECOVERY_BLOCKED" });
    expect(successorModel.calls.count).toBe(0);
  });

  it("R2-d2: a checkpoint header whose identity does not match the run row blocks continue", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const runId = await completedModelRun(rig, fixture, model);

    rig.database
      .prepare("UPDATE workflow_runtime_checkpoints SET head_sha = ? WHERE run_id = ?")
      .run("f".repeat(40), runId);

    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => makeModelBackend().entry });
    const plan = freshHost.getRunRecoveryPlan(runId);
    expect(plan.blockers.some((blocker) => blocker.code === "checkpoint_corrupt")).toBe(true);
    expect(plan.actions.find((action) => action.action === "continue")?.available).toBe(false);
  });

  it("R2: a structurally valid checkpoint is still reusable (no over-blocking)", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const runId = await completedModelRun(rig, fixture, model);

    const successorModel = makeModelBackend();
    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => successorModel.entry });
    const plan = freshHost.getRunRecoveryPlan(runId);
    expect(plan.blockers.some((blocker) => blocker.code === "checkpoint_corrupt")).toBe(false);
    expect(plan.steps.find((entry) => entry.stepId === MODEL_STEP_ID)?.reusable).toBe(true);
    const outcome = await freshHost.executeRecovery({ runId, action: "continue" });
    expect(outcome.executed).toBe(true);
    await waitForTerminal(freshHost, outcome.runId!);
    // 不重复结算: the valid verdict was restored, the model was not called again.
    expect(successorModel.calls.count).toBe(0);
  });
});

describe("Wave3 R2 — the same (run, step) key never silently absorbs a different input identity", () => {
  it("R2-d1: a second write with a different header identity is rejected and the first facts survive", () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    rig.store.insertRun({
      runId: "wfrun_identity",
      definitionId: MODEL_DEFINITION_ID,
      revisionId: MODEL_REVISION_ID,
      origin: "builtin",
      status: "running",
      repository: "test/fixture-canonical",
      repositoryOpaqueId: "repo-fixture",
      headSha: fixture.headSha,
      createdAt: new Date().toISOString(),
      evidence: [],
      lifecycleState: "running",
    });
    const base = {
      runId: "wfrun_identity",
      definitionId: MODEL_DEFINITION_ID,
      revisionId: MODEL_REVISION_ID,
      repository: "test/fixture-canonical",
      headSha: fixture.headSha,
      snapshotFingerprint: "a".repeat(64),
      definitionChecksum: runtimeBuiltinChecksum(WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS[MODEL_DEFINITION_ID]!),
    };
    const step = {
      stepId: ANALYZE_STEP_ID,
      serviceRef: "deterministic-evidence.analyzer",
      nodeKind: "deterministic-analyzer" as const,
      evidenceFingerprints: ["d".repeat(64)],
      result: { kind: "evidence-inputs", evidenceInputs: [] },
    };
    rig.checkpointStore.recordStepResult({ ...base, step });
    const headBefore = rig.checkpointStore.getCheckpoint("wfrun_identity")!.header;

    // Same key, DIFFERENT input identity (another head + fingerprint).
    expect(() => rig.checkpointStore.recordStepResult({
      ...base,
      headSha: "b".repeat(40),
      snapshotFingerprint: "e".repeat(64),
      step,
    })).toThrow(/identity|checkpoint/i);

    const after = rig.checkpointStore.getCheckpoint("wfrun_identity")!;
    expect(after.header.headSha).toBe(headBefore.headSha);
    expect(after.header.snapshotFingerprint).toBe(headBefore.snapshotFingerprint);
  });

  it("R2-d1b: a structurally invalid result is refused at WRITE time (never stored as reusable)", () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    rig.store.insertRun({
      runId: "wfrun_invalid_write",
      definitionId: MODEL_DEFINITION_ID,
      revisionId: MODEL_REVISION_ID,
      origin: "builtin",
      status: "running",
      repository: "test/fixture-canonical",
      repositoryOpaqueId: "repo-fixture",
      headSha: fixture.headSha,
      createdAt: new Date().toISOString(),
      evidence: [],
      lifecycleState: "running",
    });
    expect(() => rig.checkpointStore.recordStepResult({
      runId: "wfrun_invalid_write",
      definitionId: MODEL_DEFINITION_ID,
      revisionId: MODEL_REVISION_ID,
      repository: "test/fixture-canonical",
      headSha: fixture.headSha,
      snapshotFingerprint: "a".repeat(64),
      definitionChecksum: "c".repeat(64),
      step: {
        stepId: MODEL_STEP_ID,
        serviceRef: "model-structured.verifier",
        nodeKind: "llm-structured-verifier",
        evidenceFingerprints: ["d".repeat(64)],
        result: { kind: "model-verdict", modelVerdict: { nonsense: true } },
      },
    })).toThrow();
    expect(rig.checkpointStore.getStepResult("wfrun_invalid_write", MODEL_STEP_ID)).toBeUndefined();
  });
});
