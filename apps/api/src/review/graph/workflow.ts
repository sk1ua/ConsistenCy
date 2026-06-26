import { END, START, StateGraph } from "@langchain/langgraph";
import type { ReviewReport } from "@consistency/schema";
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
import { sanitizePublicError } from "../../security/redact";

export type ReviewWorkflowDependencies = {
  contextBuilder: ContextBuilder;
  provider: LLMProvider;
  jobStore: ReviewJobStore;
  publishReport?: (report: ReviewReport) => Promise<void>;
};

export type ReviewWorkflowInput = Pick<
  ReviewGraphStateValue,
  "jobId" | "repositoryFullName" | "pullRequestNumber" | "installationId" | "baseSha" | "headSha"
>;

export function createReviewWorkflow(dependencies: ReviewWorkflowDependencies) {
  const agentDependencies = { provider: dependencies.provider, jobStore: dependencies.jobStore };
  return new StateGraph(ReviewGraphState)
    .addNode("loadContext", async (state: ReviewGraphStateValue) => ({
      context: await dependencies.contextBuilder({
        jobId: state.jobId,
        repositoryFullName: state.repositoryFullName,
        pullRequestNumber: state.pullRequestNumber,
        installationId: state.installationId,
        baseSha: state.baseSha,
        headSha: state.headSha
      })
    }))
    .addNode("planner", createPlannerNode(agentDependencies))
    .addNode("security", createSecurityAgentNode(agentDependencies))
    .addNode("correctness", createCorrectnessAgentNode(agentDependencies))
    .addNode("maintainability", createMaintainabilityAgentNode(agentDependencies))
    .addNode("test", createTestAgentNode(agentDependencies))
    .addNode("style", createStyleAgentNode(agentDependencies))
    .addNode("synthesizer", createSynthesizerNode(agentDependencies))
    .addNode("persistReport", async (state: ReviewGraphStateValue) => {
      if (!state.report) throw new Error("Synthesizer did not produce a report");
      dependencies.jobStore.markSucceeded(state.jobId, state.report);
      return {};
    })
    .addNode("publishComment", async (state: ReviewGraphStateValue) => {
      if (!state.report) throw new Error("Report is missing before publication");
      if (!dependencies.publishReport) {
        dependencies.jobStore.updateReportCommentStatus(state.jobId, "skipped");
        return {};
      }
      try {
        await dependencies.publishReport(state.report);
        dependencies.jobStore.updateReportCommentStatus(state.jobId, "published");
      } catch (error) {
        const message = error instanceof Error ? sanitizePublicError(error.message) : "Unknown GitHub comment failure";
        dependencies.jobStore.updateReportCommentStatus(state.jobId, "failed", message);
        return { errors: [`GitHub comment: ${message}`] };
      }
      return {};
    })
    .addEdge(START, "loadContext")
    .addEdge("loadContext", "planner")
    .addEdge("planner", "security")
    .addEdge("security", "correctness")
    .addEdge("correctness", "maintainability")
    .addEdge("maintainability", "test")
    .addEdge("test", "style")
    .addEdge("style", "synthesizer")
    .addEdge("synthesizer", "persistReport")
    .addEdge("persistReport", "publishComment")
    .addEdge("publishComment", END)
    .compile();
}

export async function runReviewWorkflow(
  input: ReviewWorkflowInput,
  dependencies: ReviewWorkflowDependencies
): Promise<ReviewGraphStateValue> {
  return createReviewWorkflow(dependencies).invoke(input);
}
