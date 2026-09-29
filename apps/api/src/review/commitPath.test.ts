/**
 * PR-5B — Kernel CommitCoordinator × existing Outbox integration (AC-PUB-1..10)
 * plus the §37 end-to-end commit path (review → durable intent → outbox →
 * PublishWorker → fake GitHub publisher).
 *
 * The coordinator is an UPSTREAM gate only: the existing Outbox
 * (lease/fencing/retry/idempotency/marker-search) is NOT rewritten. All tests
 * are offline (synthetic git fixture, mock model, fake publisher, synthetic
 * secrets only).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { PRReviewContext, ReviewFinding } from "@consistency/schema";
import { CommitSinkError } from "@consistency/kernel";
import { InMemoryJobQueue, type ReviewJob } from "../jobQueue";
import { MockLLMProvider } from "./llm/mockProvider";
import { createReviewRuntime } from "./workloadRuntime";
import { DeterministicAnalyzer } from "./deterministic";
import { PublishWorker } from "../publish/worker";
import type { PublishToGitHubOptions } from "../publish/githubPublisher";

const TMP_DIRS: string[] = [];
afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const HEAD_LINES = [
  "export function risky(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}",
  "export const token = process.env.SYNTHETIC_TOKEN;",
  "export const fine = 1;",
];
const HEAD_FILE = HEAD_LINES.join("\n");
const BASE_FILE = "export function oldCode(): void {}\n".repeat(3);

interface Fixture {
  readonly repoPath: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly context: PRReviewContext;
}

function makeFixture(jobId: string): Fixture {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-commit-"));
  TMP_DIRS.push(repoPath);
  git(repoPath, ["init", "-q"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "src", "index.ts"), BASE_FILE, "utf8");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", "base"]);
  const baseSha = git(repoPath, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repoPath, "src", "index.ts"), HEAD_FILE, "utf8");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", "head"]);
  const headSha = git(repoPath, ["rev-parse", "HEAD"]);

  const context: PRReviewContext = {
    jobId,
    source: "github_pr",
    repositoryFullName: "test/example",
    pullRequestNumber: 34,
    baseSha,
    headSha,
    changedFiles: [
      {
        path: "src/index.ts",
        status: "modified",
        additions: 3,
        deletions: 3,
        changes: 6,
        patch: "@@ -1,3 +1,3 @@",
      },
    ],
    diff: "diff --git a/src/index.ts b/src/index.ts",
    fileContents: { "src/index.ts": HEAD_FILE },
    baseFileContents: { "src/index.ts": BASE_FILE },
    projectMetadata: { "package.json": "{}" },
    workspacePath: repoPath,
  };
  return { repoPath, baseSha, headSha, context };
}

const confirmedFinding: ReviewFinding = {
  id: "security-1",
  agent: "Security",
  title: "Unsigned webhook accepted",
  severity: "high",
  confidence: "confirmed",
  file: "src/index.ts",
  startLine: 2,
  endLine: 2,
  evidence: "Line 2 reads a webhook token without signature verification.",
  reasoning: "Forged requests could create review jobs.",
  recommendation: "Verify x-hub-signature-256 before parsing.",
};

function createMockAnalyzer(summary = "Canonical summary.") {
  const analyzer = new DeterministicAnalyzer("python", "engine");
  vi.spyOn(analyzer, "analyze").mockImplementation(async () => ({
    id: "req_1",
    ok: true as const,
    files: [
      {
        path: "src/index.ts",
        riskScore: 0.8,
        riskLabel: "high",
        riskColor: "RED",
        signals: {},
        findings: ["Static warning: missing auth check"],
        confidence: 0.9,
      },
    ],
  }));
  vi.spyOn(analyzer, "runWorkflow").mockImplementation(async () => ({
    id: "req_wf",
    ok: true as const,
    run: {
      runId: "run_1",
      specName: "pr-review",
      status: "succeeded" as const,
      startedAt: "2026-08-05T12:00:00.000Z",
      finishedAt: "2026-08-05T12:00:01.000Z",
      artifacts: [],
    },
  }));
  vi.spyOn(analyzer, "composeReview").mockImplementation(async () => ({
    id: "req_2",
    ok: true as const,
    overallScore: 62,
    riskLevel: "medium" as const,
    summary,
    recommendations: ["Fix the auth check."],
  }));
  vi.spyOn(analyzer, "relevantContext").mockResolvedValue({});
  vi.spyOn(analyzer, "recordReview").mockResolvedValue(
    { recorded: 0, resolved: 0 } as Awaited<ReturnType<DeterministicAnalyzer["recordReview"]>>,
  );
  return analyzer;
}

function buildDeps(jobStore: InMemoryJobQueue, analyzer: DeterministicAnalyzer, fixture: Fixture, summary = "Parity summary.") {
  return {
    contextBuilder: async (input: { jobId: string }) => ({
      ...fixture.context,
      jobId: input.jobId,
    }),
    provider: new MockLLMProvider({
      "review-plan": {
        enabledAgents: ["Security"],
        skippedAgents: ["Correctness", "Maintainability", "Test", "Style", "ArchitectureAuditor"],
        riskAreas: ["changed code"],
        reason: "commit path plan",
        focusAreas: [],
      },
      "security-findings": { findings: [confirmedFinding] },
      "review-summary": { summary },
    }),
    jobStore,
    deterministicAnalyzer: analyzer,
    reportLanguage: "en-US" as const,
  };
}

function enqueueJob(store: InMemoryJobQueue, accessMode: "github_app" | "public_read" = "github_app", fixture: Fixture) {
  return store.acceptWebhookJob({
    delivery: { deliveryId: `delivery-${accessMode}-${fixture.context.jobId}`, event: "pull_request", action: "opened" },
    job: {
      kind: "pull_request",
      repository: "test/example",
      pullRequestNumber: 34,
      installationId: 123,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      senderLogin: "octocat",
      action: "opened",
      accessMode,
    },
  }).job!;
}

function runInput(job: ReviewJob, fixture: Fixture, publicationPolicy: "github_comment" | "disabled") {
  return {
    jobId: job.id,
    repositoryFullName: "test/example",
    pullRequestNumber: 34,
    installationId: 123,
    accessMode: "github_app" as const,
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    publicationPolicy,
  };
}

describe("PR-5B — CommitCoordinator × Outbox integration", () => {
  it("AC-PUB-1: enabled policy produces exactly one intent and one outbox item", async () => {
    const fixture = makeFixture("job-pub-1");
    const store = new InMemoryJobQueue();
    const job = enqueueJob(store, "github_app", fixture);
    store.markRunning(job.id);

    const result = await createReviewRuntime(buildDeps(store, createMockAnalyzer(), fixture)).run(
      runInput(store.get(job.id)!, fixture, "github_comment"),
    );

    expect(store.get(job.id)!.status).toBe("awaiting_publish");
    expect(store.getPublishOutbox(job.id)).toHaveLength(1);
    expect(result.commit?.intents).toHaveLength(1);
    expect(result.commit!.intents[0]!.action).toBe("github.publish");
    expect(result.commit!.intents[0]!.idempotencyKey).toBe(`github_comment:${job.id}`);
  });

  it("AC-PUB-2: repeated persist of the same job never duplicates the outbox item", async () => {
    const fixture = makeFixture("job-pub-2");
    const store = new InMemoryJobQueue();
    const job = enqueueJob(store, "github_app", fixture);
    store.markRunning(job.id);
    const deps = buildDeps(store, createMockAnalyzer(), fixture);

    const runtime = createReviewRuntime(deps);
    await runtime.run(runInput(store.get(job.id)!, fixture, "github_comment"));
    // Second run with the SAME jobId (idempotent retry). The durable store's
    // target-based dedupe keeps the outbox at exactly one row.
    await createReviewRuntime(deps).run(runInput(store.get(job.id)!, fixture, "github_comment"));

    expect(store.getPublishOutbox(job.id)).toHaveLength(1);
  });

  it("AC-PUB-3: disabled policy produces zero commit intents", async () => {
    const fixture = makeFixture("job-pub-3");
    const store = new InMemoryJobQueue();
    const job = enqueueJob(store, "public_read", fixture);
    store.markRunning(job.id);

    const result = await createReviewRuntime(buildDeps(store, createMockAnalyzer(), fixture)).run(
      runInput(store.get(job.id)!, fixture, "disabled"),
    );

    expect(result.commit).toBeUndefined();
  });

  it("AC-PUB-4: disabled policy persists the report with zero outbox rows", async () => {
    const fixture = makeFixture("job-pub-4");
    const store = new InMemoryJobQueue();
    const job = enqueueJob(store, "public_read", fixture);
    store.markRunning(job.id);

    await createReviewRuntime(buildDeps(store, createMockAnalyzer(), fixture)).run(
      runInput(store.get(job.id)!, fixture, "disabled"),
    );

    const saved = store.get(job.id)!;
    expect(saved.status).toBe("succeeded");
    expect(saved.result).toBeDefined();
    expect(store.getPublishOutbox(job.id)).toHaveLength(0);
  });

  it("AC-PUB-5: report body never leaks into intent, audit, or outbox", async () => {
    const marker = "SECRET_REPORT_BODY_7f3a9c";
    const fixture = makeFixture("job-pub-5");
    const store = new InMemoryJobQueue();
    const job = enqueueJob(store, "github_app", fixture);
    store.markRunning(job.id);

    const result = await createReviewRuntime(buildDeps(store, createMockAnalyzer(), fixture, `Report ${marker}`)).run(
      runInput(store.get(job.id)!, fixture, "github_comment"),
    );

    // The report IS durable and contains the marker.
    expect(store.get(job.id)!.result!.summary).toContain(marker);
    // The intent / audit / outbox carry only the payloadHash — never the body.
    expect(JSON.stringify(result.commit!.intents)).not.toContain(marker);
    expect(JSON.stringify(result.commit!.journal)).not.toContain(marker);
    expect(JSON.stringify(store.getPublishOutbox(job.id))).not.toContain(marker);
  });

  it("AC-PUB-6 (§37): end-to-end commit path — review → intent → outbox → published", async () => {
    const fixture = makeFixture("job-pub-6");
    const store = new InMemoryJobQueue();
    const job = enqueueJob(store, "github_app", fixture);
    store.markRunning(job.id);

    await createReviewRuntime(buildDeps(store, createMockAnalyzer(), fixture)).run(
      runInput(store.get(job.id)!, fixture, "github_comment"),
    );
    expect(store.get(job.id)!.status).toBe("awaiting_publish");

    const publishCalls: PublishToGitHubOptions[] = [];
    const worker = new PublishWorker({
      jobStore: store,
      concurrency: 1,
      pollIntervalMs: 20,
      tokenFetcher: async () => "ghs_synthetic_execution_token",
      publisher: async (options) => {
        publishCalls.push(options);
        return { commentId: "comment_42" };
      },
    });

    worker.start();
    for (let i = 0; i < 20 && store.get(job.id)!.status !== "succeeded"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await worker.stop();

    expect(store.get(job.id)!.status).toBe("succeeded");
    const outbox = store.getPublishOutbox(job.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.status).toBe("published");
    expect(outbox[0]!.externalId).toBe("comment_42");
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]!.report.jobId).toBe(job.id);
  });

  it("AC-PUB-7: the publish token is fetched at execution time and never persisted", async () => {
    const fixture = makeFixture("job-pub-7");
    const store = new InMemoryJobQueue();
    const job = enqueueJob(store, "github_app", fixture);
    store.markRunning(job.id);

    const result = await createReviewRuntime(buildDeps(store, createMockAnalyzer(), fixture)).run(
      runInput(store.get(job.id)!, fixture, "github_comment"),
    );

    // No token existed at intent acceptance — the coordinator path is token-free.
    expect(JSON.stringify(result.commit!.intents)).not.toContain("ghs_");
    expect(JSON.stringify(result.commit!.journal)).not.toContain("ghs_");

    const secretToken = "ghs_RUNTIME_FETCHED_1234567890";
    const worker = new PublishWorker({
      jobStore: store,
      concurrency: 1,
      pollIntervalMs: 20,
      tokenFetcher: async () => secretToken,
      publisher: async (options) => {
        expect(options.token).toBe(secretToken);
        return { commentId: "c1" };
      },
    });

    worker.start();
    for (let i = 0; i < 20 && store.get(job.id)!.status !== "succeeded"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await worker.stop();

    const outboxJson = JSON.stringify(store.getPublishOutbox(job.id));
    expect(outboxJson).not.toContain(secretToken);
  });

  it("AC-PUB-8: outbox item remains claimable with lease fencing (coordinator is upstream-only)", async () => {
    const fixture = makeFixture("job-pub-8");
    const store = new InMemoryJobQueue();
    const job = enqueueJob(store, "github_app", fixture);
    store.markRunning(job.id);

    await createReviewRuntime(buildDeps(store, createMockAnalyzer(), fixture)).run(
      runInput(store.get(job.id)!, fixture, "github_comment"),
    );

    const outboxBefore = store.getPublishOutbox(job.id)[0]!;
    expect(outboxBefore.status).toBe("pending");
    expect(outboxBefore.leaseGeneration).toBe(0);

    const claimed = store.claimPublishOutboxItem("worker_A", 30000, 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.leaseGeneration).toBe(1);
    expect(claimed[0]!.leaseOwner).toBe("worker_A");

    // Stale completion (wrong generation) must not overwrite the store.
    expect(store.markPublishOutboxSuccess(claimed[0]!.id, "worker_A", 0, "published", "x")).toBe(false);
    expect(store.getPublishOutbox(job.id)[0]!.status).toBe("leased");
  });

  it("AC-PUB-9: the durable report is persisted identically for enabled and disabled paths", async () => {
    const summary = "Durable report parity.";
    const fixtureA = makeFixture("job-pub-9a");
    const storeA = new InMemoryJobQueue();
    const jobA = enqueueJob(storeA, "github_app", fixtureA);
    storeA.markRunning(jobA.id);
    await createReviewRuntime(buildDeps(storeA, createMockAnalyzer(summary), fixtureA)).run(
      runInput(storeA.get(jobA.id)!, fixtureA, "github_comment"),
    );

    const fixtureB = makeFixture("job-pub-9b");
    const storeB = new InMemoryJobQueue();
    const jobB = enqueueJob(storeB, "public_read", fixtureB);
    storeB.markRunning(jobB.id);
    await createReviewRuntime(buildDeps(storeB, createMockAnalyzer(summary), fixtureB)).run(
      runInput(storeB.get(jobB.id)!, fixtureB, "disabled"),
    );

    expect(storeA.get(jobA.id)!.result!.summary).toBe(storeB.get(jobB.id)!.result!.summary);
    expect(storeA.get(jobA.id)!.result!.findings).toEqual(storeB.get(jobB.id)!.result!.findings);
  });

  it("AC-PUB-10: a failing commit sink surfaces CommitSinkError and records no intent", async () => {
    const fixture = makeFixture("job-pub-10");
    const store = new InMemoryJobQueue();
    const job = enqueueJob(store, "github_app", fixture);
    store.markRunning(job.id);
    vi.spyOn(store, "persistReportAndEnqueuePublish").mockImplementation(() => {
      throw new Error("disk full during outbox persist");
    });

    await expect(
      createReviewRuntime(buildDeps(store, createMockAnalyzer(), fixture)).run(
        runInput(store.get(job.id)!, fixture, "github_comment"),
      ),
    ).rejects.toThrow(CommitSinkError);

    // No external mutation: the sink failed before persisting anything.
    expect(store.getPublishOutbox(job.id)).toHaveLength(0);
    expect(store.get(job.id)!.status).toBe("running");
  });
});
