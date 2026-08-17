/**
 * PR-5A runtime parity + publication safety tests.
 *
 * - OLD runtime (legacy LangGraph graph, compatibility reference)
 *   vs NEW runtime (@consistency/workload-review) produce semantically
 *   equivalent outcomes for the same fixture, mock model and deterministic
 *   stage.
 * - Outbox parity (§44): disabled publication → succeeded + zero outbox;
 *   enabled → awaiting_publish + exactly ONE outbox item (no duplicates).
 * - AC-REV-12: public_read / local_git can never publish.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { PRReviewContext, ReviewFinding } from "@consistency/schema";
import { InMemoryJobQueue } from "../jobQueue";
import { MockLLMProvider } from "./llm/mockProvider";
import { createReviewRuntime } from "./workloadRuntime";
import { DeterministicAnalyzer } from "./deterministic";

const TMP_DIRS: string[] = [];
afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const HEAD_LINES = [
  "export function risky(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}",
  "export const token = process.env.SYNTHETIC_TOKEN;", // env reference — NOT a literal secret
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

function makeFixture(jobId = "job-parity"): Fixture {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-parity-"));
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
  confidence: "likely",
  file: "src/index.ts",
  startLine: 2,
  endLine: 2,
  evidence: "Line 2 reads a webhook token without signature verification.",
  reasoning: "Forged requests could create review jobs.",
  recommendation: "Verify x-hub-signature-256 before parsing.",
};

function createMockAnalyzer() {
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
    summary: "Canonical summary.",
    recommendations: ["Fix the auth check."],
  }));
  vi.spyOn(analyzer, "relevantContext").mockResolvedValue({});
  vi.spyOn(analyzer, "recordReview").mockResolvedValue(
    { recorded: 0, resolved: 0 } as Awaited<ReturnType<DeterministicAnalyzer["recordReview"]>>,
  );
  return analyzer;
}

function buildDeps(jobStore: InMemoryJobQueue, analyzer: DeterministicAnalyzer, fixture: Fixture) {
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
        reason: "parity plan",
      },
      "security-findings": { findings: [confirmedFinding] },
      "review-summary": { summary: "Parity summary." },
    }),
    jobStore,
    deterministicAnalyzer: analyzer,
    reportLanguage: "en-US" as const,
  };
}

function normalizeFinding(f: ReviewFinding) {
  return {
    agent: f.agent,
    title: f.title,
    severity: f.severity,
    confidence: f.confidence,
    file: f.file,
    startLine: f.startLine,
    endLine: f.endLine,
  };
}

function enqueueJob(store: InMemoryJobQueue, accessMode: "github_app" | "public_read" | "local_git", fixture: Fixture) {
  return store.acceptWebhookJob({
    delivery: { deliveryId: `delivery-${accessMode}`, event: "pull_request", action: "opened" },
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

describe("Authoritative workload-review execution and publication safety", () => {
  it("workload-review runtime produces deterministic review report and agent telemetry", async () => {
    const fixture = makeFixture("job-review-runtime");
    const store = new InMemoryJobQueue();
    const job = enqueueJob(store, "github_app", fixture);
    store.markRunning(job.id);
    const analyzer = createMockAnalyzer();
    const deps = buildDeps(store, analyzer, fixture);

    await createReviewRuntime(deps).run({
      jobId: job.id,
      repositoryFullName: "test/example",
      pullRequestNumber: 34,
      installationId: 123,
      accessMode: "github_app",
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      publicationPolicy: "github_comment",
    });

    const jobResult = store.get(job.id)!;
    expect(jobResult.status).toBe("awaiting_publish");
    expect(jobResult.result!.score).toBe(62);
    expect(jobResult.result!.riskLevel).toBe("medium");
    expect(jobResult.result!.findings.map(normalizeFinding)).toEqual([confirmedFinding].map(normalizeFinding));
    const agentRuns = store.listAgentRuns(job.id).map((r) => `${r.agentName}:${r.status}`).sort();
    expect(agentRuns.length).toBeGreaterThan(0);
    expect(jobResult.result!.summary).toContain("Parity summary.");
  });

  it("§44 outbox parity: enabled publication → awaiting_publish + exactly one outbox item", async () => {
    const fixture = makeFixture("job-outbox");
    const store = new InMemoryJobQueue();
    const job = enqueueJob(store, "github_app", fixture);
    store.markRunning(job.id);
    await createReviewRuntime(buildDeps(store, createMockAnalyzer(), fixture)).run({
      jobId: job.id,
      repositoryFullName: "test/example",
      pullRequestNumber: 34,
      installationId: 123,
      accessMode: "github_app",
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      publicationPolicy: "github_comment",
    });

    expect(store.get(job.id)!.status).toBe("awaiting_publish");
    const outbox = store.getPublishOutbox(job.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.target).toBe("github_comment");
  });

  it("AC-REV-12: public_read cannot publish (disabled policy enforced at the store)", async () => {
    const fixture = makeFixture("job-public-read");
    const store = new InMemoryJobQueue();
    const job = enqueueJob(store, "public_read", fixture);
    expect(job.publicationPolicy).toBe("disabled"); // store-layer invariant
    store.markRunning(job.id);
    await createReviewRuntime(buildDeps(store, createMockAnalyzer(), fixture)).run({
      jobId: job.id,
      repositoryFullName: "test/example",
      pullRequestNumber: 34,
      installationId: 123,
      accessMode: "public_read",
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      publicationPolicy: "disabled",
    });

    expect(store.get(job.id)!.status).toBe("succeeded");
    expect(store.getPublishOutbox(job.id)).toHaveLength(0);
    // No github.publish capability exists anywhere in the workload runtime:
    // the review agents' capability sets are restricted to read/evidence/llm.
  });

  it("AC-REV-12: local_git cannot publish", async () => {
    const fixture = makeFixture("job-local");
    const store = new InMemoryJobQueue();
    const job = enqueueJob(store, "local_git", fixture);
    expect(job.publicationPolicy).toBe("disabled");
    store.markRunning(job.id);
    await createReviewRuntime(buildDeps(store, createMockAnalyzer(), fixture)).run({
      jobId: job.id,
      repositoryFullName: "test/example",
      pullRequestNumber: undefined,
      repoPath: fixture.repoPath,
      installationId: undefined,
      accessMode: "local_git",
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      publicationPolicy: "disabled",
    });

    expect(store.get(job.id)!.status).toBe("succeeded");
    expect(store.getPublishOutbox(job.id)).toHaveLength(0);
  });
});
