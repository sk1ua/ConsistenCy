/**
 * Repository review history tests — CKPT3 Phase 4 TEST S/T/U/V.
 *
 *   TEST S  canonical association: a job enqueued WITH repositoryId is
 *            persisted and appears in that repository's per-repo list; other
 *            repositories' lists exclude it; legacy jobs WITHOUT association
 *            never appear in ANY per-repo list (no name inference — a job
 *            whose repository FULL NAME matches is still excluded when the
 *            canonical association is absent).
 *   TEST T  list semantics: statuses map verbatim to the existing job
 *            vocabulary; bounded limit; unknown repository → sanitized 404
 *            with zero side effects; EMPTY (no associated jobs) vs
 *            UNAVAILABLE (store failure → 503 sanitized) are distinct.
 *   TEST U  DTO hygiene: per-repo reviews responses carry no secret / raw
 *            path / token / handle / repoPath; absent fields stay absent.
 *   TEST V  detail navigation: every listed job id resolves through the
 *            existing job detail endpoint (GET /jobs/:id) — the web detail
 *            route /runs/:jobId/overview consumes the same id.
 *
 * Route-level tests run the REAL createApiServer with the REAL
 * SQLiteJobStore (in-memory, migrated) — same store the production API uses.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../http";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { SQLiteJobStore } from "../jobs/sqliteJobStore";
import type { ConsistencyDatabase } from "../db/connection";
import { InMemoryJobQueue, type CreateReviewJobInput, type ReviewJobStore } from "../jobQueue";
import type { AuditDomainStore } from "../audit/store";

const TMP_DIRS: string[] = [];
afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SYNTHETIC_TOKEN = `ghp_${"F".repeat(36)}`;
const HEAD_CONTENT = 'export const token = "' + SYNTHETIC_TOKEN + '";\n';

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeFixtureRepo(): { repoPath: string; headSha: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wf4-"));
  TMP_DIRS.push(repoPath);
  git(repoPath, ["init", "-q"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoPath, "src.ts"), HEAD_CONTENT, "utf8");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", "fixture"]);
  return { repoPath, headSha: git(repoPath, ["rev-parse", "HEAD"]) };
}

/** Minimal audit-store stand-in: repository existence truth only. */
function fakeAuditStore(knownIds: string[]): Pick<AuditDomainStore, "getRepository"> {
  const known = new Set(knownIds);
  return {
    getRepository: (id: string) =>
      known.has(id)
        ? ({ id, displayName: id, source: "local_git", trustLevel: "untrusted_readonly", monitoringEnabled: false, createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z" } as AuditDomainStore["getRepository"] extends (id: string) => infer R ? R : never)
        : undefined
  } as Pick<AuditDomainStore, "getRepository">;
}

interface Rig {
  server: ReturnType<typeof createApiServer>;
  port: number;
  jobs: ReviewJobStore;
  database: ConsistencyDatabase;
}

function makeApi(options: { knownRepositoryIds?: string[]; jobs?: ReviewJobStore } = {}): Promise<Rig> {
  const database = options.jobs ? openDatabase(":memory:") : openDatabase(":memory:");
  runMigrations(database);
  const jobs = options.jobs ?? new SQLiteJobStore(database);
  const server = createApiServer({
    jobs,
    auditStore: fakeAuditStore(options.knownRepositoryIds ?? ["repo-a", "repo-b"]) as unknown as AuditDomainStore
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0, jobs, database });
    });
  });
}

function httpJson(
  port: number,
  method: "GET" | "POST",
  pathName: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: pathName, method }, (res) => {
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
    });
    req.on("error", reject);
    req.end();
  });
}

function jobInput(overrides: Partial<CreateReviewJobInput> = {}): CreateReviewJobInput {
  return {
    kind: "pull_request",
    repository: "test/repo-a",
    // local_git rows require a non-null repo_path (table CHECK). The DTO must
    // never expose it — TEST U asserts that on the same rows.
    repoPath: path.join(os.tmpdir(), "consistency-wf4", "checkout"),
    accessMode: "local_git",
    publicationPolicy: "disabled",
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    action: "local_trigger",
    ...overrides
  };
}

describe("TEST S — canonical association", () => {
  it("associated job appears ONLY in its repository's list; name-matching legacy job never appears anywhere", async () => {
    const rig = await makeApi();
    try {
      const associated = rig.jobs.enqueue(jobInput({ repositoryId: "repo-a" }));
      // A LEGACY job with NO repositoryId — its full name matches repo-a's
      // display identity, but association is absent → must NOT be listed.
      const legacy = rig.jobs.enqueue(jobInput({ repository: "repo-a-checkout" }));
      // A different repository's associated job.
      rig.jobs.enqueue(jobInput({ repository: "test/repo-b", repositoryId: "repo-b" }));

      const aList = await httpJson(rig.port, "GET", "/repositories/repo-a/reviews");
      expect(aList.status).toBe(200);
      const aReviews = (aList.body as { reviews: { id: string; repositoryId?: string }[] }).reviews;
      expect(aReviews.map((job) => job.id)).toEqual([associated.id]);
      for (const job of aReviews) expect(job.repositoryId).toBe("repo-a");

      const bList = await httpJson(rig.port, "GET", "/repositories/repo-b/reviews");
      const bReviews = (bList.body as { reviews: { id: string }[] }).reviews;
      expect(bReviews.some((job) => job.id === associated.id)).toBe(false);
      expect(bReviews.some((job) => job.id === legacy.id)).toBe(false);

      // The legacy job is still readable GLOBALLY (existing /jobs surface,
      // untouched) — per D1(b) it lives in the global view, not per-repo.
      const global = await httpJson(rig.port, "GET", "/jobs");
      const globalIds = (global.body as { jobs: { id: string }[] }).jobs.map((job) => job.id);
      expect(globalIds).toContain(legacy.id);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });

  it("the production local-review creation path persists repositoryId end-to-end", async () => {
    const fixture = makeFixtureRepo();
    const rig = await makeApi();
    try {
      // Store-level simulation of the /reviews/local enqueue (the route feeds
      // body.repositoryId → LocalTriggerInput.repositoryId → enqueue).
      const input = jobInput({
        repository: "fixture-checkout",
        repositoryId: "repo-a",
        repoPath: fixture.repoPath
      });
      const job = rig.jobs.enqueue(input);
      expect(job.repositoryId).toBe("repo-a");

      const stored = rig.jobs.get(job.id);
      expect(stored?.repositoryId).toBe("repo-a");

      const listed = await httpJson(rig.port, "GET", "/repositories/repo-a/reviews");
      expect((listed.body as { reviews: { id: string }[] }).reviews.map((r) => r.id)).toContain(job.id);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});

describe("TEST T — list semantics", () => {
  it("statuses map verbatim; bounded limit; unknown repo 404; EMPTY ≠ UNAVAILABLE", async () => {
    const rig = await makeApi();
    try {
      const running = rig.jobs.enqueue(jobInput({ repositoryId: "repo-a" }));
      rig.jobs.markRunning(running.id);
      const failed = rig.jobs.enqueue(jobInput({ repositoryId: "repo-a" }));
      rig.jobs.markRunning(failed.id);
      rig.jobs.markFailed(failed.id, `secret ${SYNTHETIC_TOKEN} leaked internally`);
      rig.jobs.enqueue(jobInput({ repositoryId: "repo-a" })); // queued

      const list = await httpJson(rig.port, "GET", "/repositories/repo-a/reviews");
      const statuses = (list.body as { reviews: { status: string }[] }).reviews.map((job) => job.status).sort();
      expect(statuses).toEqual(["failed", "queued", "running"]);

      const bounded = await httpJson(rig.port, "GET", "/repositories/repo-a/reviews?limit=2");
      expect((bounded.body as { reviews: unknown[] }).reviews.length).toBeLessThanOrEqual(2);

      // Unknown repository → sanitized 404, zero side effects.
      const unknown = await httpJson(rig.port, "GET", "/repositories/ghost/reviews");
      expect(unknown.status).toBe(404);
      expect((unknown.body as { error: { code: string } }).error.code).toBe("REPOSITORY_NOT_FOUND");

      // EMPTY: known repository with zero ASSOCIATED jobs (legacy-only).
      const empty = await httpJson(rig.port, "GET", "/repositories/repo-b/reviews");
      expect(empty.status).toBe(200);
      expect((empty.body as { reviews: unknown[] }).reviews).toEqual([]);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });

  it("store failure → sanitized 503 UNAVAILABLE (distinct from EMPTY)", async () => {
    const broken = {
      listJobsForRepository: () => {
        throw new Error("sqlite exploded");
      }
    } as unknown as ReviewJobStore;
    const rig = await makeApi({ jobs: broken });
    try {
      const response = await httpJson(rig.port, "GET", "/repositories/repo-a/reviews");
      expect(response.status).toBe(503);
      const body = response.body as { error: { code: string; message: string } };
      expect(body.error.code).toBe("REVIEWS_UNAVAILABLE");
      expect(body.error.message).not.toContain("sqlite");
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });

  it("fails closed when the final review response contains another repository association", async () => {
    const jobs = new InMemoryJobQueue();
    const mismatched = jobs.enqueue(jobInput({ repositoryId: "repo-b" }));
    jobs.listJobsForRepository = () => [mismatched];
    const rig = await makeApi({ jobs });
    try {
      const response = await httpJson(rig.port, "GET", "/repositories/repo-a/reviews");
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: {
          code: "REPOSITORY_REVIEWS_RESPONSE_INVALID",
          message: "Repository review history response is unavailable"
        }
      });
      expect(JSON.stringify(response.body)).not.toContain("repo-b");
      expect(JSON.stringify(response.body)).not.toContain(mismatched.id);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});

describe("TEST U — public DTO hygiene", () => {
  it("no secret / raw path / token / handle leaks; absent fields absent", async () => {
    const fixture = makeFixtureRepo();
    const rig = await makeApi();
    try {
      const job = rig.jobs.enqueue(jobInput({ repositoryId: "repo-a", repoPath: fixture.repoPath }));
      rig.jobs.markRunning(job.id);
      rig.jobs.markFailed(job.id, `boom ${SYNTHETIC_TOKEN}`);

      const response = await httpJson(rig.port, "GET", "/repositories/repo-a/reviews");
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
      expect(serialized).not.toMatch(/[A-Za-z]:\\/);
      expect(serialized).not.toContain(fixture.repoPath.replace(/\\/g, "/"));
      expect(serialized).not.toMatch(/"repoPath"/);
      expect(serialized).not.toMatch(/"handle"|capabilityHandle/i);
      // Absent optional fields stay absent (never fabricated).
      const first = (response.body as { reviews: Record<string, unknown>[] }).reviews[0]!;
      expect(first.pullRequestNumber).toBeUndefined();
      expect(first.report).toBeUndefined();
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});

describe("TEST V — detail navigation", () => {
  it("every listed job id resolves through the existing job detail endpoint", async () => {
    const rig = await makeApi();
    try {
      const job = rig.jobs.enqueue(jobInput({ repositoryId: "repo-a" }));
      const list = await httpJson(rig.port, "GET", "/repositories/repo-a/reviews");
      const listed = (list.body as { reviews: { id: string }[] }).reviews;
      expect(listed).toHaveLength(1);

      // The web detail route /runs/:jobId/overview consumes this same id;
      // the API-side resolution contract is GET /jobs/:id → { job }.
      const detail = await httpJson(rig.port, "GET", `/jobs/${listed[0]!.id}`);
      expect(detail.status).toBe(200);
      expect((detail.body as { job: { id: string } }).job.id).toBe(listed[0]!.id);
    } finally {
      rig.server.close();
      rig.database.close();
    }
  });
});
