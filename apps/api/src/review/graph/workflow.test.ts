import { describe, expect, it, vi } from "vitest";
import type { PRReviewContext } from "@consistency/schema";
import { InMemoryJobQueue } from "../../jobQueue";
import { MockLLMProvider } from "../llm/mockProvider";
import { runReviewWorkflow } from "./workflow";
import { DeterministicAnalyzer } from "../deterministic";

const context: PRReviewContext = {
  jobId: "job-placeholder",
  source: "github_pr",
  repositoryFullName: "sk1ua/ConsistenCy",
  pullRequestNumber: 34,
  baseSha: "base123",
  headSha: "head456",
  changedFiles: [{
    path: "apps/api/src/http.ts",
    status: "modified",
    additions: 4,
    deletions: 1,
    changes: 5,
    // Must cover the line the confirmed finding cites, and must fit inside
    // fileContents below: the grounding gate rejects claims anchored outside
    // the changed hunks or past the end of the file.
    patch: "@@ -1,2 +1,3 @@"
  }],
  diff: "diff --git a/apps/api/src/http.ts b/apps/api/src/http.ts",
  fileContents: { "apps/api/src/http.ts": "line one\nline two\nline three" },
  baseFileContents: { "apps/api/src/http.ts": "line one\nline three" },
  projectMetadata: { "package.json": "{}" },
  workspacePath: "C:/consistency/workspaces/job-placeholder"
};

function queuedJob(store: InMemoryJobQueue) {
  return store.acceptWebhookJob({
    delivery: { deliveryId: "delivery-workflow", event: "pull_request", action: "opened" },
    job: {
      kind: "pull_request",
      repository: "sk1ua/ConsistenCy",
      pullRequestNumber: 34,
      installationId: 123,
      baseSha: "base123",
      headSha: "head456",
      senderLogin: "octocat",
      action: "opened"
    }
  }).job!;
}

const confirmedFinding = {
  id: "security-1",
  agent: "Security" as const,
  title: "Unsigned webhook accepted",
  severity: "high" as const,
  confidence: "confirmed" as const,
  file: "apps/api/src/http.ts",
  startLine: 2,
  endLine: 2,
  evidence: "Line 2 accepts a webhook without signature verification.",
  reasoning: "Forged requests could create review jobs.",
  recommendation: "Verify x-hub-signature-256 before parsing."
};

function createMockAnalyzer(overrides?: {
  analyzeOk?: boolean;
  analyzeError?: string;
  composeOk?: boolean;
  composeScore?: number;
  composeRiskLevel?: "critical" | "high" | "medium" | "low";
}) {
  const analyzer = new DeterministicAnalyzer("python", "engine");
  const analyzeOk = overrides?.analyzeOk ?? true;
  const composeOk = overrides?.composeOk ?? true;

  vi.spyOn(analyzer, "analyze").mockImplementation(async () => {
    if (!analyzeOk) {
      return { id: "req_1", ok: false, error: overrides?.analyzeError ?? "Engine crash" };
    }
    return {
      id: "req_1",
      ok: true,
      files: [{
        path: "apps/api/src/http.ts",
        riskScore: 0.8,
        riskLabel: "high",
        riskColor: "RED",
        signals: {},
        findings: ["Static warning: missing auth check"],
        confidence: 0.9
      }]
    };
  });

  // The deterministic stage runs through the DAG engine by default, so the
  // workflow action is stubbed to the same signal the analyze mock reports.
  vi.spyOn(analyzer, "runWorkflow").mockImplementation(async () => {
    if (!analyzeOk) {
      return { id: "req_wf", ok: false as const, error: overrides?.analyzeError ?? "Engine crash" };
    }
    return {
      id: "req_wf",
      ok: true as const,
      run: {
        runId: "run_1",
        specName: "pr-review",
        status: "succeeded" as const,
        startedAt: "2026-08-05T12:00:00.000Z",
        finishedAt: "2026-08-05T12:00:01.000Z",
        artifacts: [{
          stepId: "security",
          uses: "engine.security" as const,
          status: "succeeded" as const,
          command: [],
          exitCode: 0,
          startedAt: "2026-08-05T12:00:00.000Z",
          rawOutput: "",
          inputDigest: "a".repeat(64),
          evidence: {
            producedBy: "security",
            summary: "",
            items: [{
              file: "apps/api/src/http.ts",
              excerpt: "Static warning: missing auth check",
              rule: "engine.security",
              severity: "high" as const,
              metadata: { score: 0.8 }
            }]
          }
        }]
      }
    };
  });

  // Project-memory write-back, stubbed so no real engine is spawned.
  vi.spyOn(analyzer, "recordReview").mockResolvedValue({ recorded: 1, resolved: 0 });

  // Stubbed so the graph's augmentContext node does not spawn a real engine.
  vi.spyOn(analyzer, "relevantContext").mockResolvedValue({
    "apps/api/src/http.ts": {
      historicalFixes: [{
        reference: "1a30c2b",
        file: "apps/api/src/http.ts",
        summary: "Previously added a signature check here",
        fixedAt: "2026-08-01T00:00:00.000Z",
        severity: "high"
      }],
      relatedModules: [{ path: "apps/api/src/server.ts", relation: "imported_by", weight: 0.9 }],
      pastSecurityReports: [],
      callerGraph: [{
        callerFile: "apps/api/src/server.ts",
        callerSymbol: "start",
        calleeFile: "apps/api/src/http.ts",
        calleeSymbol: "createHttpServer",
        depth: 1
      }]
    }
  });

  vi.spyOn(analyzer, "composeReview").mockImplementation(async () => {
    if (!composeOk) {
      return { id: "req_2", ok: false, error: "Compose error" };
    }
    return {
      id: "req_2",
      ok: true,
      overallScore: overrides?.composeScore ?? 42,
      riskLevel: overrides?.composeRiskLevel ?? "high",
      summary: "Canonical Python review composition completed.",
      recommendations: ["Fix high risk static & LLM findings."]
    };
  });

  return analyzer;
}

describe("LangGraph review workflow", () => {
  it("runs full node pipeline: deterministic -> planner -> agents -> compose -> synthesizer -> atomic persist", async () => {
    const store = new InMemoryJobQueue();
    const job = queuedJob(store);
    store.markRunning(job.id);
    const provider = new MockLLMProvider({
      "security-findings": { findings: [confirmedFinding] },
      "review-summary": { summary: "One confirmed high-severity webhook issue requires remediation." }
    });
    const contextBuilder = vi.fn(async () => ({ ...context, jobId: job.id }));
    const analyzer = createMockAnalyzer({ composeScore: 42, composeRiskLevel: "high" });

    const state = await runReviewWorkflow({
      jobId: job.id,
      repositoryFullName: job.repository,
      pullRequestNumber: job.pullRequestNumber!,
      installationId: job.installationId!,
      baseSha: job.baseSha!,
      headSha: job.headSha!
    }, {
      contextBuilder,
      provider,
      jobStore: store,
      deterministicAnalyzer: analyzer
    });

    expect(contextBuilder).toHaveBeenCalledOnce();
    // Canonical score from Python (42/high) must strictly override local findings deduction (80/low)
    expect(state.report).toMatchObject({ score: 42, riskLevel: "high", findings: [confirmedFinding] });
    expect(state.agentRuns.map(run => run.agentName)).toEqual([
      "DeterministicAnalyzer", "Planner", "Security", "Correctness", "Maintainability",
      "Test", "Style", "ArchitectureAuditor", "Synthesizer"
    ]);

    // Job must be in awaiting_publish status with report saved
    const updatedJob = store.get(job.id);
    expect(updatedJob?.status).toBe("awaiting_publish");
    expect(updatedJob?.result?.score).toBe(42);
    expect(store.listAgentRuns(job.id)).toHaveLength(9);
  });

  it("aborts graph immediately when deterministic analysis fails", async () => {
    const store = new InMemoryJobQueue();
    const job = queuedJob(store);
    store.markRunning(job.id);
    const provider = new MockLLMProvider({});
    const analyzer = createMockAnalyzer({ analyzeOk: false, analyzeError: "Python process crashed" });

    await expect(runReviewWorkflow({
      jobId: job.id,
      repositoryFullName: job.repository,
      pullRequestNumber: job.pullRequestNumber!,
      installationId: job.installationId!,
      baseSha: job.baseSha!,
      headSha: job.headSha!
    }, {
      contextBuilder: async () => ({ ...context, jobId: job.id }),
      provider,
      jobStore: store,
      deterministicAnalyzer: analyzer
    })).rejects.toThrow(/Deterministic analysis failed: Python process crashed/);

    // Job store should record the failed DeterministicAnalyzer agent run
    expect(store.listAgentRuns(job.id).find(r => r.agentName === "DeterministicAnalyzer")?.status).toBe("failed");
  });

  it("aborts graph immediately when composeReview fails", async () => {
    const store = new InMemoryJobQueue();
    const job = queuedJob(store);
    store.markRunning(job.id);
    const provider = new MockLLMProvider({});
    const analyzer = createMockAnalyzer({ composeOk: false });

    await expect(runReviewWorkflow({
      jobId: job.id,
      repositoryFullName: job.repository,
      pullRequestNumber: job.pullRequestNumber!,
      installationId: job.installationId!,
      baseSha: job.baseSha!,
      headSha: job.headSha!
    }, {
      contextBuilder: async () => ({ ...context, jobId: job.id }),
      provider,
      jobStore: store,
      deterministicAnalyzer: analyzer
    })).rejects.toThrow(/Compose review failed/);
  });
});

describe("deterministic stage selection", () => {
  it("routes through the DAG engine by default", async () => {
    const store = new InMemoryJobQueue();
    const job = queuedJob(store);
    store.markRunning(job.id);
    const analyzer = createMockAnalyzer();

    await runReviewWorkflow({
      jobId: job.id,
      repositoryFullName: job.repository,
      pullRequestNumber: job.pullRequestNumber!,
      installationId: job.installationId!,
      baseSha: job.baseSha!,
      headSha: job.headSha!
    }, {
      contextBuilder: async () => ({ ...context, jobId: job.id }),
      provider: new MockLLMProvider({}),
      jobStore: store,
      deterministicAnalyzer: analyzer
    });

    expect(analyzer.runWorkflow).toHaveBeenCalledWith("pr-review", expect.any(Array));
    expect(analyzer.analyze).not.toHaveBeenCalled();
  });

  it("never hands the workspace path to the engine", async () => {
    // A review runs against an untrusted clone; a workspace path would let
    // subprocess steps execute that repository's own code.
    const store = new InMemoryJobQueue();
    const job = queuedJob(store);
    store.markRunning(job.id);
    const analyzer = createMockAnalyzer();

    await runReviewWorkflow({
      jobId: job.id,
      repositoryFullName: job.repository,
      pullRequestNumber: job.pullRequestNumber!,
      installationId: job.installationId!,
      baseSha: job.baseSha!,
      headSha: job.headSha!
    }, {
      contextBuilder: async () => ({ ...context, jobId: job.id }),
      provider: new MockLLMProvider({}),
      jobStore: store,
      deterministicAnalyzer: analyzer
    });

    const call = (analyzer.runWorkflow as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[2]).toBeUndefined();
  });

  it("falls back to the legacy analyze action when explicitly disabled", async () => {
    const store = new InMemoryJobQueue();
    const job = queuedJob(store);
    store.markRunning(job.id);
    const analyzer = createMockAnalyzer();

    await runReviewWorkflow({
      jobId: job.id,
      repositoryFullName: job.repository,
      pullRequestNumber: job.pullRequestNumber!,
      installationId: job.installationId!,
      baseSha: job.baseSha!,
      headSha: job.headSha!
    }, {
      contextBuilder: async () => ({ ...context, jobId: job.id }),
      provider: new MockLLMProvider({}),
      jobStore: store,
      deterministicAnalyzer: analyzer,
      reviewWorkflow: null
    });

    expect(analyzer.analyze).toHaveBeenCalledOnce();
    expect(analyzer.runWorkflow).not.toHaveBeenCalled();
  });
});

describe("project memory write-back", () => {
  async function runOnce(analyzer: ReturnType<typeof createMockAnalyzer>, store: InMemoryJobQueue) {
    const job = queuedJob(store);
    store.markRunning(job.id);
    await runReviewWorkflow({
      jobId: job.id,
      repositoryFullName: job.repository,
      pullRequestNumber: job.pullRequestNumber!,
      installationId: job.installationId!,
      baseSha: job.baseSha!,
      headSha: job.headSha!
    }, {
      contextBuilder: async () => ({ ...context, jobId: job.id }),
      provider: new MockLLMProvider({
        "security-findings": { findings: [confirmedFinding] },
        "review-summary": { summary: "One confirmed high-severity webhook issue requires remediation." }
      }),
      jobStore: store,
      deterministicAnalyzer: analyzer,
      workspaceRoot: "C:/consistency/workspaces"
    });
    return job;
  }

  it("records the report's findings against the changed files", async () => {
    const store = new InMemoryJobQueue();
    const analyzer = createMockAnalyzer();
    const job = await runOnce(analyzer, store);

    expect(analyzer.recordReview).toHaveBeenCalledOnce();
    const call = (analyzer.recordReview as unknown as { mock: { calls: any[][] } }).mock.calls[0]![0];
    expect(call.jobId).toBe(job.id);
    expect(call.reference).toBe("head456");
    expect(call.coveredFiles).toEqual(["apps/api/src/http.ts"]);
    expect(call.findings).toEqual([
      { file: "apps/api/src/http.ts", title: "Unsigned webhook accepted", severity: "high" }
    ]);
    expect(call.indexPath).toContain("knowledge");
  });

  it("reads context from the same per-repository index it writes to", async () => {
    const store = new InMemoryJobQueue();
    const analyzer = createMockAnalyzer();
    await runOnce(analyzer, store);

    const readPath = (analyzer.relevantContext as unknown as { mock: { calls: any[][] } })
      .mock.calls[0]![2].indexPath;
    const writePath = (analyzer.recordReview as unknown as { mock: { calls: any[][] } })
      .mock.calls[0]![0].indexPath;
    expect(readPath).toBe(writePath);
  });

  it("still completes the review when memory write-back fails", async () => {
    const store = new InMemoryJobQueue();
    const analyzer = createMockAnalyzer();
    vi.spyOn(analyzer, "recordReview").mockRejectedValue(new Error("index locked"));

    const job = await runOnce(analyzer, store);

    // The report is already durable; memory is an enrichment for later reviews.
    expect(store.get(job.id)?.status).toBe("awaiting_publish");
    expect(store.get(job.id)?.result?.score).toBe(42);
  });
});
