/**
 * Wave 3 / R3 残留（task-10）— 完成通知（H15）必须消费权威终态事实。
 *
 * 缺陷：`buildCompletionNotice` 用第二份 switch（`terminalReasonFor`）把
 * `failed` 一律映射成 `fatal_error`，而 host 的 `#onRunTerminal` 回调也不带
 * `lifecycleState/terminalReason`。于是取消/超时/预算耗尽/中断/降级/结果不可用
 * 的完成通知都会说 `fatal_error`，与已权威化的 run 行、事件读回冲突。
 *
 * 契约（本文件钉住）：
 *   - 通知的 `result` + `terminalReason` 来自与 run 行/事件相同的唯一映射
 *     （`projectRunTerminal`），取消/中断/降级/结果不可用不得被重解释；
 *   - host 的终态回调携带权威 triple（可选字段，向后兼容）；
 *   - 启动扫描把"中断"写入终态时同样走同一条终态写入路径，因此通知也会带上
 *     `interrupted`（而不是根本没有通知、或说成 fatal_error）；
 *   - 没有权威事实的历史调用方保留粗粒度回退（failed→fatal_error、
 *     succeeded→completed），且该回退有测试说明。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalReason, TokenUsage } from "@consistency/schema";
import type { TrustedLLMBackend } from "@consistency/workload-review";
import { WORKFLOW_RUNTIME_BUILTIN_METADATA } from "../workflow-runtime/definition";
import type { WorkflowExecutorLlmEntry } from "../workflow-runtime/executor";
import { WorkflowRuntimeHost, type WorkflowRepositoryResolver } from "../workflow-runtime/host";
import { WorkflowRuntimeStore } from "../workflow-runtime/store";
import { WorkflowRuntimeEventStore } from "../workflow-runtime/eventStore";
import { WorkflowRuntimeCheckpointStore } from "../workflow-runtime/checkpointStore";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import type { ConsistencyDatabase } from "../db/connection";
import { CompletionSink, type CompletionDeliveryRequest } from "./sink";
import { CompletionOutboxStore } from "./store";
import { buildCompletionNotice } from "./notices";

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
const FINISHED_AT = "2026-09-27T00:01:00.000Z";
const NOW = "2026-09-27T00:01:00.100Z";

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeFixtureRepo(): { repoPath: string; headSha: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wf-notice-"));
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

/** Sink + outbox over one real migrated database, capturing delivered payloads. */
function makeSink(database: ConsistencyDatabase): { sink: CompletionSink; delivered: Array<Record<string, unknown>> } {
  const delivered: Array<Record<string, unknown>> = [];
  const sink = new CompletionSink({
    store: new CompletionOutboxStore(database),
    destination: { url: "https://supervisor.invalid/hook" },
    deliver: async (request: CompletionDeliveryRequest) => {
      delivered.push(JSON.parse(request.payload) as Record<string, unknown>);
      return { ok: true };
    },
    now: () => new Date(NOW),
  });
  return { sink, delivered };
}

interface Rig {
  readonly database: ConsistencyDatabase;
  readonly store: WorkflowRuntimeStore;
  readonly eventStore: WorkflowRuntimeEventStore;
  readonly checkpointStore: WorkflowRuntimeCheckpointStore;
  host(options?: {
    readonly modelBackend?: () => Promise<WorkflowExecutorLlmEntry>;
    readonly resolver?: WorkflowRepositoryResolver;
    readonly sink?: CompletionSink;
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
        ...(options.sink === undefined ? {} : { onRunTerminal: (input) => options.sink!.recordTerminal(input) }),
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

/** The authoritative reason of ONE run, straight from the durable run row. */
function dbTerminalReason(database: ConsistencyDatabase, runId: string): string | null {
  const row = database
    .prepare("SELECT terminal_detail, terminal_reason FROM workflow_runtime_runs WHERE id = ?")
    .get(runId) as { terminal_detail: string | null; terminal_reason: string | null } | undefined;
  return row === undefined ? null : row.terminal_detail ?? row.terminal_reason;
}

describe("Wave3 R3 残留（task-10）— 完成通知消费权威终态，绝不重解释成 fatal_error", () => {
  it("W10-a1: every authoritative terminal class flows into the notice unchanged", () => {
    const cases: readonly {
      readonly label: string;
      readonly lifecycleState: "cancelled" | "failed" | "degraded" | "succeeded";
      readonly terminalReason: TerminalReason;
      readonly result: "succeeded" | "failed";
    }[] = [
      { label: "cancel", lifecycleState: "cancelled", terminalReason: "user_cancelled", result: "failed" },
      { label: "timeout", lifecycleState: "failed", terminalReason: "timeout", result: "failed" },
      { label: "budget", lifecycleState: "failed", terminalReason: "quota_exceeded", result: "failed" },
      { label: "degraded", lifecycleState: "degraded", terminalReason: "degraded_coverage", result: "failed" },
      { label: "result-unavailable", lifecycleState: "degraded", terminalReason: "result_unavailable", result: "failed" },
      { label: "interrupted", lifecycleState: "failed", terminalReason: "interrupted", result: "failed" },
      { label: "completed", lifecycleState: "succeeded", terminalReason: "completed", result: "succeeded" },
    ];
    for (const entry of cases) {
      const notice = buildCompletionNotice({
        runId: "wfrun_" + entry.label,
        status: entry.result,
        lifecycleState: entry.lifecycleState,
        terminalReason: entry.terminalReason,
        finishedAt: FINISHED_AT,
        evidence: [],
      }, { now: NOW });
      expect(notice.terminalReason).toBe(entry.terminalReason);
      expect(notice.result).toBe(entry.result);
      if (entry.terminalReason !== "fatal_error") {
        expect(notice.terminalReason).not.toBe("fatal_error");
      }
    }
  });

  it("W10-a2: a coarse status alone keeps the documented legacy fallback", () => {
    // Only the pre-R3 input shape (no refined facts) may fall back to the
    // coarse mapping — documented compatibility, not a reinterpretation of a
    // known refined reason.
    const succeeded = buildCompletionNotice({ runId: "wfrun_legacy_ok", status: "succeeded", finishedAt: FINISHED_AT, evidence: [] }, { now: NOW });
    const failed = buildCompletionNotice({ runId: "wfrun_legacy_bad", status: "failed", finishedAt: FINISHED_AT, evidence: [] }, { now: NOW });
    expect(succeeded.terminalReason).toBe("completed");
    expect(failed.terminalReason).toBe("fatal_error");
  });

  it("W10-a3: a reason contradicting the authoritative state is refused, never silently coerced", () => {
    expect(() => buildCompletionNotice({
      runId: "wfrun_contradiction",
      status: "succeeded",
      lifecycleState: "succeeded",
      terminalReason: "fatal_error",
      finishedAt: FINISHED_AT,
      evidence: [],
    }, { now: NOW })).toThrow(/contradict/i);
  });

  it("W10-a4: a degraded host run notifies degraded_coverage — identical to the DB run row", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const { sink, delivered } = makeSink(rig.database);
    const model = makeModelBackend({ mode: "invalid" });
    const host = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => model.entry, sink });
    const created = await host.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    const finished = await waitForTerminal(host, created.runId);
    await sink.flushOnce();

    expect(finished.lifecycleState).toBe("degraded");
    expect(delivered.length).toBe(1);
    const notice = delivered[0]!;
    expect(notice.runId).toBe(created.runId);
    expect(notice.terminalReason).toBe("degraded_coverage");
    expect(notice.terminalReason).toBe(dbTerminalReason(rig.database, created.runId));
    expect(notice.result).toBe("failed");
    await sink.stop();
  });

  it("W10-a5: a restart-interrupted run notifies interrupted — never fatal_error, and never silence", async () => {
    const fixture = makeFixtureRepo();
    const rig = makeRig();
    const model = makeModelBackend();
    const firstHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => model.entry });
    const created = await firstHost.trigger({ repositoryId: "repo-fixture", definitionId: MODEL_DEFINITION_ID, revisionId: MODEL_REVISION_ID });
    await waitForTerminal(firstHost, created.runId);

    // Controlled crash window: the terminal write never landed.
    rig.database
      .prepare("UPDATE workflow_runtime_runs SET status = 'running', finished_at = NULL, error = NULL, lifecycle_state = NULL, terminal_reason = NULL, terminal_detail = NULL WHERE id = ?")
      .run(created.runId);
    rig.database.prepare("DELETE FROM workflow_runtime_events WHERE run_id = ? AND event_type IN ('run_succeeded', 'run_failed')").run(created.runId);

    // Restart: the startup scan records the interruption. That IS a terminal
    // transition, so the supervisor is notified with the real reason.
    const { sink, delivered } = makeSink(rig.database);
    const freshHost = rig.host({ resolver: resolverFor(fixture.repoPath), modelBackend: async () => makeModelBackend().entry, sink });
    await sink.flushOnce();

    const run = freshHost.getRun(created.runId);
    expect(run?.status).toBe("failed");
    expect(run?.terminalReason).toBe("interrupted");
    expect(dbTerminalReason(rig.database, created.runId)).toBe("interrupted");
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.terminalReason).toBe("interrupted");
    expect(delivered[0]!.terminalReason).toBe(run?.terminalReason);
    await sink.stop();
  });

  it("W10-a6: a cancelled run written through the durable terminal path notifies user_cancelled", async () => {
    const rig = makeRig();
    const { sink, delivered } = makeSink(rig.database);
    const host = rig.host({ sink });
    const runId = "wfrun_cancelled";
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
    // Exactly how the host writes a terminal: one transaction, the same
    // authoritative triple on the row and the event, then the notice.
    rig.eventStore.recordEvent(
      {
        eventType: "run_failed",
        runId,
        correlationId: runId,
        fromState: "running",
        toState: "cancelled",
        terminalReason: "user_cancelled",
        error: "run-cancelled (cancel_task10): Scheduler cancelled the run",
      },
      {
        applyRunUpdate: () => rig.store.updateRunTerminal({
          runId,
          status: "failed",
          finishedAt: FINISHED_AT,
          evidence: [],
          error: "run-cancelled (cancel_task10): Scheduler cancelled the run",
          lifecycleState: "cancelled",
          terminalReason: "user_cancelled",
        }),
      },
    );
    const run = host.getRun(runId)!;
    sink.recordTerminal({
      runId,
      status: "failed",
      lifecycleState: run.lifecycleState,
      terminalReason: run.terminalReason,
      finishedAt: FINISHED_AT,
      evidence: [],
      error: run.error,
    });
    await sink.flushOnce();

    expect(run.lifecycleState).toBe("cancelled");
    expect(run.terminalReason).toBe("user_cancelled");
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.terminalReason).toBe("user_cancelled");
    expect(delivered[0]!.terminalReason).toBe(dbTerminalReason(rig.database, runId));
    await sink.stop();
  });
});
