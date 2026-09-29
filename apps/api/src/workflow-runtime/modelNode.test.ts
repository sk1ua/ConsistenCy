/**
 * H17 — model + read-only tool node tests (offline mock discipline).
 *
 *   M1  full vertical via the builtin `verified-model-review` definition
 *       (固定快照 → 确定性证据 → 只读工具 → 结构化模型核验 → report) driven by an
 *       offline deterministic model double: run succeeds, the model step's
 *       usage/model ride the H11 step event, the read-only tool issues real
 *       repo.read syscalls, and the report keeps every finding
 *       evidence-grounded. Restart-readable: a fresh host over the SAME
 *       database returns the full run record.
 *   M2  strict schema validation: a schema-invalid model output degrades
 *       honestly (run degraded, deterministic findings retained, explainable
 *       reason) — never a fabricated verification.
 *   M3  ungrounded verdicts (unknown fingerprints) degrade — no invented
 *       grounding.
 *   M4  无 key 拒绝: triggering a model-needing definition without a model
 *       entry is refused BEFORE any run record, with the accurate reason.
 *   M5  H13 cancellation mid-call: the scheduler's cancelRun aborts the
 *       in-flight model invocation (one causal id), the backend observes the
 *       abort, and the run fails deterministically (never degrades).
 *   M6  no model entry wired at all → the model node degrades while
 *       deterministic work survives.
 *
 * The model double NEVER touches a network or a credential; it derives its
 * verdicts from the prompt's own fingerprint digest (no stale fixtures).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { asRunId } from "@consistency/kernel";
import { RepositorySnapshot } from "@consistency/repository";
import { compileWorkflowRuntimeDefinition } from "./compile";
import { WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS, WORKFLOW_RUNTIME_BUILTIN_METADATA } from "./definition";
import {
  executeWorkflowPlan,
  type WorkflowExecutorLlmEntry,
  type WorkflowExecutorStepEvent,
  type WorkflowRunCreatedInfo,
  type WorkflowSnapshotInput,
} from "./executor";
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
const DEFECTIVE_CONTENT = [
  "export function leaky(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}  ",
  `export const leaked = "${SYNTHETIC_TOKEN}";`,
].join("\n");

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** 11 analyzable files: 10 carry a style defect; the 11th (omitted by quota) carries a preset secret defect. */
function makeElevenFileRepo(): { repoPath: string; headSha: string; omittedPath: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wf-model-"));
  TMP_DIRS.push(repoPath);
  git(repoPath, ["init", "-q"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  for (let index = 1; index <= 11; index += 1) {
    const name = `file${String(index).padStart(2, "0")}.ts`;
    const content = index === 11
      ? DEFECTIVE_CONTENT
      : `export function wide${index}(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}  `;
    fs.writeFileSync(path.join(repoPath, "src", name), content, "utf8");
  }
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", "fixture"]);
  return { repoPath, headSha: git(repoPath, ["rev-parse", "HEAD"]), omittedPath: "src/file11.ts" };
}

function makeSingleFileRepo(): { repoPath: string; headSha: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wf-model1-"));
  TMP_DIRS.push(repoPath);
  git(repoPath, ["init", "-q"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "src", "index.ts"), DEFECTIVE_CONTENT, "utf8");
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

/** Offline deterministic model double (never a product runtime; counts calls). */
function makeModelBackend(options: { readonly mode: "valid" | "invalid" | "ungrounded" | "wait-for-abort" }): {
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
      if (options.mode === "invalid") {
        return { data: { notTheSchema: true }, tokenUsage: usage };
      }
      const fingerprints = [...request.userPrompt.matchAll(/"fingerprint":"([0-9a-f]{64})"/g)].map((match) => match[1]!);
      if (options.mode === "ungrounded") {
        return {
          data: {
            findings: [{ evidenceFingerprint: "0".repeat(64), verdict: "confirmed", note: "fabricated grounding" }],
            summary: "ungrounded",
          },
          tokenUsage: usage,
        };
      }
      return {
        data: {
          findings: fingerprints.map((fingerprint) => ({ evidenceFingerprint: fingerprint, verdict: "confirmed" as const, note: "模型复核确认该证据成立" })),
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

const MODEL_DEFINITION_ID = "verified-model-review";
const MODEL_REVISION_ID = WORKFLOW_RUNTIME_BUILTIN_METADATA[MODEL_DEFINITION_ID]!.revisionId;

interface HostRig {
  readonly database: ConsistencyDatabase;
  readonly store: WorkflowRuntimeStore;
  readonly eventStore: WorkflowRuntimeEventStore;
  readonly checkpointStore: WorkflowRuntimeCheckpointStore;
  readonly host: WorkflowRuntimeHost;
}

function makeHostRig(repoPath: string, modelBackend?: () => Promise<WorkflowExecutorLlmEntry>): HostRig {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const store = new WorkflowRuntimeStore(database);
  const eventStore = new WorkflowRuntimeEventStore(database);
  const checkpointStore = new WorkflowRuntimeCheckpointStore(database);
  const host = new WorkflowRuntimeHost({
    store,
    eventStore,
    checkpointStore,
    resolveRepository: resolverFor(repoPath),
    ...(modelBackend === undefined ? {} : { modelBackend }),
  });
  host.initialize();
  return { database, store, eventStore, checkpointStore, host };
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

describe("H17 model node — M1: full vertical with the offline model double", () => {
  it("snapshot → deterministic evidence → read-only tool → structured model verification → report", async () => {
    const fixture = makeSingleFileRepo();
    const model = makeModelBackend({ mode: "valid" });
    const rig = makeHostRig(fixture.repoPath, async () => model.entry);

    const created = await rig.host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    expect(created.status).toBe("running");
    const run = await waitForTerminal(rig.host, created.runId);
    expect(run.status).toBe("succeeded");
    expect(model.calls.count).toBe(1); // exactly one billed model call
    expect(run.miniReport?.status).toBe("succeeded");
    expect(run.miniReport?.findings.length).toBeGreaterThanOrEqual(1);
    for (const finding of run.miniReport?.findings ?? []) {
      expect(finding.verified).toBe(true);
      for (const id of finding.evidenceIds) {
        expect(run.evidence.some((record) => record.id === id)).toBe(true);
      }
    }
    // The model-confirmed finding is present and refined (title prefix).
    expect(run.miniReport?.findings.some((finding) => finding.nodeId === "model-verify" && finding.title.startsWith("model-confirmed"))).toBe(true);

    // H11 events: run + per-step facts, with usage/model on the model step.
    const events = rig.eventStore.listEvents(created.runId);
    expect(events.some((event) => event.eventType === "run_started")).toBe(true);
    expect(events.some((event) => event.eventType === "run_succeeded")).toBe(true);
    const modelStep = events.find((event) => event.eventType === "step_succeeded" && event.stepId === "model-verify");
    expect(modelStep).toBeDefined();
    expect(modelStep?.payload.model).toBe("mock-fixture");
    expect((modelStep?.payload.usage as TokenUsage | undefined)?.totalTokens).toBe(46);
    // The read-only tool ran its own step with real repo.read syscalls.
    expect(events.some((event) => event.eventType === "step_succeeded" && event.stepId === "file-context")).toBe(true);

    // 重启后结果可读: a fresh host over the SAME database returns the record.
    const restartedHost = new WorkflowRuntimeHost({
      store: rig.store,
      eventStore: rig.eventStore,
      checkpointStore: rig.checkpointStore,
      resolveRepository: resolverFor(fixture.repoPath),
    });
    restartedHost.initialize();
    const reread = restartedHost.getRun(created.runId);
    expect(reread?.status).toBe("succeeded");
    expect(reread?.miniReport?.findings.length).toBe(run.miniReport?.findings.length);
    expect(reread?.coverage).toBeDefined();
  });
});

describe("H17 model node — M2/M3: strict validation yields explainable degraded outcomes", () => {
  it("M2: schema-invalid model output degrades; deterministic findings survive", async () => {
    const fixture = makeSingleFileRepo();
    const model = makeModelBackend({ mode: "invalid" });
    const rig = makeHostRig(fixture.repoPath, async () => model.entry);
    const created = await rig.host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    const run = await waitForTerminal(rig.host, created.runId);
    // Honestly NOT a success: coarse status failed + refined degraded lifecycle.
    expect(run.status).toBe("failed");
    expect(run.lifecycleState).toBe("degraded");
    expect(run.terminalReason).toBe("degraded_coverage");
    expect(run.miniReport?.status).toBe("degraded");
    expect(run.error).toContain("failed schema validation");
    // The deterministic verification was NOT discarded.
    expect(model.calls.count).toBe(1);
    expect(run.miniReport?.findings.some((finding) => finding.nodeId === "verify")).toBe(true);
    // The step fact is honestly failed in the ledger.
    const events = rig.eventStore.listEvents(created.runId);
    const modelStepFailed = events.find((event) => event.eventType === "step_failed" && event.stepId === "model-verify");
    expect(modelStepFailed).toBeDefined();
    expect(modelStepFailed?.error).toContain("failed schema validation");
  });

  it("M3: verdicts referencing unknown fingerprints degrade (no invented grounding)", async () => {
    const fixture = makeSingleFileRepo();
    const model = makeModelBackend({ mode: "ungrounded" });
    const rig = makeHostRig(fixture.repoPath, async () => model.entry);
    const created = await rig.host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    const run = await waitForTerminal(rig.host, created.runId);
    expect(run.status).toBe("failed");
    expect(run.lifecycleState).toBe("degraded");
    expect(run.error).toContain("fingerprint");
    expect(run.miniReport?.findings.some((finding) => finding.nodeId === "verify")).toBe(true);
  });
});

describe("H17 model node — M4: 无 key 时拒绝并给准确原因", () => {
  it("triggering a model-needing definition without a model entry refuses BEFORE any run record", async () => {
    const fixture = makeSingleFileRepo();
    const rig = makeHostRig(fixture.repoPath); // no modelBackend wired
    let refused: unknown;
    try {
      await rig.host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(WorkflowRuntimeStoreError);
    expect((refused as WorkflowRuntimeStoreError).code).toBe("WORKFLOW_MODEL_NOT_CONFIGURED");
    expect((refused as WorkflowRuntimeStoreError).statusCode).toBe(409);
    expect((refused as WorkflowRuntimeStoreError).message).toContain("尚未配置大语言模型");
    // No run row, no snapshot side effects.
    expect(rig.store.listRuns()).toHaveLength(0);

    // A factory that resolves nothing gives the accurate per-provider reason.
    const refusingRig = makeHostRig(fixture.repoPath, async () => {
      throw new WorkflowRuntimeStoreError("mock 尚未配置 API 密钥，无法执行审查。请在设置页配置该服务商的密钥。", "WORKFLOW_MODEL_NOT_CONFIGURED", 409);
    });
    let refusedProvider: unknown;
    try {
      await refusingRig.host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    } catch (error) {
      refusedProvider = error;
    }
    expect((refusedProvider as WorkflowRuntimeStoreError).message).toContain("尚未配置 API 密钥");
  });
});

describe("H17 model node — M5: H13 cancellation reaches the in-flight model call", () => {
  it("cancelRun aborts the invocation with one causal id; the run fails (never degrades)", async () => {
    const fixture = makeSingleFileRepo();
    const model = makeModelBackend({ mode: "wait-for-abort" });
    const compilation = compileWorkflowRuntimeDefinition(WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS[MODEL_DEFINITION_ID]!);
    if (!compilation.ok || !compilation.plan) throw new Error("model definition must compile");

    let schedulerRef: WorkflowRunCreatedInfo["scheduler"] | undefined;
    let runIdRef: ReturnType<typeof asRunId> | undefined;
    const stepEvents: WorkflowExecutorStepEvent[] = [];

    const result = await executeWorkflowPlan(
      compilation.plan,
      {
        repository: "test/workflow-slice",
        headSha: fixture.headSha,
        paths: ["src/index.ts"],
        snapshot: RepositorySnapshot.create({ repositoryPath: fixture.repoPath, repository: "test/workflow-slice", headSha: fixture.headSha, baseSha: fixture.headSha }),
      },
      {
        llm: model.entry,
        onRunCreated: (info) => {
          schedulerRef = info.scheduler;
          runIdRef = info.runId;
        },
        onAgentAdmitted: (info) => {
          if (info.nodeId === "model-verify") {
            // Cancel WHILE the model call is in flight (the backend blocks
            // on the signal until the scheduler cancels the run).
            setImmediate(() => {
              schedulerRef!.cancelRun(runIdRef!);
            });
          }
        },
        onStepEvent: (event) => {
          stepEvents.push(event);
        },
      },
    );

    expect(model.calls.count).toBe(1); // the call was dispatched, then aborted
    expect(result.status).toBe("failed");
    expect(result.error).toContain("run-cancelled");
    expect(result.error).toMatch(/cancel_[0-9a-f]+/);
    // The Kernel run keeps its cancelled terminal state.
    expect(result.scheduler.getRun(result.runId)?.state).toBe("CANCELLED");
    expect(result.miniReport.status).toBe("failed");
    expect(stepEvents.some((event) => event.eventType === "step_failed" && event.stepId === "model-verify")).toBe(true);
  });
});

describe("H17 model node — M6: no model entry wired → honest degrade, deterministic work survives", () => {
  it("the model step degrades with the unified-entry reason; verify findings remain", async () => {
    const fixture = makeSingleFileRepo();
    const compilation = compileWorkflowRuntimeDefinition(WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS[MODEL_DEFINITION_ID]!);
    if (!compilation.ok || !compilation.plan) throw new Error("model definition must compile");
    const result = await executeWorkflowPlan(
      compilation.plan,
      {
        repository: "test/workflow-slice",
        headSha: fixture.headSha,
        paths: ["src/index.ts"],
        snapshot: RepositorySnapshot.create({ repositoryPath: fixture.repoPath, repository: "test/workflow-slice", headSha: fixture.headSha, baseSha: fixture.headSha }),
      },
    );
    expect(result.status).toBe("degraded");
    expect(result.error).toContain("unified LLM entry");
    expect(result.miniReport.status).toBe("degraded");
    expect(result.miniReport.findings.some((finding) => finding.nodeId === "verify")).toBe(true);
  });
});

describe("H17 coverage — 11-file fixture: the 11th file is explicitly disclosed as uncovered", () => {
  it("quota selects 10, batches them deterministically, and lists the defective 11th file as omitted", async () => {
    const fixture = makeElevenFileRepo();
    const model = makeModelBackend({ mode: "valid" });
    const rig = makeHostRig(fixture.repoPath, async () => model.entry);

    const created = await rig.host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    const run = await waitForTerminal(rig.host, created.runId);
    expect(run.status).toBe("succeeded");

    const coverage = run.coverage;
    expect(coverage).toBeDefined();
    expect(coverage?.totalAnalyzable).toBe(11);
    expect(coverage?.quota).toBe(10);
    expect(coverage?.selectedCount).toBe(10);
    expect(coverage?.omittedCount).toBe(1);
    // 超限必须明确列出未覆盖范围 — the preset-defect file IS the omitted one.
    expect(coverage?.omittedPaths).toEqual([fixture.omittedPath]);
    expect(coverage?.omittedTruncated).toBe(false);
    expect(coverage?.batchSize).toBe(5);
    expect(coverage?.batchCount).toBe(2);
    expect(coverage?.selectedPaths).not.toContain(fixture.omittedPath);

    // Restart-readable disclosure (same database, fresh host).
    const restartedHost = new WorkflowRuntimeHost({
      store: rig.store,
      eventStore: rig.eventStore,
      checkpointStore: rig.checkpointStore,
      resolveRepository: resolverFor(fixture.repoPath),
    });
    restartedHost.initialize();
    expect(restartedHost.getRun(created.runId)?.coverage?.omittedPaths).toEqual([fixture.omittedPath]);
  });
});
