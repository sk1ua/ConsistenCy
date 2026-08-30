/**
 * CKPT5 Slice 1 — trigger contract tests.
 *
 *   T1  migration 0020: existing bindings keep `manual` trigger mode; runs
 *       keep NULL trigger provenance (no fabricated history).
 *   T2  binding trigger mode lifecycle: setBinding accepts and persists
 *       `on_change`; absent mode keeps the current value; default rows are
 *       manual; the DTO always carries the mode.
 *   T3  run trigger provenance: manual route runs record {source:"manual"};
 *       triggerBinding with a repository_change context records the event id;
 *       the field is observability data only (run outcome unchanged).
 *   T4  trigger plan ledger: insert is idempotent under the UNIQUE
 *       (repository, definition, dedupe_key); claim is a fenced single-winner
 *       transition; complete is terminal-only; startup recovery marks
 *       interrupted `executing` plans failed honestly and the same event can
 *       never silently re-execute (dedupe key stays).
 *
 * Route-level tests run the REAL createApiServer + host + SQLite
 * (in-memory, migrated); fixtures are throwaway temp Git repositories.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../http";
import { openDatabase } from "../db/connection";
import { migrations, runMigrations } from "../db/migrations";
import { sanitizeExecutionError } from "../security/redact";
import { WorkflowRuntimeHost, type WorkflowRepositoryResolver } from "./host";
import { WorkflowRuntimeStore, WorkflowRuntimeStoreError } from "./store";
import {
  WorkflowTriggerExecutor,
  WorkflowTriggerPlanner,
  workflowTriggerPlanDedupeKey
} from "./triggers";

const TMP_DIRS: string[] = [];
afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const HEAD_CONTENT = [
  'export const token = "ghp_" + "F".repeat(36);',
  "export function wide(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}  ",
  "export const fine = 1;",
].join("\n");

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeFixtureRepo(name: string): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wf5-"));
  TMP_DIRS.push(repoPath);
  git(repoPath, ["init", "-q"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoPath, "src-index.ts"), HEAD_CONTENT, "utf8");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", name]);
  return repoPath;
}

function singleRepoResolver(repoPath: string): WorkflowRepositoryResolver {
  return id => {
    if (id === "repo-a") return { status: "ok", binding: { repositoryId: id, displayName: "Repo A", remoteFullName: "test/repo-a", localPath: repoPath } };
    return undefined;
  };
}

interface Rig {
  server: ReturnType<typeof createApiServer>;
  port: number;
  database: ReturnType<typeof openDatabase>;
  host: WorkflowRuntimeHost;
}

function makeApi(options: { repoA: string; database?: ReturnType<typeof openDatabase> }): Promise<Rig> {
  const database = options.database ?? openDatabase(":memory:");
  runMigrations(database);
  const store = new WorkflowRuntimeStore(database);
  const host = new WorkflowRuntimeHost({ store, resolveRepository: singleRepoResolver(options.repoA) });
  host.initialize();
  const server = createApiServer({ workflowRuntime: host });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0, database, host });
    });
  });
}

function httpJson(
  port: number,
  method: "GET" | "POST" | "PUT" | "DELETE",
  pathName: string,
  payload?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const raw = payload === undefined ? "" : JSON.stringify(payload);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathName,
        method,
        headers: {
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
          ...(raw.length === 0 ? {} : { "content-length": String(Buffer.byteLength(raw)) }),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: body.length === 0 ? undefined : JSON.parse(body) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    if (raw.length > 0) req.write(raw);
    req.end();
  });
}

async function withRig(test: (rig: Rig) => Promise<void>): Promise<void> {
  const repoPath = makeFixtureRepo("ckpt5-trigger-contract");
  const rig = await makeApi({ repoA: repoPath });
  try {
    await test(rig);
  } finally {
    await new Promise<void>((resolve) => rig.server.close(() => resolve()));
  }
}

describe("CKPT5 Slice 1 — trigger contract", () => {
  it("T1 migration 0020: pre-existing bindings/runs gain manual mode / NULL provenance without fabricated history", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database, migrations.filter(migration => migration.id < "0020"));
      // Legacy CKPT3 rows, written with the pre-0020 shape.
      database.prepare(`
        INSERT INTO workflow_runtime_bindings (repository_id, definition_id, enabled, created_at, updated_at)
        VALUES ('repo-a', 'verified-mini-review', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')
      `).run();
      database.prepare(`
        INSERT INTO workflow_runtime_runs
          (id, definition_id, revision_id, origin, status, repository, repository_id, head_sha,
           created_at, finished_at, evidence_json, mini_report_json, error)
        VALUES ('wfrun_legacy', 'verified-mini-review', 'wfrev_1', 'builtin', 'succeeded',
          'test/repo-a', 'repo-a', 'head1', '2026-08-01T00:00:00Z', '2026-08-01T00:00:01Z', '[]', NULL, NULL)
      `).run();

      expect(runMigrations(database, migrations)).toEqual(["0020_workflow_runtime_triggers", "0021_audit_execution_bridge", "0022_audit_runtime_only_runs"]);
      const binding = database
        .prepare("SELECT trigger_mode FROM workflow_runtime_bindings WHERE repository_id = 'repo-a'")
        .get() as { trigger_mode: string };
      expect(binding.trigger_mode).toBe("manual");
      const run = database
        .prepare("SELECT trigger_source, trigger_event_id FROM workflow_runtime_runs WHERE id = 'wfrun_legacy'")
        .get() as { trigger_source: string | null; trigger_event_id: string | null };
      expect(run).toEqual({ trigger_source: null, trigger_event_id: null });
      const plansTable = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runtime_trigger_plans'")
        .get();
      expect(plansTable).toBeTruthy();
    } finally {
      database.close();
    }
  });

  it("T2 binding trigger mode lifecycle (route level)", async () => {
    await withRig(async (rig) => {
      const enable = await httpJson(rig.port, "PUT", "/workflow-runtime/repositories/repo-a/bindings/verified-mini-review", { enabled: true });
      expect(enable.status).toBe(200);
      expect(((enable.body as { binding: { triggerMode: string } }).binding).triggerMode).toBe("manual");

      const switchMode = await httpJson(rig.port, "PUT", "/workflow-runtime/repositories/repo-a/bindings/verified-mini-review", { enabled: true, triggerMode: "on_change" });
      expect(switchMode.status).toBe(200);
      expect(((switchMode.body as { binding: { triggerMode: string } }).binding).triggerMode).toBe("on_change");

      // Absent triggerMode keeps the stored value (partial update semantics).
      const keepMode = await httpJson(rig.port, "PUT", "/workflow-runtime/repositories/repo-a/bindings/verified-mini-review", { enabled: false });
      expect(keepMode.status).toBe(200);
      const kept = (keepMode.body as { binding: { triggerMode: string; enabled: boolean } }).binding;
      expect(kept.triggerMode).toBe("on_change");
      expect(kept.enabled).toBe(false);

      const list = await httpJson(rig.port, "GET", "/workflow-runtime/repositories/repo-a/bindings");
      const listed = (list.body as { bindings: Array<{ triggerMode: string }> }).bindings;
      expect(listed[0]?.triggerMode).toBe("on_change");
    });
  });

  it("T3 run trigger provenance: manual route records manual; repository_change context records the event id", async () => {
    await withRig(async (rig) => {
      await httpJson(rig.port, "PUT", "/workflow-runtime/repositories/repo-a/bindings/verified-mini-review", { enabled: true });
      const manual = await httpJson(rig.port, "POST", "/workflow-runtime/repositories/repo-a/runs", { definitionId: "verified-mini-review" });
      expect(manual.status).toBe(201);
      const manualRunId = (manual.body as { runId: string }).runId;
      const manualRun = await httpJson(rig.port, "GET", `/workflow-runtime/runs/${manualRunId}`);
      expect((manualRun.body as { trigger?: { source: string } }).trigger).toEqual({ source: "manual" });

      const auto = await rig.host.triggerBinding({
        repositoryId: "repo-a",
        definitionId: "verified-mini-review",
        trigger: { source: "repository_change", eventId: "repository_event_abc" },
      });
      const autoRun = await httpJson(rig.port, "GET", `/workflow-runtime/runs/${auto.runId}`);
      expect((autoRun.body as { trigger?: { source: string; eventId?: string } }).trigger).toEqual({
        source: "repository_change",
        eventId: "repository_event_abc",
      });

      const repoRuns = await httpJson(rig.port, "GET", "/workflow-runtime/repositories/repo-a/runs");
      const runs = (repoRuns.body as { runs: Array<{ runId: string; trigger?: { source: string } }> }).runs;
      const withTriggers = runs.filter((run) => run.trigger !== undefined);
      expect(withTriggers.length).toBe(2);
      expect(new Set(withTriggers.map((run) => run.trigger!.source))).toEqual(new Set(["manual", "repository_change"]));
    });
  });

  it("T4 trigger plan ledger: idempotent insert, fenced claim, terminal completion, honest restart recovery", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new WorkflowRuntimeStore(database);

      const first = store.insertTriggerPlan({
        repositoryId: "repo-a",
        definitionId: "verified-mini-review",
        dedupeKey: "repository-supervisor:abc",
        sourceEventId: "repository_event_abc",
      });
      expect(first.created).toBe(true);
      expect(first.plan.status).toBe("pending");

      const replay = store.insertTriggerPlan({
        repositoryId: "repo-a",
        definitionId: "verified-mini-review",
        dedupeKey: "repository-supervisor:abc",
        sourceEventId: "repository_event_abc",
      });
      expect(replay.created).toBe(false);
      expect(replay.plan.id).toBe(first.plan.id);

      // Same event, different definition → a distinct plan.
      const other = store.insertTriggerPlan({
        repositoryId: "repo-a",
        definitionId: "user-def",
        dedupeKey: "repository-supervisor:abc",
        sourceEventId: "repository_event_abc",
      });
      expect(other.created).toBe(true);

      // Fenced claim: exactly one claimant wins.
      const claimed = store.claimTriggerPlan(first.plan.id);
      expect(claimed?.status).toBe("executing");
      expect(store.claimTriggerPlan(first.plan.id)).toBeUndefined();

      // Terminal transition refuses a non-executing plan.
      expect(store.completeTriggerPlan({ id: other.plan.id, status: "succeeded", runId: "wfrun_x" })).toBeUndefined();

      const completed = store.completeTriggerPlan({ id: first.plan.id, status: "succeeded", runId: "wfrun_real" });
      expect(completed?.status).toBe("succeeded");
      expect(completed?.runId).toBe("wfrun_real");

      // Restart recovery: an `executing` plan is failed honestly, and the
      // dedupe key still blocks a duplicate plan for the same event.
      const pending = store.insertTriggerPlan({
        repositoryId: "repo-b",
        definitionId: "verified-mini-review",
        dedupeKey: "repository-supervisor:def",
        sourceEventId: "repository_event_def",
      });
      expect(store.claimTriggerPlan(pending.plan.id)?.status).toBe("executing");
      const recovered = store.recoverInterruptedTriggerPlans();
      expect(recovered).toBe(1);
      const after = store.getTriggerPlanById(pending.plan.id);
      expect(after?.status).toBe("failed");
      expect(after?.error).toBe("trigger execution interrupted by API restart");
      expect(store.insertTriggerPlan({
        repositoryId: "repo-b",
        definitionId: "verified-mini-review",
        dedupeKey: "repository-supervisor:def",
        sourceEventId: "repository_event_def",
      }).created).toBe(false);
      // Only the never-claimed plan remains pending; claimed/completed/recovered
      // ones never reappear.
      expect(store.listPendingTriggerPlans().map((plan) => plan.id)).toEqual([other.plan.id]);
    } finally {
      database.close();
    }
  });

  it("T4a completeTriggerPlan sanitizes malicious errors at the persistence boundary", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new WorkflowRuntimeStore(database);
      const inserted = store.insertTriggerPlan({
        repositoryId: "repo-a",
        definitionId: "verified-mini-review",
        dedupeKey: "repository-supervisor:malicious-error",
        sourceEventId: "repository_event_malicious-error",
      });
      expect(store.claimTriggerPlan(inserted.plan.id)?.status).toBe("executing");

      const maliciousError = [
        "failed at C:\\\\Users\\\\alice\\\\secret.ts",
        "also /home/alice/private/repo/src/index.ts",
        "ghp_123456789012345678901234567890123456",
        "Authorization: Bearer super-secret-token-value",
        "Error: boom",
        "    at run (C:\\\\Users\\\\alice\\\\secret.ts:12:3)",
      ].join("\n");
      const completed = store.completeTriggerPlan({
        id: inserted.plan.id,
        status: "failed",
        error: maliciousError,
      });

      const raw = database
        .prepare("SELECT error FROM workflow_runtime_trigger_plans WHERE id = ?")
        .get(inserted.plan.id) as { error: string | null };
      expect(raw.error).toBe(sanitizeExecutionError(maliciousError));
      expect(raw.error).not.toContain("C:\\\\Users");
      expect(raw.error).not.toContain("/home/alice");
      expect(raw.error).not.toContain("ghp_123456789012345678901234567890123456");
      expect(raw.error).not.toContain("super-secret-token-value");
      expect(raw.error).not.toContain("\n");

      expect(completed?.error).toBe(raw.error);
      expect(store.getTriggerPlanById(inserted.plan.id)?.error).toBe(raw.error);

      for (const error of [undefined, null]) {
        const noError = store.insertTriggerPlan({
          repositoryId: "repo-a",
          definitionId: "verified-mini-review",
          dedupeKey: `repository-supervisor:no-error-${String(error)}`,
          sourceEventId: `repository_event_no-error-${String(error)}`,
        });
        store.claimTriggerPlan(noError.plan.id);
        store.completeTriggerPlan({ id: noError.plan.id, status: "failed", error: error as string | undefined });
        const noErrorRaw = database
          .prepare("SELECT error FROM workflow_runtime_trigger_plans WHERE id = ?")
          .get(noError.plan.id) as { error: string | null };
        expect(noErrorRaw.error).toBeNull();
      }
    } finally {
      database.close();
    }
  });

  it("T5 planner: on_change bindings plan idempotently; manual/disabled never plan; distinct events plan distinctly", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new WorkflowRuntimeStore(database);
      store.setBinding({ repositoryId: "repo-a", definitionId: "def-onchange", enabled: true, triggerMode: "on_change" });
      store.setBinding({ repositoryId: "repo-a", definitionId: "def-manual", enabled: true, triggerMode: "manual" });
      store.setBinding({ repositoryId: "repo-a", definitionId: "def-disabled", enabled: false, triggerMode: "on_change" });

      const planner = new WorkflowTriggerPlanner({ store });
      const event = { id: "repository_event_abc", repositoryId: "repo-a", dedupeKey: "repository-supervisor:k1" };

      const first = planner.planRepositoryEvent(event);
      expect(first).toEqual([{ definitionId: "def-onchange", planId: expect.any(String), created: true }]);

      // Replay of the same persisted event is a no-op (durable dedupe).
      const replay = planner.planRepositoryEvent(event);
      expect(replay).toEqual([{ definitionId: "def-onchange", planId: first[0]!.planId, created: false }]);

      // A different repository event (new head / new config digest) plans anew.
      const second = planner.planRepositoryEvent({ id: "repository_event_def", repositoryId: "repo-a", dedupeKey: "repository-supervisor:k2" });
      expect(second[0]!.created).toBe(true);
      expect(second[0]!.planId).not.toBe(first[0]!.planId);

      // Events for repositories without on_change bindings plan nothing.
      expect(planner.planRepositoryEvent({ id: "repository_event_xyz", repositoryId: "repo-b", dedupeKey: "repository-supervisor:k3" })).toEqual([]);

      // The plan identity is domain-separated and definition-scoped.
      expect(workflowTriggerPlanDedupeKey({ repositoryId: "repo-a", dedupeKey: "k" }, "d1"))
        .not.toBe(workflowTriggerPlanDedupeKey({ repositoryId: "repo-a", dedupeKey: "k" }, "d2"));
      expect(workflowTriggerPlanDedupeKey({ repositoryId: "repo-a", dedupeKey: "k" }, "d1"))
        .toBe(workflowTriggerPlanDedupeKey({ repositoryId: "repo-a", dedupeKey: "k" }, "d1"));
    } finally {
      database.close();
    }
  });

  it("T6 executor: single-flight drain, one attempt per plan, skipped vs failed semantics, no retry", async () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new WorkflowRuntimeStore(database);
      const calls: Array<{ repositoryId: string; definitionId: string; trigger: { source: string; eventId?: string } }> = [];
      let attempt = 0;
      const failing = new WorkflowRuntimeStoreError(
        "Workflow binding is disabled for this repository",
        "WORKFLOW_BINDING_DISABLED",
        409
      );
      const executor = new WorkflowTriggerExecutor({
        store,
        trigger: async input => {
          calls.push(input);
          attempt += 1;
          if (input.definitionId === "def-skip") throw failing;
          if (input.definitionId === "def-fail") throw new Error("D:/secret/path is broken");
          return { runId: "wfrun_" + input.definitionId };
        },
        batchSize: 10,
      });

      store.insertTriggerPlan({ repositoryId: "repo-a", definitionId: "def-ok", dedupeKey: "k1", sourceEventId: "event-1" });
      store.insertTriggerPlan({ repositoryId: "repo-a", definitionId: "def-skip", dedupeKey: "k2", sourceEventId: "event-2" });
      store.insertTriggerPlan({ repositoryId: "repo-a", definitionId: "def-fail", dedupeKey: "k3", sourceEventId: "event-3" });

      await executor.tick();
      expect(calls.map(call => call.definitionId).sort()).toEqual(["def-fail", "def-ok", "def-skip"]);
      expect(calls.every(call => call.trigger.source === "repository_change")).toBe(true);
      expect(calls.every(call => typeof call.trigger.eventId === "string")).toBe(true);

      const ok = store.getTriggerPlan("repo-a", "def-ok", "k1")!;
      expect(ok.status).toBe("succeeded");
      expect(ok.runId).toBe("wfrun_def-ok");

      const skip = store.getTriggerPlan("repo-a", "def-skip", "k2")!;
      expect(skip.status).toBe("skipped");

      const fail = store.getTriggerPlan("repo-a", "def-fail", "k3")!;
      expect(fail.status).toBe("failed");
      // Sanitized: no absolute path leaked into the persisted reason.
      expect(fail.error).not.toContain("D:/secret");

      // One attempt per plan: a second tick finds nothing pending.
      await executor.tick();
      expect(attempt).toBe(3);
      expect(store.listPendingTriggerPlans()).toEqual([]);
      expect(executor.status).toMatchObject({ createdRuns: 1, skippedPlans: 1, failedPlans: 1 });
    } finally {
      database.close();
    }
  });

  it("T7 integration: planned event → executor → REAL canonical run via host with repository_change provenance", async () => {
    await withRig(async (rig) => {
      // Enable + on_change via the real route (also exercising reconciliation hook absence-safety).
      const set = await httpJson(rig.port, "PUT", "/workflow-runtime/repositories/repo-a/bindings/verified-mini-review", { enabled: true, triggerMode: "on_change" });
      expect(set.status).toBe(200);

      const database = rig.database;
      const store = new WorkflowRuntimeStore(database);
      const planner = new WorkflowTriggerPlanner({ store });
      const outcomes = planner.planRepositoryEvent({ id: "repository_event_live", repositoryId: "repo-a", dedupeKey: "repository-supervisor:live" });
      expect(outcomes.length).toBe(1);
      expect(outcomes[0]!.created).toBe(true);

      const executor = new WorkflowTriggerExecutor({ store, trigger: input => rig.host.triggerBinding(input) });
      await executor.tick();

      const plan = store.getTriggerPlanById(outcomes[0]!.planId)!;
      expect(plan.status).toBe("succeeded");
      expect(plan.runId).toMatch(/^wfrun_/);

      const runDetail = await httpJson(rig.port, "GET", `/workflow-runtime/runs/${plan.runId}`);
      expect(runDetail.status).toBe(200);
      const run = runDetail.body as { trigger?: { source: string; eventId?: string }; definitionId: string };
      expect(run.trigger).toEqual({ source: "repository_change", eventId: "repository_event_live" });
      expect(run.definitionId).toBe("verified-mini-review");
    });
  });
});
