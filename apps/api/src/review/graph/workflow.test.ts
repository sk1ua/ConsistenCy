import { describe, expect, it, vi } from "vitest";
import type { PRReviewContext } from "@consistency/schema";
import { InMemoryJobQueue } from "../../jobQueue";
import { MockLLMProvider } from "../llm/mockProvider";
import { runReviewWorkflow } from "./workflow";
import { DeterministicAnalyzer } from "../deterministic";

const context: PRReviewContext = {
  jobId: "job-placeholder",
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
    patch: "@@ -10,1 +10,4 @@"
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
      "DeterministicAnalyzer", "Planner", "Security", "Correctness", "Maintainability", "Test", "Style", "Synthesizer"
    ]);

    // Job must be in awaiting_publish status with report saved
    const updatedJob = store.get(job.id);
    expect(updatedJob?.status).toBe("awaiting_publish");
    expect(updatedJob?.result?.score).toBe(42);
    expect(store.listAgentRuns(job.id)).toHaveLength(8);
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
