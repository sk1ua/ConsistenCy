import { randomUUID } from "node:crypto";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { AgentRun, ReviewAccessMode } from "@consistency/schema";
import type { ReviewJobStore } from "../../jobQueue";
import { createCorrectnessAgentNode } from "../agents/correctness";
import { createMaintainabilityAgentNode } from "../agents/maintainability";
import { createPlannerNode } from "../agents/planner";
import { createSecurityAgentNode } from "../agents/security";
import { createStyleAgentNode } from "../agents/style";
import { createSynthesizerNode } from "../agents/synthesizer";
import { createTestAgentNode } from "../agents/test";
import type { ContextBuilder } from "../agents/types";
import type { LLMProvider } from "../llm/types";
import { ReviewGraphState, type ReviewGraphStateValue } from "./state";
import { DeterministicAnalyzer, type DeterministicFileInput } from "../deterministic";
import { buildComposeReviewFileResults } from "./composeBuilder";

export type ReviewWorkflowDependencies = {
  contextBuilder: ContextBuilder;
  provider: LLMProvider;
  jobStore: ReviewJobStore;
  deterministicAnalyzer: DeterministicAnalyzer;
};

export type ReviewWorkflowInput = {
  jobId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  installationId?: number;
  accessMode?: ReviewAccessMode;
  baseSha: string;
  headSha: string;
};

export function createReviewWorkflow(dependencies: ReviewWorkflowDependencies) {
  const agentDependencies = { provider: dependencies.provider, jobStore: dependencies.jobStore };

  return new StateGraph(ReviewGraphState)
    .addNode("loadContext", async (state: ReviewGraphStateValue) => ({
      context: await dependencies.contextBuilder({
        jobId: state.jobId,
        repositoryFullName: state.repositoryFullName,
        pullRequestNumber: state.pullRequestNumber,
        installationId: state.installationId,
        accessMode: state.accessMode,
        baseSha: state.baseSha,
        headSha: state.headSha
      })
    }))
    .addNode("deterministic", async (state: ReviewGraphStateValue) => {
      if (!state.context) {
        throw new Error("Context is missing for deterministic analysis");
      }

      const startedAt = new Date().toISOString();
      const ctx = state.context;
      const files: DeterministicFileInput[] = ctx.changedFiles.map((cf) => ({
        path: cf.path,
        content: ctx.fileContents[cf.path] || "",
        baseline: ctx.baseFileContents[cf.path] ?? "",
        diffHunks: cf.patch ? cf.patch.split("\n@@").map((h, i) => i === 0 ? h : "@@" + h) : []
      }));

      const response = await dependencies.deterministicAnalyzer.analyze(files);
      if (!response.ok) {
        const errorMsg = `Deterministic analysis failed: ${response.error}`;
        const run: AgentRun = {
          id: `agent_${randomUUID()}`,
          jobId: state.jobId,
          agentName: "DeterministicAnalyzer",
          status: "failed",
          startedAt,
          finishedAt: new Date().toISOString(),
          inputSummary: `Analyzed ${files.length} changed files`,
          findings: [],
          error: errorMsg
        };
        dependencies.jobStore.saveAgentRun(run);
        throw new Error(errorMsg);
      }

      const run: AgentRun = {
        id: `agent_${randomUUID()}`,
        jobId: state.jobId,
        agentName: "DeterministicAnalyzer",
        status: "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
        inputSummary: `Analyzed ${files.length} changed files`,
        findings: []
      };
      dependencies.jobStore.saveAgentRun(run);

      return {
        deterministicResult: response,
        agentRuns: [run]
      };
    })
    .addNode("planner", createPlannerNode(agentDependencies))
    .addNode("security", createSecurityAgentNode(agentDependencies))
    .addNode("correctness", createCorrectnessAgentNode(agentDependencies))
    .addNode("maintainability", createMaintainabilityAgentNode(agentDependencies))
    .addNode("test", createTestAgentNode(agentDependencies))
    .addNode("style", createStyleAgentNode(agentDependencies))
    .addNode("composeReview", async (state: ReviewGraphStateValue) => {
      if (!state.deterministicResult) {
        throw new Error("Deterministic analysis result is required before composeReview");
      }

      const fileResults = buildComposeReviewFileResults(
        state.deterministicResult.files,
        state.findings
      );

      const response = await dependencies.deterministicAnalyzer.composeReview(fileResults);
      if (!response.ok) {
        throw new Error(`Compose review failed: ${response.error}`);
      }

      return { composedReview: response };
    })
    .addNode("synthesizer", createSynthesizerNode(agentDependencies))
    .addNode("persistReportAndEnqueuePublish", async (state: ReviewGraphStateValue) => {
      if (!state.report) {
        throw new Error("Synthesizer did not produce a report");
      }
      dependencies.jobStore.persistReportAndEnqueuePublish(state.jobId, state.report);
      return {};
    })
    .addEdge(START, "loadContext")
    .addEdge("loadContext", "deterministic")
    .addEdge("deterministic", "planner")
    .addEdge("planner", "security")
    .addEdge("security", "correctness")
    .addEdge("correctness", "maintainability")
    .addEdge("maintainability", "test")
    .addEdge("test", "style")
    .addEdge("style", "composeReview")
    .addEdge("composeReview", "synthesizer")
    .addEdge("synthesizer", "persistReportAndEnqueuePublish")
    .addEdge("persistReportAndEnqueuePublish", END)
    .compile();
}

export async function runReviewWorkflow(
  input: ReviewWorkflowInput,
  dependencies: ReviewWorkflowDependencies
): Promise<ReviewGraphStateValue> {
  return createReviewWorkflow(dependencies).invoke({
    ...input,
    accessMode: input.accessMode ?? "github_app"
  });
}
