/**
 * Shared fixtures for workload-review tests.
 *
 * All model interactions are OFFLINE mocks. The fixture repository is a
 * throwaway temp Git repo; the secret material is synthetic.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type {
  AgentRun,
  DomainAnalyzeSuccess,
  PRReviewContext,
  ReviewFinding,
  ReviewPlan,
  ReviewReport,
  TokenUsage,
} from "@consistency/schema";
import {
  asAgentId,
  type AgentState,
  type EvidenceInput,
  type KernelScheduler,
} from "@consistency/kernel";
import { RepositorySnapshot } from "@consistency/repository";
import type {
  DeterministicStage,
  ModelDriver,
  ReviewPersistence,
} from "../index.js";

export const TMP_DIRS: string[] = [];
export function cleanupTmpDirs(): void {
  for (const dir of TMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Synthetic GitHub-shaped token (invalid, test-only). */
export const FAKE_TOKEN = `ghp_${"F".repeat(36)}`;

/** Head content: 3 lines; line 1 has trailing whitespace + 6 params; line 2 the synthetic token. */
export const HEAD_FILE_LINES = [
  "export function risky(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}  ",
  `export const token = "${FAKE_TOKEN}";`,
  "export const fine = 1;",
];
export const HEAD_FILE = HEAD_FILE_LINES.join("\n");
export const BASE_FILE = "export function oldCode(): void {}\n".repeat(3);

export interface FixtureRepo {
  readonly repoPath: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly snapshot: RepositorySnapshot;
  readonly context: PRReviewContext;
}

/** Temp git repo with base commit A and head commit B on src/index.ts. */
export function makeFixtureRepo(): FixtureRepo {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wl-"));
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

  const snapshot = RepositorySnapshot.create({
    repositoryPath: repoPath,
    repository: "test/example",
    headSha,
    baseSha,
  });

  const context: PRReviewContext = {
    jobId: "job_workload",
    source: "github_pr",
    repositoryFullName: "test/example",
    pullRequestNumber: 42,
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
    diff: `diff --git a/src/index.ts b/src/index.ts\n${BASE_FILE.split("\n").map((l) => `-${l}`).join("\n")}\n${HEAD_FILE_LINES.map((l) => `+${l}`).join("\n")}`,
    fileContents: { "src/index.ts": HEAD_FILE },
    baseFileContents: { "src/index.ts": BASE_FILE },
    projectMetadata: { "package.json": "{}" },
    workspacePath: repoPath,
  };

  return { repoPath, baseSha, headSha, snapshot, context };
}

/** Confirmed security finding anchored at line 2 (inside the changed hunk). */
export function securityFinding(): ReviewFinding {
  return {
    id: "finding-1",
    agent: "Security",
    title: "Hardcoded synthetic credential",
    severity: "high",
    confidence: "confirmed",
    file: "src/index.ts",
    startLine: 2,
    endLine: 2,
    evidence: "A literal synthetic GitHub token is assigned at line 2.",
    reasoning: "The credential would be exposed in version control.",
    recommendation: "Move the credential to a secret store.",
  };
}

export interface TestModelDriverOptions {
  readonly plan?: ReviewPlan;
  readonly findingsByAgent?: Partial<Record<string, ReviewFinding[]>>;
  readonly summary?: string;
  /** Called synchronously at the START of each backend invocation. */
  readonly onInvoke?: (info: { schemaName: string; agent?: string; state?: AgentState }) => void;
  /** Reads the CURRENT scheduler state (set by the test via the admission hook). */
  readonly schedulerRef?: { current?: KernelScheduler };
}

/** Offline ModelDriver mock with deterministic fixtures + invocation probes. */
export class TestModelDriver implements ModelDriver {
  readonly provider = "mock" as const;
  readonly model = "mock-fixture";
  readonly invocations: { schemaName: string; state?: AgentState }[] = [];

  constructor(private readonly options: TestModelDriverOptions = {}) {}

  invokeStructured<T>(request: {
    schemaName: string;
  }): Promise<{ data: T; tokenUsage?: TokenUsage }> {
    this.#probe(request.schemaName);
    if (request.schemaName === "review-plan") {
      const plan: ReviewPlan = this.options.plan ?? {
        enabledAgents: ["Security", "Correctness", "Maintainability", "Test", "Style"],
        skippedAgents: ["ArchitectureAuditor"],
        riskAreas: ["changed code"],
        reason: "fixture plan",
        focusAreas: [],
      };
      return Promise.resolve({ data: plan as T, tokenUsage: { totalTokens: 10 } });
    }
    return Promise.resolve({ data: {} as T, tokenUsage: { totalTokens: 10 } });
  }

  invokeAgentFindings(request: {
    agent: string;
  }): Promise<{ data: ReviewFinding[]; tokenUsage?: TokenUsage }> {
    this.#probe("findings", request.agent);
    const findings = this.options.findingsByAgent?.[request.agent] ?? [];
    return Promise.resolve({ data: findings, tokenUsage: { totalTokens: 20 } });
  }

  invokeSummary(): Promise<{ data: { summary: string }; tokenUsage?: TokenUsage }> {
    this.#probe("review-summary");
    return Promise.resolve({
      data: { summary: this.options.summary ?? "Test summary of the review." },
      tokenUsage: { totalTokens: 5 },
    });
  }

  #probe(schemaName: string, agent?: string): void {
    const scheduler = this.options.schedulerRef?.current;
    let state: AgentState | undefined;
    if (scheduler) {
      // Map the invocation to the agent's ACB id (deterministic names).
      const name =
        schemaName === "review-plan"
          ? "review-supervisor"
          : schemaName === "review-summary"
            ? "review-synthesizer"
            : agent
              ? `review-${agent.toLowerCase()}`
              : undefined;
      if (name) {
        state = scheduler.getAgent(asAgentId(`${name}:job_workload`))?.state;
      }
    }
    this.invocations.push({ schemaName, state });
    this.options.onInvoke?.({ schemaName, agent, state });
  }
}

export class TestPersistence implements ReviewPersistence {
  readonly agentRuns: AgentRun[] = [];
  readonly persistCalls: { jobId: string; report: ReviewReport }[] = [];

  saveAgentRun(run: AgentRun): void {
    this.agentRuns.push(run);
  }

  persistReportAndEnqueuePublish(jobId: string, report: ReviewReport): unknown {
    this.persistCalls.push({ jobId, report });
    return { status: "awaiting_publish" };
  }
}

export function makeDeterministicStage(overrides?: {
  readonly analyzeOk?: boolean;
  readonly analyzeError?: string;
  readonly analyzeFiles?: DomainAnalyzeSuccess["files"];
  readonly composeOk?: boolean;
  readonly composeScore?: number;
  readonly composeRiskLevel?: "critical" | "high" | "medium" | "low";
  readonly onAnalyze?: () => void;
  readonly onCompose?: (state?: AgentState) => void;
}): DeterministicStage {
  return {
    analyze: async () => {
      overrides?.onAnalyze?.();
      if (overrides?.analyzeOk === false) {
        return { id: "req_1", ok: false, error: overrides.analyzeError ?? "engine crash" };
      }
      return {
        id: "req_1",
        ok: true,
        files: overrides?.analyzeFiles ?? [
          {
            path: "src/index.ts",
            riskScore: 0.8,
            riskLabel: "high",
            riskColor: "RED",
            signals: {},
            findings: ["Static warning: synthetic credential"],
            confidence: 0.9,
          },
        ],
      };
    },
    composeReview: async () => {
      overrides?.onCompose?.();
      if (overrides?.composeOk === false) {
        return { id: "req_2", ok: false, error: "compose crash" };
      }
      return {
        id: "req_2",
        ok: true,
        overallScore: overrides?.composeScore ?? 62,
        riskLevel: overrides?.composeRiskLevel ?? "medium",
        summary: "Canonical summary text.",
        recommendations: ["Address the credential handling."],
      };
    },
    relevantContext: async () => ({}),
    recordReview: async () => undefined,
  };
}

export function makeEvidenceInput(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    source: "sast",
    ruleId: "secret.github-token",
    location: { path: "src/index.ts", startLine: 2, endLine: 2 },
    confidence: 0.95,
    payload: { kind: "secret", secretType: "github-token", ruleId: "secret.github-token", redactedExcerpt: "[REDACTED]", secretFingerprint: "f".repeat(64) },
    provenance: { repository: "test/example", sha: "head", analyzer: "secret", analyzerVersion: "1.0.0" },
    ...overrides,
  };
}
