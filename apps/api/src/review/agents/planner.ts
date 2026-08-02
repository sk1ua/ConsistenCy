import { randomUUID } from "node:crypto";
import { reviewPlanSchema, type AgentRun, type ReviewPlan } from "@consistency/schema";
import type { ReviewGraphStateValue } from "../graph/state";
import type { AgentDependencies } from "./types";
import { REVIEW_AGENT_NAMES } from "./types";

function defaultPlan(reason: string): ReviewPlan {
  return {
    enabledAgents: [...REVIEW_AGENT_NAMES],
    skippedAgents: [],
    riskAreas: ["changed code"],
    reason
  };
}

export function createPlannerNode(dependencies: AgentDependencies) {
  return async (state: ReviewGraphStateValue) => {
    if (!state.context) throw new Error("Planner requires PR context");
    const startedAt = new Date().toISOString();
    const staticSummary = state.deterministicResult?.files
      ? `Static Analysis Summary: High-risk files: ${state.deterministicResult.files.filter(f => f.riskScore >= 0.5).map(f => `${f.path} (score: ${f.riskScore})`).join(", ") || "none"}`
      : "";

    try {
      const result = await dependencies.provider.invokeWithSchema({
        schema: reviewPlanSchema,
        schemaName: "review-plan",
        systemPrompt: "You are the ConsistenCy review planner. Select only relevant review agents. Use the exact agent names Security, Correctness, Maintainability, Test, and Style.",
        userPrompt: [
          `Changed files: ${state.context.changedFiles.map(file => file.path).join(", ")}`,
          staticSummary,
          `Project metadata: ${Object.keys(state.context.projectMetadata).join(", ") || "none"}`,
          `Diff excerpt:\n${state.context.diff.slice(0, 30_000)}`
        ].filter(Boolean).join("\n\n")
      });
      const enabled = REVIEW_AGENT_NAMES.filter(agent => result.data.enabledAgents.includes(agent));
      const plan: ReviewPlan = {
        enabledAgents: enabled,
        skippedAgents: REVIEW_AGENT_NAMES.filter(agent => !enabled.includes(agent)),
        riskAreas: result.data.riskAreas,
        reason: result.data.reason
      };
      const run: AgentRun = {
        id: `agent_${randomUUID()}`,
        jobId: state.jobId,
        agentName: "Planner",
        status: "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
        inputSummary: `Planned review for ${state.context.changedFiles.length} changed files`,
        findings: [],
        tokenUsage: result.tokenUsage,
        provider: dependencies.provider.name,
        model: dependencies.provider.model
      };
      dependencies.jobStore.saveAgentRun(run);
      return { plan, agentRuns: [run] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown planner failure";
      const run: AgentRun = {
        id: `agent_${randomUUID()}`,
        jobId: state.jobId,
        agentName: "Planner",
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        inputSummary: `Planned review for ${state.context.changedFiles.length} changed files`,
        findings: [],
        error: message,
        provider: dependencies.provider.name,
        model: dependencies.provider.model
      };
      dependencies.jobStore.saveAgentRun(run);
      return {
        plan: defaultPlan("Planner output was invalid, so the deterministic full review plan was used."),
        agentRuns: [run],
        errors: [`Planner: ${message}`]
      };
    }
  };
}
