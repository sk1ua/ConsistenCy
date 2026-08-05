import { randomUUID } from "node:crypto";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { AgentRun, DomainAnalyzeResponse, ReviewAccessMode, WorkflowSpec } from "@consistency/schema";
import { workflowRunToAnalyzeResult } from "../workflowAdapter";
import { knowledgeIndexPathFor } from "../knowledgeIndex";
import type { ReviewJobStore } from "../../jobQueue";
import { createCorrectnessAgentNode } from "../agents/correctness";
import { createMaintainabilityAgentNode } from "../agents/maintainability";
import { createPlannerNode } from "../agents/planner";
import { createSecurityAgentNode } from "../agents/security";
import { createArchitectureAuditorNode } from "../agents/architectureAuditor";
import { createStyleAgentNode } from "../agents/style";
import { createSynthesizerNode } from "../agents/synthesizer";
import { createTestAgentNode } from "../agents/test";
import type { ContextBuilder } from "../agents/types";
import type { LLMProvider } from "../llm/types";
import { ReviewGraphState, type ReviewGraphStateValue } from "./state";
import { DeterministicAnalyzer, type DeterministicFileInput } from "../deterministic";
import { buildComposeReviewFileResults } from "./composeBuilder";

export const DEFAULT_REVIEW_WORKFLOW = "pr-review";

export type ReviewWorkflowDependencies = {
  contextBuilder: ContextBuilder;
  provider: LLMProvider;
  jobStore: ReviewJobStore;
  deterministicAnalyzer: DeterministicAnalyzer;
  reportLanguage?: "zh-CN" | "en-US";
  /**
   * Workflow backing the deterministic stage. `null` falls back to the legacy
   * single-shot `analyze` action; undefined uses `DEFAULT_REVIEW_WORKFLOW`.
   */
  reviewWorkflow?: string | null;
  /** Resolves a draft workflow to its inline spec; builtins stay name-based. */
  reviewWorkflowSpec?: (name: string) => WorkflowSpec | undefined;
  /** Used to locate the sibling `knowledge/` directory for project memory. */
  workspaceRoot?: string;
};

/**
 * Runs the deterministic stage through the DAG engine and projects the result
 * onto the analysis contract the rest of the graph consumes.
 */
async function runWorkflowStage(
  analyzer: DeterministicAnalyzer,
  workflow: string,
  files: DeterministicFileInput[],
  resolveSpec?: (name: string) => WorkflowSpec | undefined
): Promise<DomainAnalyzeResponse> {
  const spec = resolveSpec?.(workflow);
  const response = spec
    ? await analyzer.runWorkflow(workflow, files, { spec })
    : await analyzer.runWorkflow(workflow, files);
  if (!response.ok) return { id: "workflow", ok: false, error: response.error };
  if (response.run.status !== "succeeded") {
    return {
      id: response.id,
      ok: false,
      error: `Workflow '${workflow}' failed: ${response.run.error ?? "unknown step failure"}`
    };
  }
  return workflowRunToAnalyzeResult(response.id, response.run);
}

export type ReviewWorkflowInput = {
  jobId: string;
  repositoryFullName: string;
  pullRequestNumber?: number;
  repoPath?: string;
  installationId?: number;
  accessMode?: ReviewAccessMode;
  baseSha: string;
  headSha: string;
};

export function createReviewWorkflow(dependencies: ReviewWorkflowDependencies) {
  const workspaceRoot = dependencies.workspaceRoot ?? ".consistency/workspaces";
  const agentDependencies = {
    provider: dependencies.provider,
    jobStore: dependencies.jobStore,
    reportLanguage: dependencies.reportLanguage ?? "zh-CN"
  };

  return new StateGraph(ReviewGraphState)
    .addNode("loadContext", async (state: ReviewGraphStateValue) => ({
      context: await dependencies.contextBuilder({
        jobId: state.jobId,
        repositoryFullName: state.repositoryFullName,
        pullRequestNumber: state.pullRequestNumber,
        repoPath: state.repoPath,
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

      // The DAG engine is the default deterministic stage. `workspacePath` is
      // never forwarded: a review runs against a clone of a repository the
      // author does not control, and subprocess steps would execute its code.
      const response = dependencies.reviewWorkflow === null
        ? await dependencies.deterministicAnalyzer.analyze(files)
        : await runWorkflowStage(
            dependencies.deterministicAnalyzer,
            dependencies.reviewWorkflow ?? DEFAULT_REVIEW_WORKFLOW,
            files,
            dependencies.reviewWorkflowSpec
          );
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
    .addNode("augmentContext", async (state: ReviewGraphStateValue) => {
      if (!state.context) throw new Error("Context is missing for augmentation");
      const ctx = state.context;
      const targets = ctx.changedFiles
        .filter(file => file.status !== "removed")
        .map(file => file.path);
      if (targets.length === 0) return {};

      try {
        const relevantContext = await dependencies.deterministicAnalyzer.relevantContext(
          Object.entries(ctx.fileContents).map(([path, content]) => ({ path, content })),
          targets,
          { indexPath: knowledgeIndexPathFor(ctx.repositoryFullName, workspaceRoot) }
        );
        return { relevantContext };
      } catch {
        // Enrichment only: a review without history is still a valid review.
        return {};
      }
    })
    .addNode("planner", createPlannerNode(agentDependencies))
    .addNode("security", createSecurityAgentNode(agentDependencies))
    .addNode("correctness", createCorrectnessAgentNode(agentDependencies))
    .addNode("maintainability", createMaintainabilityAgentNode(agentDependencies))
    .addNode("test", createTestAgentNode(agentDependencies))
    .addNode("style", createStyleAgentNode(agentDependencies))
    .addNode("architectureAuditor", createArchitectureAuditorNode(agentDependencies))
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

      // Fold this review into project memory only after the report is durable,
      // so memory can never claim a finding from a review that was not stored.
      if (state.context) {
        const ctx = state.context;
        try {
          await dependencies.deterministicAnalyzer.recordReview({
            indexPath: knowledgeIndexPathFor(ctx.repositoryFullName, workspaceRoot),
            jobId: state.jobId,
            reference: ctx.headSha,
            reportedAt: state.report.createdAt,
            coveredFiles: ctx.changedFiles.map(file => file.path),
            findings: state.report.findings.map(finding => ({
              file: finding.file,
              title: finding.title,
              severity: finding.severity
            }))
          });
        } catch {
          // Memory is an enrichment for later reviews. Failing to update it
          // must not fail a review whose report is already persisted.
        }
      }
      return {};
    })
    .addEdge(START, "loadContext")
    .addEdge("loadContext", "deterministic")
    .addEdge("deterministic", "augmentContext")
    .addEdge("augmentContext", "planner")
    .addEdge("planner", "security")
    .addEdge("security", "correctness")
    .addEdge("correctness", "maintainability")
    .addEdge("maintainability", "test")
    .addEdge("test", "style")
    .addEdge("style", "architectureAuditor")
    .addEdge("architectureAuditor", "composeReview")
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
