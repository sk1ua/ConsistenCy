import { describe, expect, it, vi } from "vitest";
import type { PRReviewContext } from "@consistency/schema";
import { InMemoryJobQueue } from "../../jobQueue";
import { MockLLMProvider } from "../llm/mockProvider";
import { runReviewWorkflow } from "./workflow";

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
  agent: "Security",
  title: "Unsigned webhook accepted",
  severity: "high",
  confidence: "confirmed",
  file: "apps/api/src/http.ts",
  startLine: 2,
  endLine: 2,
  evidence: "Line 2 accepts a webhook without signature verification.",
  reasoning: "Forged requests could create review jobs.",
  recommendation: "Verify x-hub-signature-256 before parsing."
};

describe("LangGraph review workflow", () => {
  it("runs planner, five agents, synthesizer, persistence, and non-fatal publication", async () => {
    const store = new InMemoryJobQueue();
    const job = queuedJob(store);
    store.markRunning(job.id);
    const provider = new MockLLMProvider({
      "security-findings": { findings: [confirmedFinding] },
      "review-summary": { summary: "One confirmed high-severity webhook issue requires remediation." }
    });
    const contextBuilder = vi.fn(async () => ({ ...context, jobId: job.id }));

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
      publishReport: async () => { throw new Error("GitHub unavailable"); }
    });

    expect(contextBuilder).toHaveBeenCalledOnce();
    expect(state.report).toMatchObject({ score: 80, riskLevel: "low", findings: [confirmedFinding] });
    expect(state.agentRuns.map(run => run.agentName)).toEqual([
      "Planner", "Security", "Correctness", "Maintainability", "Test", "Style", "Synthesizer"
    ]);
    expect(store.get(job.id)).toMatchObject({ status: "succeeded", result: { score: 80 } });
    expect(store.listAgentRuns(job.id)).toHaveLength(7);
    expect(store.getReportCommentStatus(job.id)).toEqual({ status: "failed", error: "GitHub unavailable" });
  });

  it("degrades an invalid agent response to a failed AgentRun", async () => {
    const store = new InMemoryJobQueue();
    const job = queuedJob(store);
    store.markRunning(job.id);
    const provider = new MockLLMProvider({
      "security-findings": { findings: [{ invented: true }] }
    });

    const state = await runReviewWorkflow({
      jobId: job.id,
      repositoryFullName: job.repository,
      pullRequestNumber: job.pullRequestNumber!,
      installationId: job.installationId!,
      baseSha: job.baseSha!,
      headSha: job.headSha!
    }, {
      contextBuilder: async () => ({ ...context, jobId: job.id }),
      provider,
      jobStore: store
    });

    expect(state.agentRuns.find(run => run.agentName === "Security")).toMatchObject({ status: "failed" });
    expect(state.report).toMatchObject({ score: 100, findings: [] });
    expect(store.get(job.id)?.status).toBe("succeeded");
  });
});
