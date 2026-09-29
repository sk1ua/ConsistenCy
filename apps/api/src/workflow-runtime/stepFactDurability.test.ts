/**
 * Wave 3 / R1 — key execution facts must be DURABLE BEFORE the calls they
 * describe (flush-before-dispatch).
 *
 * The defect this file pins down: the host's execution hooks swallowed every
 * step-fact write failure, so the executor dispatched a paid model call after
 * a `step_started` write that never landed. A crash in that window left no
 * durable "sent" fact and recovery could have re-issued the call.
 *
 * Contract under test:
 *   - `step_started` (dispatch INTENT), `step_succeeded` / `step_failed`
 *     (OUTCOME) and a paid step's reusable-result checkpoint are REQUIRED
 *     facts: a failed write is visible to the executor and blocks the call;
 *   - a step that was dispatched but never resulted folds to
 *     `outcome_unknown` and blocks `continue` — nothing is ever re-sent;
 *   - a completed paid step whose checkpoint write failed must NOT be
 *     reported as safely continuable: the run degrades with the explicit
 *     `result_unavailable` terminal reason and the old rows stay intact.
 *
 * Windows note: there is no upstream hard-crash harness here. Every "crash"
 * below is a CONTROLLED in-process fault injection (a throwing hook, a
 * throwing store double, or a durable state fabricated through real SQL)
 * against the REAL host + REAL SQLite + REAL git fixture repositories. The
 * only double is the offline deterministic model backend.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowRuntimeExecutablePlan } from "@consistency/schema";
import { RepositorySnapshot } from "@consistency/repository";
import type { TrustedLLMBackend } from "@consistency/workload-review";
import type { TokenUsage } from "@consistency/schema";
import { compileWorkflowRuntimeDefinition } from "./compile";
import { WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS, WORKFLOW_RUNTIME_BUILTIN_METADATA, runtimeBuiltinChecksum, VERIFIED_MINI_REVIEW_DEFINITION } from "./definition";
import { executeWorkflowPlan, type WorkflowExecutorLlmEntry, type WorkflowSnapshotInput } from "./executor";
import { WorkflowRuntimeHost, type WorkflowRepositoryResolver } from "./host";
import { WorkflowRuntimeStore } from "./store";
import { WorkflowRuntimeEventStore, type WorkflowRuntimeEventInput } from "./eventStore";
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

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeFixtureRepo(): { repoPath: string; headSha: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wf-durability-"));
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
          binding: {
            repositoryId,
            displayName: "Fixture Local Repo",
            remoteFullName: "test/fixture-canonical",
            localPath: repoPath,
          },
        }
      : undefined;
}

/** Offline deterministic model backend double (counts every invocation and
 * can observe the durable ledger AT invocation time). */
function makeModelBackend(options: {
  readonly onInvoke?: () => void;
} = {}): { readonly entry: WorkflowExecutorLlmEntry; readonly calls: { count: number } } {
  const calls = { count: 0 };
  const usage: TokenUsage = { inputTokens: 12, outputTokens: 34, totalTokens: 46 };
  const backend = {
    invokeStructured: async (request: { userPrompt: string; signal?: AbortSignal }) => {
      calls.count += 1;
      options.onInvoke?.();
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
    readonly resolver?: WorkflowRepositoryResolver;
    readonly modelBackend?: () => Promise<WorkflowExecutorLlmEntry>;
    readonly eventStore?: WorkflowRuntimeEventStore;
    readonly checkpointStore?: WorkflowRuntimeCheckpointStore;
  }): WorkflowRuntimeHost;
}

function makeRig(modelBackend?: () => Promise<WorkflowExecutorLlmEntry>): Rig {
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
        eventStore: options.eventStore ?? eventStore,
        checkpointStore: options.checkpointStore ?? checkpointStore,
        resolveRepository: options.resolver ?? (() => undefined),
        ...((options.modelBackend ?? modelBackend) === undefined ? {} : { modelBackend: options.modelBackend ?? modelBackend }),
      });
      host.initialize();
      return host;
    },
  };
}

/** Event-store double whose write of ONE required fact fails (injected). */
function faultyEventStore(
  real: WorkflowRuntimeEventStore,
  shouldFail: (input: WorkflowRuntimeEventInput) => boolean,
): WorkflowRuntimeEventStore {
  return {
    recordEvent: (input: WorkflowRuntimeEventInput, options?: { readonly applyRunUpdate?: () => void }) => {
      if (shouldFail(input)) throw new Error("injected event write failure (" + input.eventType + ")");
      return real.recordEvent(input, options);
    },
    listEvents: (runId: string) => real.listEvents(runId),
    countEvents: (runId: string) => real.countEvents(runId),
  } as unknown as WorkflowRuntimeEventStore;
}

/** Checkpoint-store double whose write of ONE step's result fails (injected). */
function faultyCheckpointStore(
  real: WorkflowRuntimeCheckpointStore,
  shouldFail: (stepId: string) => boolean,
): WorkflowRuntimeCheckpointStore {
  return {
    recordStepResult: (input: { readonly step: { readonly stepId: string } }) => {
      if (shouldFail(input.step.stepId)) throw new Error("injected checkpoint write failure (" + input.step.stepId + ")");
      return (real.recordStepResult as (value: unknown) => void)(input);
    },
    markInterrupted: (input: Parameters<WorkflowRuntimeCheckpointStore["markInterrupted"]>[0]) => real.markInterrupted(input),
    ensureHeader: (input: Parameters<WorkflowRuntimeCheckpointStore["ensureHeader"]>[0]) => real.ensureHeader(input),
    getCheckpoint: (runId: string) => real.getCheckpoint(runId),
    getStepResult: (runId: string, stepId: string) => real.getStepResult(runId, stepId),
  } as unknown as WorkflowRuntimeCheckpointStore;
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

function modelPlan(): WorkflowRuntimeExecutablePlan {
  const compilation = compileWorkflowRuntimeDefinition(WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS[MODEL_DEFINITION_ID]!);
  if (!compilation.ok || !compilation.plan) throw new Error("model definition must compile");
  return compilation.plan;
}

function snapshotInput(fixture: { repoPath: string; headSha: string }): WorkflowSnapshotInput {
  return {
    repository: "test/fixture-canonical",
    headSha: fixture.headSha,
    paths: ["src/index.ts"],
    snapshot: RepositorySnapshot.create({
      repositoryPath: fixture.repoPath,
      repository: "test/fixture-canonical",
      headSha: fixture.headSha,
      baseSha: fixture.headSha,
    }),
  };
}

describe("Wave3 R1 — flush-before-dispatch: required step facts block the call they describe", () => {
  it("R1-a1: a failing step_started write for the paid step means ZERO provider invocations (host)", async () => {
    const fixture = makeFixtureRepo();
    const model = makeModelBackend();
    const rig = makeRig(async () => model.entry);
    const failing = faultyEventStore(rig.eventStore, (input) => input.eventType === "step_started" && input.stepId === MODEL_STEP_ID);
    const host = rig.host({ resolver: resolverFor(fixture.repoPath), eventStore: failing });

    const created = await host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    const finished = await waitForTerminal(host, created.runId);

    // The intent write failed ⇒ the paid call was NEVER dispatched.
    expect(model.calls.count).toBe(0);
    expect(finished.status).toBe("failed");
    expect(finished.error ?? "").toContain(MODEL_STEP_ID);

    // The durable ledger never claims this step was started.
    const events = rig.eventStore.listEvents(created.runId);
    expect(events.some((event) => event.eventType === "step_started" && event.stepId === MODEL_STEP_ID)).toBe(false);
    // No reusable result pretends to exist for the step that never ran.
    expect(rig.checkpointStore.getStepResult(created.runId, MODEL_STEP_ID)).toBeUndefined();
  });

  it("R1-a2: an injected intent-write failure stops the step BEFORE dispatch (executor)", async () => {
    const fixture = makeFixtureRepo();
    const model = makeModelBackend();
    let failIntent = true;
    const startedSteps: string[] = [];
    const result = await executeWorkflowPlan(modelPlan(), snapshotInput(fixture), {
      llm: model.entry,
      onStepEvent: (event) => {
        if (event.eventType === "step_started") {
          startedSteps.push(event.stepId);
          if (failIntent) throw new Error("injected intent write failure");
        }
      },
    });

    expect(startedSteps.length).toBe(1); // stopped at the very FIRST step
    expect(model.calls.count).toBe(0);
    expect(result.status).toBe("failed");
    expect(result.error ?? "").toContain("injected intent write failure");
    // Nothing protected ran: no syscall was ever authorized, no evidence exists.
    expect(result.miniReport.audit).toEqual({ allowed: 0, denied: 0 });
    expect(result.evidence.length).toBe(0);
    failIntent = false;
  });

  it("R1-a3: the durable step_started exists BEFORE the provider is invoked (flush-before-dispatch)", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    let runId = "";
    let ledgerAtInvoke: ReturnType<WorkflowRuntimeEventStore["listEvents"]> = [];
    let checkpointAtInvoke: ReturnType<WorkflowRuntimeCheckpointStore["getStepResult"]>;
    const model = makeModelBackend({
      onInvoke: () => {
        ledgerAtInvoke = rig.eventStore.listEvents(runId);
        checkpointAtInvoke = rig.checkpointStore.getStepResult(runId, MODEL_STEP_ID);
      },
    });
    const host = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => model.entry });
    const created = await host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    runId = created.runId;
    const finished = await waitForTerminal(host, created.runId);

    expect(finished.status).toBe("succeeded");
    expect(model.calls.count).toBe(1);
    const intent = ledgerAtInvoke.find((event) => event.eventType === "step_started" && event.stepId === MODEL_STEP_ID);
    expect(intent).toBeDefined();
    // The outcome (and the reusable result) do NOT exist yet at dispatch time.
    expect(ledgerAtInvoke.some((event) => event.stepId === MODEL_STEP_ID && (event.eventType === "step_succeeded" || event.eventType === "step_failed"))).toBe(false);
    expect(checkpointAtInvoke).toBeUndefined();
  });

  it("R1-b1: a failing step_succeeded write fails the run instead of claiming a durable outcome (executor)", async () => {
    const fixture = makeFixtureRepo();
    const model = makeModelBackend();
    const result = await executeWorkflowPlan(modelPlan(), snapshotInput(fixture), {
      llm: model.entry,
      onStepEvent: (event) => {
        if (event.eventType === "step_succeeded" && event.stepId === MODEL_STEP_ID) {
          throw new Error("injected outcome write failure");
        }
      },
    });

    // The paid call happened exactly once, but the run never claims a durable
    // outcome — it fails closed instead of reporting a resumable success.
    expect(model.calls.count).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.error ?? "").toContain("injected outcome write failure");
    expect(result.miniReport.status).toBe("failed");
  });

  it("R1-d1: a failed checkpoint write for the completed paid step degrades the run with result_unavailable and keeps old rows", async () => {
    const fixture = makeFixtureRepo();
    const model = makeModelBackend();
    const rig = makeRig(async () => model.entry);
    // Only the PAID step's checkpoint write fails; the analyzer's row lands.
    const failing = faultyCheckpointStore(rig.checkpointStore, (stepId) => stepId === MODEL_STEP_ID);
    const host = rig.host({ resolver: resolverFor(fixture.repoPath), checkpointStore: failing });

    const created = await host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    const finished = await waitForTerminal(host, created.runId);

    // 不得伪报可安全继续: the paid call HAPPENED (billed once) and its result
    // is not durably reusable ⇒ the run is honestly degraded, never "succeeded".
    expect(model.calls.count).toBe(1);
    expect(finished.status).toBe("failed");
    expect(finished.lifecycleState).toBe("degraded");
    expect(finished.terminalReason).toBe("result_unavailable");
    expect(finished.error ?? "").toContain(MODEL_STEP_ID);

    // The old (analyzer) checkpoint row is preserved; nothing is deleted.
    const analyzeRow = rig.checkpointStore.getStepResult(created.runId, "analyze");
    expect(analyzeRow).toBeDefined();
    expect(analyzeRow?.nodeKind).toBe("deterministic-analyzer");
    expect(rig.checkpointStore.getStepResult(created.runId, MODEL_STEP_ID)).toBeUndefined();
  });

  it("R1-c1: a dispatched-but-unresulted paid step folds to outcome_unknown and is NEVER re-sent", async () => {
    const fixture = makeFixtureRepo();
    const model = makeModelBackend();
    const rig = makeRig(async () => model.entry);
    const host = rig.host({ resolver: resolverFor(fixture.repoPath) });
    const created = await host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    const finished = await waitForTerminal(host, created.runId);
    expect(finished.status).toBe("succeeded");
    expect(model.calls.count).toBe(1);

    // Controlled crash window: the paid step was dispatched (durable
    // step_started) and the process died before its outcome/terminal write.
    // Fabricated through real SQL, exactly like the H14 crash simulations.
    rig.database
      .prepare("UPDATE workflow_runtime_runs SET status = 'running', finished_at = NULL, mini_report_json = NULL, error = NULL, lifecycle_state = NULL, terminal_reason = NULL, terminal_detail = NULL WHERE id = ?")
      .run(created.runId);
    rig.database
      .prepare("DELETE FROM workflow_runtime_events WHERE run_id = ? AND event_type IN ('run_succeeded', 'run_failed')")
      .run(created.runId);
    rig.database
      .prepare("DELETE FROM workflow_runtime_events WHERE run_id = ? AND step_id = ? AND event_type = 'step_succeeded'")
      .run(created.runId, MODEL_STEP_ID);
    rig.database
      .prepare("DELETE FROM workflow_runtime_checkpoint_steps WHERE run_id = ? AND step_id = ?")
      .run(created.runId, MODEL_STEP_ID);

    // Restart: the startup scan marks the run interrupted, the fold sees a
    // dispatched step without a terminal fact.
    const successorModel = makeModelBackend();
    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => successorModel.entry });
    const plan = freshHost.getRunRecoveryPlan(created.runId);
    const step = plan.steps.find((entry) => entry.stepId === MODEL_STEP_ID);
    expect(step?.outcome).toBe("outcome_unknown");
    expect(step?.reusable).toBe(false);
    const continueAction = plan.actions.find((action) => action.action === "continue");
    expect(continueAction?.available).toBe(false);
    expect(continueAction?.blockers.some((blocker) => blocker.code === "step_outcome_unknown" && blocker.stepId === MODEL_STEP_ID)).toBe(true);

    let blocked: unknown;
    try {
      await freshHost.executeRecovery({ runId: created.runId, action: "continue" });
    } catch (error) {
      blocked = error;
    }
    expect((blocked as { code?: string }).code).toBe("WORKFLOW_RECOVERY_BLOCKED");
    // 绝不自动重发: no successor run, no new provider invocation, no re-billing.
    expect(successorModel.calls.count).toBe(0);
    expect(model.calls.count).toBe(1);
    expect(freshHost.getRun(created.runId)?.status).toBe("failed");
  });
});

describe("Wave3 R1 — the verified-mini-review vertical keeps its durability contract", () => {
  it("R1-a4: a failing intent write on the deterministic analyzer never dispatches the repo/analyzer work", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const failing = faultyEventStore(rig.eventStore, (input) => input.eventType === "step_started");
    const host = rig.host({ resolver: resolverFor(fixture.repoPath), eventStore: failing });
    const created = await host.trigger({
      repositoryId: "repo-fixture",
      definitionId: VERIFIED_MINI_REVIEW_DEFINITION.id,
      revisionId: WORKFLOW_RUNTIME_BUILTIN_METADATA[VERIFIED_MINI_REVIEW_DEFINITION.id]!.revisionId,
    });
    const finished = await waitForTerminal(host, created.runId);

    expect(finished.status).toBe("failed");
    // Zero syscalls, zero evidence: nothing protected ran without a durable intent.
    expect(finished.miniReport?.audit).toEqual({ allowed: 0, denied: 0 });
    expect(finished.evidence.length).toBe(0);
    expect(finished.error ?? "").toContain("intent");
  });
});
