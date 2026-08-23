/**
 * Workflow Runtime host + HTTP route tests — CKPT3 Phase 2.
 *
 *   TEST J  definition lifecycle: create draft → schema-invalid 400 without
 *            saving → graph-invalid draft saved with issues but trigger
 *            refused → fixed revision N+1 executable → old-revision history
 *            intact; builtin immutable.
 *   TEST K  run persistence: trigger → rebuild store+host over the SAME
 *            database (simulated restart) → run history with evidence/
 *            findings/audit summary + revisionId still readable.
 *   TEST L  dry-load truth: all-registered definition → feasible with ✓s;
 *            unregistered node type / mismatched serviceRef → ✗ + sanitized
 *            reason + not-feasible; disclaimer field present.
 *   TEST M  revision immutability: a run pinned to revision R completes with
 *            the OLD definition even after a new revision is appended;
 *            deleting a definition with run history is refused; completed
 *            runs stay readable.
 *   TEST N  DTO hygiene: definitions/runs/feasibility responses carry no
 *            secret/token/handle/absolute-path/synthetic ids.
 *
 * Phase 1.1 semantics (TEST H/I) are re-verified against the Phase 2 trigger
 * contract (revision-pinned; canonical snapshot wiring unchanged).
 *
 * Route-level tests run the REAL createApiServer + REAL host + REAL SQLite
 * (in-memory, migrated); the only fixture is a throwaway temp Git repository.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  workflowRuntimeRunV2Schema,
  type WorkflowRuntimeDefinition,
} from "@consistency/schema";
import { createApiServer } from "../http";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { WorkflowRuntimeHost, type WorkflowRepositoryResolver } from "./host";
import { WorkflowRuntimeStore } from "./store";
import { VERIFIED_MINI_REVIEW_DEFINITION } from "./definition";

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

function makeFixtureRepo(): { repoPath: string; headSha: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wf2-"));
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

function fixtureResolver(repoPath: string, repositoryId = "repo-fixture"): WorkflowRepositoryResolver {
  return id =>
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

interface ApiRig {
  server: ReturnType<typeof createApiServer>;
  port: number;
  host: WorkflowRuntimeHost;
  store: WorkflowRuntimeStore;
  database: ReturnType<typeof openDatabase>;
}

function makeApi(options: { repoPath: string; database?: ReturnType<typeof openDatabase>; store?: WorkflowRuntimeStore }): Promise<ApiRig> {
  const database = options.database ?? openDatabase(":memory:");
  runMigrations(database);
  const store = options.store ?? new WorkflowRuntimeStore(database);
  const host = new WorkflowRuntimeHost({ store, resolveRepository: fixtureResolver(options.repoPath) });
  host.initialize();
  const server = createApiServer({ workflowRuntime: host });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port, host, store, database });
    });
  });
}

function httpJson(
  port: number,
  method: "GET" | "POST" | "DELETE",
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await httpJson(port, "GET", "/workflow-runtime/runs/" + runId);
    const body = response.body as Record<string, unknown>;
    if (body.status !== "running" || Date.now() > deadline) return { status: response.status, body };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function triggerAndWait(rig: ApiRig, body: unknown): Promise<Record<string, unknown>> {
  const created = await httpJson(rig.port, "POST", "/workflow-runtime/runs", body);
  expect(created.status).toBe(201);
  const { runId } = created.body as { runId: string };
  const done = await waitForTerminal(rig.port, runId);
  expect(done.status).toBe(200);
  return done.body;
}

/** A minimal VALID user definition (analyzer + verifier). */
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

describe("Unchanged endpoints (Phase 1 regression)", () => {
  it("GET /workflow-runtime/overview returns the built-in definition and registry node types", async () => {
    const fixture = makeFixtureRepo();
    const rig = await makeApi({ repoPath: fixture.repoPath });
    try {
      const response = await httpJson(rig.port, "GET", "/workflow-runtime/overview");
      expect(response.status).toBe(200);
      const body = response.body as { definition: { id: string }; nodeTypes: { type: string }[] };
      expect(body.definition.id).toBe("verified-mini-review");
      expect(body.nodeTypes.map((nodeType) => nodeType.type).sort()).toEqual([
        "analyzer.deterministic-evidence",
        "verifier.persisted-evidence",
      ]);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });

  it("POST /workflow-runtime/validate returns both success and failure states", async () => {
    const fixture = makeFixtureRepo();
    const rig = await makeApi({ repoPath: fixture.repoPath });
    try {
      const ok = await httpJson(rig.port, "POST", "/workflow-runtime/validate", { definition: VERIFIED_MINI_REVIEW_DEFINITION });
      expect(ok.status).toBe(200);
      expect((ok.body as { ok: boolean }).ok).toBe(true);

      const broken = await httpJson(rig.port, "POST", "/workflow-runtime/validate", {
        definition: { ...VERIFIED_MINI_REVIEW_DEFINITION, nodes: [{ ...VERIFIED_MINI_REVIEW_DEFINITION.nodes[0]!, type: "analyzer.not-registered" }, VERIFIED_MINI_REVIEW_DEFINITION.nodes[1]!] },
      });
      expect((broken.body as { ok: boolean }).ok).toBe(false);
      expect((broken.body as { errors: { code: string }[] }).errors.some((issue) => issue.code === "unknown_node_type")).toBe(true);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });

  it("unknown runs return 404; unknown repository trigger → sanitized 404 with zero runs (TEST I carry-over)", async () => {
    const fixture = makeFixtureRepo();
    const rig = await makeApi({ repoPath: fixture.repoPath });
    try {
      const missing = await httpJson(rig.port, "GET", "/workflow-runtime/runs/wfrun_missing");
      expect(missing.status).toBe(404);

      const unknown = await httpJson(rig.port, "POST", "/workflow-runtime/runs", { repositoryId: "ghost-repo" });
      expect(unknown.status).toBe(404);
      expect((unknown.body as { error: { code: string } }).error.code).toBe("REPOSITORY_NOT_FOUND");
      const listed = await httpJson(rig.port, "GET", "/workflow-runtime/runs");
      expect((listed.body as { runs: unknown[] }).runs).toHaveLength(0);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});

describe("TEST H carry-over — canonical snapshot binding (Phase 2 trigger contract)", () => {
  it("triggers on a registered repository and reports truthful provenance", async () => {
    const fixture = makeFixtureRepo();
    const rig = await makeApi({ repoPath: fixture.repoPath });
    try {
      const done = await triggerAndWait(rig, { repositoryId: "repo-fixture" });
      const run = workflowRuntimeRunV2Schema.parse(done);
      expect(run.status).toBe("succeeded");
      expect(run.snapshot.repository).toBe("test/fixture-canonical");
      expect(run.snapshot.headSha).toBe(fixture.headSha);
      expect(run.origin).toBe("builtin");
      expect(run.revisionId).toMatch(/^wfrev_|^builtin-seed/);
      for (const record of run.evidence) {
        expect(record.repository).toBe("test/fixture-canonical");
        expect(record.sha).toBe(fixture.headSha);
      }
      expect(run.miniReport?.findings.length).toBeGreaterThanOrEqual(1);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });

  it("same HEAD → stable fingerprints; new commit (new HEAD) → changed fingerprints", async () => {
    const fixture = makeFixtureRepo();
    const rig = await makeApi({ repoPath: fixture.repoPath });
    try {
      const first = workflowRuntimeRunV2Schema.parse(await triggerAndWait(rig, { repositoryId: "repo-fixture" }));
      const second = workflowRuntimeRunV2Schema.parse(await triggerAndWait(rig, { repositoryId: "repo-fixture" }));
      const fingerprints = (run: typeof first) => new Set(run.evidence.map((record) => record.fingerprint));
      expect(fingerprints(second)).toEqual(fingerprints(first));

      fs.writeFileSync(path.join(fixture.repoPath, "src", "index.ts"), HEAD_CONTENT.replace("fine = 1", "fine = 2"), "utf8");
      git(fixture.repoPath, ["add", "."]);
      git(fixture.repoPath, ["commit", "-q", "-m", "changed"]);
      const third = workflowRuntimeRunV2Schema.parse(await triggerAndWait(rig, { repositoryId: "repo-fixture" }));
      expect(third.snapshot.headSha).not.toBe(first.snapshot.headSha);
      const base = fingerprints(first);
      expect(third.evidence.some((record) => !base.has(record.fingerprint))).toBe(true);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});

describe("TEST J — definition lifecycle", () => {
  it("draft → schema-invalid 400 (nothing saved) → graph-invalid saved-but-not-executable → fixed revision executable; builtin immutable", async () => {
    const fixture = makeFixtureRepo();
    const rig = await makeApi({ repoPath: fixture.repoPath });
    try {
      // (a) Schema-invalid body → 400, nothing saved (zod reject at the route).
      const invalid = await httpJson(rig.port, "POST", "/workflow-runtime/definitions", {
        definition: { id: "bad", version: 2, nodes: [], edges: [] },
      });
      expect(invalid.status).toBe(400);
      const afterInvalid = await httpJson(rig.port, "GET", "/workflow-runtime/definitions");
      expect((afterInvalid.body as { definitions: { definitionId: string }[] }).definitions.map((d) => d.definitionId)).toEqual([
        "verified-mini-review",
      ]);

      // (b) Graph-invalid draft (cycle) → saved with issues, not executable.
      const cyclic: WorkflowRuntimeDefinition = {
        ...userDefinition("my-review"),
        edges: [
          { from: "analyze", to: "verify" },
          { from: "verify", to: "analyze" },
        ],
      };
      const savedDraft = await httpJson(rig.port, "POST", "/workflow-runtime/definitions", { definition: cyclic });
      expect(savedDraft.status).toBe(201);
      const draftRevision = (savedDraft.body as { revision: { revisionId: string; revision: number; status: string; validationIssues: { code: string }[] } }).revision;
      expect(draftRevision.status).toBe("draft_with_issues");
      expect(draftRevision.validationIssues.some((issue) => issue.code === "graph_cycle")).toBe(true);

      // Triggering the graph-invalid revision → 409 fail-closed, no run.
      const refused = await httpJson(rig.port, "POST", "/workflow-runtime/runs", {
        repositoryId: "repo-fixture",
        definitionId: "my-review",
        revisionId: draftRevision.revisionId,
      });
      expect(refused.status).toBe(409);
      expect((refused.body as { error: { code: string } }).error.code).toBe("WORKFLOW_DEFINITION_NOT_EXECUTABLE");
      const runsAfterRefusal = await httpJson(rig.port, "GET", "/workflow-runtime/runs");
      expect((runsAfterRefusal.body as { runs: unknown[] }).runs).toHaveLength(0);

      // (c) Fixed definition → revision 2, validated, executable.
      const fixed = await httpJson(rig.port, "POST", "/workflow-runtime/definitions", {
        definitionId: "my-review",
        definition: userDefinition("my-review"),
      });
      expect(fixed.status).toBe(201);
      const fixedRevision = (fixed.body as { revision: { revisionId: string; revision: number; status: string } }).revision;
      expect(fixedRevision.revision).toBe(2);
      expect(fixedRevision.status).toBe("validated");

      const done = await triggerAndWait(rig, {
        repositoryId: "repo-fixture",
        definitionId: "my-review",
        revisionId: fixedRevision.revisionId,
      });
      const run = workflowRuntimeRunV2Schema.parse(done);
      expect(run.status).toBe("succeeded");
      expect(run.definitionId).toBe("my-review");
      expect(run.revisionId).toBe(fixedRevision.revisionId);
      expect(run.origin).toBe("user");

      // (d) The old draft revision is still readable (append-only).
      const oldRevision = await httpJson(rig.port, "GET", "/workflow-runtime/definitions/my-review/revisions/" + draftRevision.revisionId);
      expect(oldRevision.status).toBe(200);
      expect((oldRevision.body as { revision: { revision: number } }).revision.revision).toBe(1);

      // (e) Builtin is immutable: save → 409, delete → 409.
      const builtinSave = await httpJson(rig.port, "POST", "/workflow-runtime/definitions", {
        definition: { ...VERIFIED_MINI_REVIEW_DEFINITION, nodes: [VERIFIED_MINI_REVIEW_DEFINITION.nodes[0]!] },
      });
      expect(builtinSave.status).toBe(409);
      expect((builtinSave.body as { error: { code: string } }).error.code).toBe("WORKFLOW_DEFINITION_IMMUTABLE");
      const builtinDelete = await httpJson(rig.port, "DELETE", "/workflow-runtime/definitions/verified-mini-review");
      expect(builtinDelete.status).toBe(409);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});

describe("TEST K — run persistence survives restart", () => {
  it("run history + evidence/findings/audit + revisionId readable after store/host rebuild", async () => {
    const fixture = makeFixtureRepo();
    const database = openDatabase(":memory:");
    runMigrations(database);
    const firstRig = await makeApi({ repoPath: fixture.repoPath, database, store: new WorkflowRuntimeStore(database) });
    const saved = await httpJson(firstRig.port, "POST", "/workflow-runtime/definitions", { definition: userDefinition("persisted-review") });
    const revisionId = (saved.body as { revision: { revisionId: string } }).revision.revisionId;
    const doneBefore = workflowRuntimeRunV2Schema.parse(await triggerAndWait(firstRig, {
      repositoryId: "repo-fixture",
      definitionId: "persisted-review",
      revisionId,
    }));
    const runId = doneBefore.runId;
    firstRig.server.close();

    // Simulated restart: NEW host + store over the SAME database.
    const secondRig = await makeApi({ repoPath: fixture.repoPath, database, store: new WorkflowRuntimeStore(database) });
    try {
      const runs = await httpJson(secondRig.port, "GET", "/workflow-runtime/runs");
      const summaries = (runs.body as { runs: { runId: string; revisionId: string; definitionId: string }[] }).runs;
      expect(summaries.some((summary) => summary.runId === runId && summary.revisionId === revisionId)).toBe(true);

      const detail = await httpJson(secondRig.port, "GET", "/workflow-runtime/runs/" + runId);
      expect(detail.status).toBe(200);
      const runAfter = workflowRuntimeRunV2Schema.parse(detail.body);
      expect(runAfter.status).toBe("succeeded");
      expect(runAfter.revisionId).toBe(revisionId);
      expect(runAfter.evidence.length).toBe(doneBefore.evidence.length);
      expect(runAfter.miniReport?.findings.length).toBe(doneBefore.miniReport?.findings.length);
      expect(runAfter.miniReport?.audit).toEqual(doneBefore.miniReport?.audit);
    } finally {
      secondRig.server.close();
      database.close();
    }
  });

  it("a run still marked running at restart is honestly marked failed (never succeeded)", async () => {
    const fixture = makeFixtureRepo();
    const database = openDatabase(":memory:");
    runMigrations(database);
    const store = new WorkflowRuntimeStore(database);
    store.insertRun({
      runId: "wfrun_interrupted",
      definitionId: "verified-mini-review",
      revisionId: "builtin-seed",
      origin: "builtin",
      status: "running",
      repository: "test/fixture-canonical",
      headSha: fixture.headSha,
      createdAt: new Date().toISOString(),
      evidence: [],
    });

    const rig = await makeApi({ repoPath: fixture.repoPath, database, store });
    try {
      const detail = await httpJson(rig.port, "GET", "/workflow-runtime/runs/wfrun_interrupted");
      expect(detail.status).toBe(200);
      const run = detail.body as { status: string; error?: string };
      expect(run.status).toBe("failed");
      expect(run.error).toContain("interrupted");
    } finally {
      rig.server.close();
      database.close();
    }
  });
});

describe("TEST L — dry-load truth", () => {
  it("registered definition → feasible with ✓; broken node → ✗ + sanitized reason + not-feasible; disclaimer present", async () => {
    const fixture = makeFixtureRepo();
    const rig = await makeApi({ repoPath: fixture.repoPath });
    try {
      const saved = await httpJson(rig.port, "POST", "/workflow-runtime/definitions", { definition: userDefinition("dry-load-ok") });
      const okRevisionId = (saved.body as { revision: { revisionId: string } }).revision.revisionId;
      const ok = await httpJson(rig.port, "GET", "/workflow-runtime/definitions/dry-load-ok/revisions/" + okRevisionId + "/dry-load");
      expect(ok.status).toBe(200);
      const okBody = ok.body as {
        overall: string;
        disclaimer: string;
        nodes: { nodeId: string; nodeTypeRegistered: boolean; serviceRefMatches: boolean; coeffects: { available: boolean }[]; capabilityRequirements: { satisfiable: boolean }[] }[];
      };
      expect(okBody.overall).toBe("feasible");
      expect(okBody.disclaimer).toContain("does not authorize");
      for (const node of okBody.nodes) {
        expect(node.nodeTypeRegistered).toBe(true);
        expect(node.serviceRefMatches).toBe(true);
        expect(node.coeffects.every((coeffect) => coeffect.available)).toBe(true);
        expect(node.capabilityRequirements.every((requirement) => requirement.satisfiable)).toBe(true);
      }

      const brokenSaved = await httpJson(rig.port, "POST", "/workflow-runtime/definitions", {
        definition: {
          ...userDefinition("dry-load-broken"),
          nodes: [
            { ...userDefinition("x").nodes[0]!, type: "analyzer.not-registered" },
            userDefinition("x").nodes[1]!,
          ],
        },
      });
      const brokenRevisionId = (brokenSaved.body as { revision: { revisionId: string } }).revision.revisionId;
      const broken = await httpJson(rig.port, "GET", "/workflow-runtime/definitions/dry-load-broken/revisions/" + brokenRevisionId + "/dry-load");
      const brokenBody = broken.body as {
        overall: string;
        nodes: { nodeId: string; nodeTypeRegistered: boolean; issues: { code: string; message: string }[] }[];
      };
      expect(brokenBody.overall).toBe("not-feasible");
      const badNode = brokenBody.nodes.find((node) => node.nodeId === "analyze")!;
      expect(badNode.nodeTypeRegistered).toBe(false);
      expect(badNode.issues.some((issue) => issue.code === "unknown_node_type")).toBe(true);
      // Sanitized reason: no internal paths/stack traces.
      expect(JSON.stringify(brokenBody)).not.toMatch(/[A-Za-z]:\\/);

      // Unknown revision → sanitized 404.
      const missing = await httpJson(rig.port, "GET", "/workflow-runtime/definitions/dry-load-ok/revisions/wfrev_missing/dry-load");
      expect(missing.status).toBe(404);
      expect((missing.body as { error: { code: string } }).error.code).toBe("WORKFLOW_DEFINITION_NOT_FOUND");
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});

describe("TEST M — revision immutability under edit/delete", () => {
  it("run pinned to revision R is unaffected by later edits; delete-with-history refused; completed runs stay readable", async () => {
    const fixture = makeFixtureRepo();
    const rig = await makeApi({ repoPath: fixture.repoPath });
    try {
      const r1 = (await httpJson(rig.port, "POST", "/workflow-runtime/definitions", { definition: userDefinition("stable-review") }))
        .body as { revision: { revisionId: string } };

      // Long-poll trigger: pin revision R1, then append a NEW revision while
      // the run is executing. The plan was compiled from R1.
      const created = await httpJson(rig.port, "POST", "/workflow-runtime/runs", {
        repositoryId: "repo-fixture",
        definitionId: "stable-review",
        revisionId: r1.revision.revisionId,
      });
      expect(created.status).toBe(201);
      const runId = (created.body as { runId: string }).runId;

      const edited = await httpJson(rig.port, "POST", "/workflow-runtime/definitions", {
        definitionId: "stable-review",
        definition: { ...userDefinition("stable-review"), edges: [] },
      });
      expect((edited.body as { revision: { revision: number } }).revision.revision).toBe(2);

      const done = await waitForTerminal(rig.port, runId);
      const run = workflowRuntimeRunV2Schema.parse(done.body);
      expect(run.status).toBe("succeeded");
      // The run reports the PINNED revision, not the latest one.
      expect(run.revisionId).toBe(r1.revision.revisionId);

      // Delete with run history → refused (409); runs stay readable.
      const deleteRefused = await httpJson(rig.port, "DELETE", "/workflow-runtime/definitions/stable-review");
      expect(deleteRefused.status).toBe(409);
      expect((deleteRefused.body as { error: { code: string } }).error.code).toBe("WORKFLOW_DEFINITION_HAS_RUN_HISTORY");

      const stillReadable = await httpJson(rig.port, "GET", "/workflow-runtime/runs/" + runId);
      expect(stillReadable.status).toBe(200);

      // A definition WITHOUT run history can be deleted cleanly.
      const deletable = await httpJson(rig.port, "POST", "/workflow-runtime/definitions", { definition: userDefinition("throwaway") });
      const deleteOk = await httpJson(rig.port, "DELETE", "/workflow-runtime/definitions/throwaway");
      expect(deleteOk.status).toBe(200);
      expect((deletable.body as { revision: { revisionId: string } }).revision.revisionId).toBeTruthy();
      const gone = await httpJson(rig.port, "GET", "/workflow-runtime/definitions/throwaway/revisions/" + (deletable.body as { revision: { revisionId: string } }).revision.revisionId);
      expect(gone.status).toBe(404);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});

describe("TEST N — public DTO hygiene", () => {
  it("definitions/runs/dry-load responses contain no secrets, tokens, handles, or absolute paths", async () => {
    const fixture = makeFixtureRepo();
    const rig = await makeApi({ repoPath: fixture.repoPath });
    try {
      const saved = await httpJson(rig.port, "POST", "/workflow-runtime/definitions", { definition: userDefinition("hygiene-check") });
      const revisionId = (saved.body as { revision: { revisionId: string } }).revision.revisionId;
      const runDone = await triggerAndWait(rig, { repositoryId: "repo-fixture", definitionId: "hygiene-check", revisionId });
      expect((runDone as { status: string }).status).toBe("succeeded");

      const surfaces = [
        JSON.stringify(await httpJson(rig.port, "GET", "/workflow-runtime/definitions")),
        JSON.stringify(await httpJson(rig.port, "GET", "/workflow-runtime/runs")),
        JSON.stringify(runDone),
        JSON.stringify(await httpJson(rig.port, "GET", "/workflow-runtime/definitions/hygiene-check/revisions/" + revisionId + "/dry-load")),
      ].join("\n");

      expect(surfaces).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
      expect(surfaces).not.toMatch(/[A-Za-z]:\\/);
      expect(surfaces).not.toMatch(/"handle"|capabilityHandle/i);
      expect(surfaces).not.toContain("workflow-runtime/inline-input");
      expect(surfaces).not.toContain(fixture.repoPath.replace(/\\/g, "/"));
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});
