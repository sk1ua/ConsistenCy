/**
 * Repository workflow binding tests — CKPT3 Phase 3 TEST O/P/Q/R.
 *
 *   TEST O  binding lifecycle: enable → listed; repeated enable idempotent
 *            (no duplicate rows); disable flips state; unknown repositoryId /
 *            definitionId → sanitized 404 with zero side effects.
 *   TEST P  per-repo trigger: enabled binding + real git fixture repository →
 *            succeeded run recording definitionId + the RESOLVED revisionId;
 *            truthful provenance (canonical identity + real HEAD); the run
 *            appears in the per-repository runs filter.
 *   TEST Q  isolation & enforcement: repo A's bindings do not affect repo B;
 *            disabled binding trigger → 409, run count unchanged, zero
 *            authorization events; binding to a deleted definition lists
 *            honestly (unavailable) and triggers 404/409.
 *   TEST R  DTO hygiene: bindings / per-repo runs responses carry no secret /
 *            raw path / token / handle; per-repo runs bounded.
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
import type { WorkflowRuntimeDefinition } from "@consistency/schema";
import { createApiServer } from "../http";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { WorkflowRuntimeHost, type WorkflowRepositoryResolver } from "./host";
import { WorkflowRuntimeStore } from "./store";

const TMP_DIRS: string[] = [];
afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SYNTHETIC_TOKEN = `ghp_${"F".repeat(36)}`;
const HEAD_CONTENT = [
  'export const token = "' + SYNTHETIC_TOKEN + '";',
  "export function wide(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}  ",
  "export const fine = 1;",
].join("\n");

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeFixtureRepo(name: string): { repoPath: string; headSha: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wf3-"));
  TMP_DIRS.push(repoPath);
  git(repoPath, ["init", "-q"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "src", "index.ts"), HEAD_CONTENT, "utf8");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", name]);
  return { repoPath, headSha: git(repoPath, ["rev-parse", "HEAD"]) };
}

/** Two-repository resolver: repo-a and repo-b (canonical remote identities). */
function twoRepoResolver(a: string, b: string): WorkflowRepositoryResolver {
  return id => {
    if (id === "repo-a") return { status: "ok", binding: { repositoryId: id, displayName: "Repo A", remoteFullName: "test/repo-a", localPath: a } };
    if (id === "repo-b") return { status: "ok", binding: { repositoryId: id, displayName: "Repo B", remoteFullName: "test/repo-b", localPath: b } };
    return undefined;
  };
}

interface Rig {
  server: ReturnType<typeof createApiServer>;
  port: number;
  database: ReturnType<typeof openDatabase>;
}

function makeApi(options: { repoA: string; repoB: string; database?: ReturnType<typeof openDatabase> }): Promise<Rig> {
  const database = options.database ?? openDatabase(":memory:");
  runMigrations(database);
  const store = new WorkflowRuntimeStore(database);
  const host = new WorkflowRuntimeHost({ store, resolveRepository: twoRepoResolver(options.repoA, options.repoB) });
  host.initialize();
  const server = createApiServer({ workflowRuntime: host });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0, database });
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
            resolve({ status: res.statusCode ?? 0, body: body.length === 0 ? null : JSON.parse(body) });
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

async function waitForTerminal(
  port: number,
  runId: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await httpJson(port, "GET", "/workflow-runtime/runs/" + runId);
    const body = response.body as Record<string, unknown>;
    if (body.status !== "running" || Date.now() > deadline) return body;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function userDefinition(id: string): WorkflowRuntimeDefinition {
  return {
    id,
    version: 1,
    nodes: [
      { id: "analyze", type: "analyzer.deterministic-evidence", serviceRef: "deterministic-evidence.analyzer", parameters: {}, failurePolicy: "fail-closed" },
      { id: "verify", type: "verifier.persisted-evidence", serviceRef: "persisted-evidence.verifier", parameters: {}, failurePolicy: "fail-closed" },
    ],
    edges: [{ from: "analyze", to: "verify" }],
  };
}

const A_BINDINGS = "/workflow-runtime/repositories/repo-a/bindings";
const B_BINDINGS = "/workflow-runtime/repositories/repo-b/bindings";

describe("TEST O — binding lifecycle", () => {
  it("enable → listed with definition summary; repeat enable idempotent; disable flips; unknown ids 404 with zero side effects", async () => {
    const repoA = makeFixtureRepo("a");
    const repoB = makeFixtureRepo("b");
    const rig = await makeApi({ repoA: repoA.repoPath, repoB: repoB.repoPath });
    try {
      // Unknown repository → sanitized 404, no binding side effect.
      const unknownRepo = await httpJson(rig.port, "PUT", "/workflow-runtime/repositories/ghost/bindings/my-def", { enabled: true });
      expect(unknownRepo.status).toBe(404);
      expect((unknownRepo.body as { error: { code: string } }).error.code).toBe("REPOSITORY_NOT_FOUND");

      // Unknown definition → sanitized 404.
      const unknownDef = await httpJson(rig.port, "PUT", A_BINDINGS + "/no-such-definition", { enabled: true });
      expect(unknownDef.status).toBe(404);
      expect((unknownDef.body as { error: { code: string } }).error.code).toBe("WORKFLOW_DEFINITION_NOT_FOUND");

      // Enable the builtin definition.
      const enabled = await httpJson(rig.port, "PUT", A_BINDINGS + "/verified-mini-review", { enabled: true });
      expect(enabled.status).toBe(200);
      const binding = (enabled.body as { binding: { repositoryId: string; definitionId: string; enabled: boolean; definition: { origin: string; latestRevision: number } | null } }).binding;
      expect(binding.repositoryId).toBe("repo-a");
      expect(binding.definitionId).toBe("verified-mini-review");
      expect(binding.enabled).toBe(true);
      expect(binding.definition?.origin).toBe("builtin");

      // Repeated enable → idempotent, exactly one row.
      const again = await httpJson(rig.port, "PUT", A_BINDINGS + "/verified-mini-review", { enabled: true });
      expect(again.status).toBe(200);
      const list1 = await httpJson(rig.port, "GET", A_BINDINGS);
      const bindings1 = (list1.body as { bindings: unknown[] }).bindings;
      expect(bindings1).toHaveLength(1);

      // Disable flips state.
      const disabled = await httpJson(rig.port, "PUT", A_BINDINGS + "/verified-mini-review", { enabled: false });
      expect((disabled.body as { binding: { enabled: boolean } }).binding.enabled).toBe(false);
      const list2 = await httpJson(rig.port, "GET", A_BINDINGS);
      expect((list2.body as { bindings: { enabled: boolean }[] }).bindings[0]!.enabled).toBe(false);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});

describe("TEST P — per-repository trigger", () => {
  it("enabled binding + real git repo → succeeded run with resolved revisionId and truthful provenance, visible in per-repo filter", async () => {
    const repoA = makeFixtureRepo("a");
    const repoB = makeFixtureRepo("b");
    const rig = await makeApi({ repoA: repoA.repoPath, repoB: repoB.repoPath });
    try {
      const saved = await httpJson(rig.port, "POST", "/workflow-runtime/definitions", { definition: userDefinition("bound-review") });
      const revisionId = (saved.body as { revision: { revisionId: string } }).revision.revisionId;
      await httpJson(rig.port, "PUT", A_BINDINGS + "/bound-review", { enabled: true });

      // Append a second (validated) revision AFTER enabling: D2 resolves the
      // LATEST validated revision at trigger time.
      const saved2 = await httpJson(rig.port, "POST", "/workflow-runtime/definitions", {
        definitionId: "bound-review",
        definition: userDefinition("bound-review"),
      });
      const revisionId2 = (saved2.body as { revision: { revisionId: string } }).revision.revisionId;

      const created = await httpJson(rig.port, "POST", "/workflow-runtime/repositories/repo-a/runs", { definitionId: "bound-review" });
      expect(created.status).toBe(201);
      expect((created.body as { revisionId: string }).revisionId).toBe(revisionId2);
      expect((created.body as { revisionId: string }).revisionId).not.toBe(revisionId);

      const done = await waitForTerminal(rig.port, (created.body as { runId: string }).runId);
      expect(done.status).toBe("succeeded");
      expect(done.definitionId).toBe("bound-review");
      expect(done.revisionId).toBe(revisionId2);
      // Truthful provenance: canonical repository identity + real HEAD.
      expect((done.snapshot as { repository: string }).repository).toBe("test/repo-a");
      expect((done.snapshot as { headSha: string }).headSha).toBe(repoA.headSha);
      const evidence = done.evidence as Array<{ repository: string; sha: string }>;
      expect(evidence.length).toBeGreaterThanOrEqual(1);
      for (const record of evidence) {
        expect(record.repository).toBe("test/repo-a");
        expect(record.sha).toBe(repoA.headSha);
      }

      // The run appears in the per-repository filter (canonical id join)…
      const aRuns = await httpJson(rig.port, "GET", "/workflow-runtime/repositories/repo-a/runs");
      const aSummaries = (aRuns.body as { runs: { runId: string }[] }).runs;
      expect(aSummaries.some((run) => run.runId === (created.body as { runId: string }).runId)).toBe(true);
      // …and NOT in repo-b's history (isolation preview of TEST Q).
      const bRuns = await httpJson(rig.port, "GET", "/workflow-runtime/repositories/repo-b/runs");
      expect((bRuns.body as { runs: unknown[] }).runs).toHaveLength(0);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});

describe("TEST Q — isolation & enforcement", () => {
  it("repo A bindings do not leak to repo B; disabled trigger 409 with zero new runs; deleted definition honest", async () => {
    const repoA = makeFixtureRepo("a");
    const repoB = makeFixtureRepo("b");
    const rig = await makeApi({ repoA: repoA.repoPath, repoB: repoB.repoPath });
    try {
      await httpJson(rig.port, "PUT", A_BINDINGS + "/verified-mini-review", { enabled: true });

      // Isolation: B's binding list is empty; triggering on B is 404 binding.
      const bList = await httpJson(rig.port, "GET", B_BINDINGS);
      expect((bList.body as { bindings: unknown[] }).bindings).toHaveLength(0);
      const bTrigger = await httpJson(rig.port, "POST", "/workflow-runtime/repositories/repo-b/runs", { definitionId: "verified-mini-review" });
      expect(bTrigger.status).toBe(404);
      expect((bTrigger.body as { error: { code: string } }).error.code).toBe("WORKFLOW_BINDING_NOT_FOUND");

      // Disabled binding → 409 fail-closed BEFORE any run/snapshot/authz.
      await httpJson(rig.port, "PUT", A_BINDINGS + "/verified-mini-review", { enabled: false });
      const beforeRuns = await httpJson(rig.port, "GET", "/workflow-runtime/runs");
      const countBefore = (beforeRuns.body as { runs: unknown[] }).runs.length;
      const disabledTrigger = await httpJson(rig.port, "POST", "/workflow-runtime/repositories/repo-a/runs", { definitionId: "verified-mini-review" });
      expect(disabledTrigger.status).toBe(409);
      expect((disabledTrigger.body as { error: { code: string } }).error.code).toBe("WORKFLOW_BINDING_DISABLED");
      const afterRuns = await httpJson(rig.port, "GET", "/workflow-runtime/runs");
      expect((afterRuns.body as { runs: unknown[] }).runs.length).toBe(countBefore);

      // Deleted definition: binding lists honestly (definition: null) and
      // triggering fails closed 404.
      await httpJson(rig.port, "POST", "/workflow-runtime/definitions", { definition: userDefinition("doomed") });
      await httpJson(rig.port, "PUT", A_BINDINGS + "/doomed", { enabled: true });
      await httpJson(rig.port, "DELETE", "/workflow-runtime/definitions/doomed");
      const listed = await httpJson(rig.port, "GET", A_BINDINGS);
      const doomedBinding = (listed.body as { bindings: { definitionId: string; definition: unknown }[] }).bindings.find(b => b.definitionId === "doomed");
      expect(doomedBinding).toBeDefined();
      expect(doomedBinding!.definition).toBeNull();
      const doomedTrigger = await httpJson(rig.port, "POST", "/workflow-runtime/repositories/repo-a/runs", { definitionId: "doomed" });
      expect([404, 409]).toContain(doomedTrigger.status);

      // Definition with NO validated revision (draft only) → 409 not-executable.
      const draft = {
        ...userDefinition("draft-only"),
        edges: [
          { from: "analyze", to: "verify" },
          { from: "verify", to: "analyze" },
        ],
      };
      await httpJson(rig.port, "POST", "/workflow-runtime/definitions", { definition: draft });
      await httpJson(rig.port, "PUT", A_BINDINGS + "/draft-only", { enabled: true });
      const draftTrigger = await httpJson(rig.port, "POST", "/workflow-runtime/repositories/repo-a/runs", { definitionId: "draft-only" });
      expect(draftTrigger.status).toBe(409);
      expect((draftTrigger.body as { error: { code: string } }).error.code).toBe("WORKFLOW_DEFINITION_NOT_EXECUTABLE");
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});

describe("TEST R — public DTO hygiene + bounded per-repo runs", () => {
  it("bindings and per-repo runs responses are sanitized and bounded", async () => {
    const repoA = makeFixtureRepo("a");
    const repoB = makeFixtureRepo("b");
    const rig = await makeApi({ repoA: repoA.repoPath, repoB: repoB.repoPath });
    try {
      await httpJson(rig.port, "PUT", A_BINDINGS + "/verified-mini-review", { enabled: true });
      const created = await httpJson(rig.port, "POST", "/workflow-runtime/repositories/repo-a/runs", { definitionId: "verified-mini-review" });
      await waitForTerminal(rig.port, (created.body as { runId: string }).runId);

      const surfaces = [
        JSON.stringify(await httpJson(rig.port, "GET", A_BINDINGS)),
        JSON.stringify(await httpJson(rig.port, "GET", "/workflow-runtime/repositories/repo-a/runs")),
        JSON.stringify(await httpJson(rig.port, "GET", "/workflow-runtime/repositories/repo-a/runs?limit=1")),
      ].join("\n");
      expect(surfaces).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
      expect(surfaces).not.toMatch(/[A-Za-z]:\\/);
      expect(surfaces).not.toMatch(/"handle"|capabilityHandle/i);
      expect(surfaces).not.toContain(repoA.repoPath.replace(/\\/g, "/"));

      // Bounded: limit=1 returns at most one summary even after multiple runs.
      const second = await httpJson(rig.port, "POST", "/workflow-runtime/repositories/repo-a/runs", { definitionId: "verified-mini-review" });
      await waitForTerminal(rig.port, (second.body as { runId: string }).runId);
      const bounded = await httpJson(rig.port, "GET", "/workflow-runtime/repositories/repo-a/runs?limit=1");
      expect((bounded.body as { runs: unknown[] }).runs.length).toBeLessThanOrEqual(1);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});
