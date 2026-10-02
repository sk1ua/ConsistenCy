import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PRReviewContext, ReviewReport } from "@consistency/schema";
import type { ReviewWorkloadOptions } from "@consistency/workload-review";
import { loadEnv } from "@consistency/api/config/env";
import { SettingsStore } from "@consistency/api/config/settings";
import { DeterministicAnalyzer } from "@consistency/api/review/deterministic";
import { knowledgeIndexPathFor } from "@consistency/api/review/knowledgeIndex";
import { MockLLMProvider } from "@consistency/api/review/llm/mockProvider";
import * as providerFactory from "@consistency/api/review/llm/factory";
import * as contextRouter from "@consistency/api/review/context/contextRouter";
import { parseReviewOptions } from "./args";
import * as cliConfig from "./config";
import { runReview } from "./review";
import { paletteFor } from "./terminal";

const observed = vi.hoisted(() => ({ workloads: [] as ReviewWorkloadOptions[] }));
vi.mock("@consistency/workload-review", async importOriginal => {
  const actual = await importOriginal<typeof import("@consistency/workload-review")>();
  return {
    ...actual,
    ReviewWorkload: class extends actual.ReviewWorkload {
      constructor(options: ReviewWorkloadOptions) {
        super(options);
        observed.workloads.push(options);
      }
    }
  };
});

// Exercise the real runtime, workload and JSON-over-stdio Python memory paths.
// Only provider/configuration/context acquisition are isolated test doubles;
// no analyzed source is executed and the caller's settings are never loaded.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PYTHON_PATH = cliConfig.resolvePythonPath(loadEnv({}), PROJECT_ROOT);
const FILE = "sample.py";
const HISTORICAL_TITLE = "Previously reported fixture finding";
let root: string;
let repoPath: string;
let database: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "consistency-cli-memory-"));
  repoPath = join(root, "reviewed-repo");
  mkdirSync(repoPath);
  database = knowledgeIndexPathFor("reviewed-repo", join(root, ".consistency", "cli", "workspaces"));
  observed.workloads.length = 0;
  vi.stubEnv("CONSISTENCY_NO_MEMORY", "0");
  vi.spyOn(cliConfig, "installRoot").mockReturnValue(root);
  vi.spyOn(cliConfig, "loadCliConfig").mockReturnValue({
    root,
    config: loadEnv({ CONSISTENCY_PYTHON_PATH: PYTHON_PATH, CONSISTENCY_ENGINE_ROOT: PROJECT_ROOT }),
    store: new SettingsStore(root)
  });
  vi.spyOn(providerFactory, "createReviewLLMProvider").mockReturnValue(new MockLLMProvider({
    "review-plan": {
      enabledAgents: ["Security"],
      skippedAgents: ["Correctness", "Maintainability", "Test", "Style", "ArchitectureAuditor"],
      riskAreas: ["changed code"],
      reason: "Memory boundary fixture",
      focusAreas: []
    },
    "review-findings": { findings: [] },
    "review-summary": { summary: "Completed memory boundary fixture." }
  }));
  vi.spyOn(contextRouter, "createContextBuilder").mockReturnValue(async input => ({
    jobId: input.jobId,
    source: "local_git",
    repositoryFullName: input.repositoryFullName,
    baseSha: input.baseSha,
    headSha: input.headSha,
    changedFiles: [{
      path: FILE, status: "modified", additions: 1, deletions: 1, changes: 2,
      patch: "@@ -1,2 +1,2 @@\n def value():\n-    return 1\n+    return 2"
    }],
    diff: "diff --git a/sample.py b/sample.py\n@@ -1,2 +1,2 @@\n def value():\n-    return 1\n+    return 2",
    fileContents: { [FILE]: "def value():\n    return 2\n" },
    baseFileContents: { [FILE]: "def value():\n    return 1\n" },
    projectMetadata: {},
    workspacePath: repoPath
  } satisfies PRReviewContext));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function seedMemory(): Promise<void> {
  const analyzer = new DeterministicAnalyzer(PYTHON_PATH, "engine", [], PROJECT_ROOT);
  try {
    expect(await analyzer.recordReview({
      indexPath: database,
      jobId: "historical-job",
      reference: "historical-head",
      reportedAt: "2026-01-01T00:00:00.000Z",
      coveredFiles: [FILE],
      findings: [{ file: FILE, title: HISTORICAL_TITLE, severity: "high" }]
    })).toEqual({ recorded: 1, resolved: 0 });
  } finally {
    await analyzer.shutdown();
  }
}

async function review(flags: string[] = []): Promise<ReviewReport> {
  let output = "";
  const exitCode = await runReview(parseReviewOptions(["--repo", repoPath, "--json", ...flags]), {
    stdout: text => { output += text; },
    stderr: () => undefined,
    progress: false,
    palette: paletteFor(false)
    // Omit environment to test the real process-env fallback used by callers.
  });
  const report = JSON.parse(output) as ReviewReport;
  expect(exitCode).toBe(0);
  expect(report.summary).toBe("Completed memory boundary fixture.\n\n" +
    "去重和过滤后：主列表 0 条（严重 0、高 0、中 0、低 0、信息 0），附录 0 条。");
  expect(report.findings).toEqual([]);
  return report;
}

const OPT_OUTS = [
  { name: "--no-memory", flags: ["--no-memory"], environment: "0" },
  { name: "CONSISTENCY_NO_MEMORY=1", flags: [], environment: "1" }
];

describe("CLI persisted knowledge opt-out", { timeout: 20_000 }, () => {
  for (const optOut of OPT_OUTS) {
    it(`${optOut.name} never creates a missing knowledge database`, async () => {
      vi.stubEnv("CONSISTENCY_NO_MEMORY", optOut.environment);
      const relevantContext = vi.spyOn(DeterministicAnalyzer.prototype, "relevantContext");
      const recordReview = vi.spyOn(DeterministicAnalyzer.prototype, "recordReview");

      await review(optOut.flags);

      expect(relevantContext).not.toHaveBeenCalled();
      expect(recordReview).not.toHaveBeenCalled();
      expect(existsSync(dirname(database))).toBe(false);
      expect(observed.workloads).toHaveLength(1);
      expect(observed.workloads[0]?.knowledgeIndexPath).toBeUndefined();
      expect(observed.workloads[0]?.deterministic.relevantContext).toBeUndefined();
      expect(observed.workloads[0]?.deterministic.recordReview).toBeUndefined();
    });

    it(`${optOut.name} neither reads nor changes existing SQLite history`, async () => {
      await seedMemory();
      const before = readFileSync(database);
      vi.stubEnv("CONSISTENCY_NO_MEMORY", optOut.environment);
      const relevantContext = vi.spyOn(DeterministicAnalyzer.prototype, "relevantContext");
      const recordReview = vi.spyOn(DeterministicAnalyzer.prototype, "recordReview");

      await review(optOut.flags);

      // Both engine entrypoints can read AND write. Absence of either call
      // proves no history access, even though their failures are best-effort.
      expect(relevantContext).not.toHaveBeenCalled();
      expect(recordReview).not.toHaveBeenCalled();
      expect(readFileSync(database)).toEqual(before);
      expect(observed.workloads[0]?.knowledgeIndexPath).toBeUndefined();
      expect(observed.workloads[0]?.deterministic.relevantContext).toBeUndefined();
      expect(observed.workloads[0]?.deterministic.recordReview).toBeUndefined();
    });
  }

  it("retains default Python history reads and record_review resolution writes", async () => {
    await seedMemory();
    const relevantContext = vi.spyOn(DeterministicAnalyzer.prototype, "relevantContext");
    const recordReview = vi.spyOn(DeterministicAnalyzer.prototype, "recordReview");

    await review();

    expect(observed.workloads[0]?.knowledgeIndexPath).toBe(database);
    expect(observed.workloads[0]?.deterministic.relevantContext).toBeTypeOf("function");
    expect(observed.workloads[0]?.deterministic.recordReview).toBeTypeOf("function");
    expect(relevantContext).toHaveBeenCalledExactlyOnceWith(
      [{ path: FILE, content: "def value():\n    return 2\n" }], [FILE], { indexPath: database }
    );
    expect(await relevantContext.mock.results[0]?.value).toMatchObject({
      [FILE]: { pastSecurityReports: [{ title: HISTORICAL_TITLE, resolved: false }] }
    });
    expect(recordReview).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      indexPath: database, coveredFiles: [FILE], findings: []
    }));
    expect(await recordReview.mock.results[0]?.value).toEqual({ recorded: 0, resolved: 1 });
    const analyzer = new DeterministicAnalyzer(PYTHON_PATH, "engine", [], PROJECT_ROOT);
    try {
      const contexts = await analyzer.relevantContext([], [FILE], { indexPath: database });
      expect(contexts[FILE]?.historicalFixes).toEqual([expect.objectContaining({
        file: FILE, reference: "WORKING_TREE", severity: "high", summary: `Resolved: ${HISTORICAL_TITLE}`
      })]);
    } finally {
      await analyzer.shutdown();
    }
  });

  it("still creates a per-repository SQLite knowledge database by default", async () => {
    const relevantContext = vi.spyOn(DeterministicAnalyzer.prototype, "relevantContext");
    const recordReview = vi.spyOn(DeterministicAnalyzer.prototype, "recordReview");

    await review();

    expect(relevantContext).toHaveBeenCalledOnce();
    expect(recordReview).toHaveBeenCalledOnce();
    expect(observed.workloads[0]?.knowledgeIndexPath).toBe(database);
    expect(readFileSync(database).subarray(0, 16).toString()).toBe("SQLite format 3\u0000");
  });
});
