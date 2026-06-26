import { randomUUID } from "node:crypto";
import type { AgentRun } from "@consistency/schema";
import type { ReviewGraphStateValue } from "../graph/state";
import { buildAgentPrompt } from "./prompt";
import type { AgentDependencies, ExecutableReviewAgent } from "./types";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown agent failure";
}

export function createReviewAgentNode(agent: ExecutableReviewAgent, dependencies: AgentDependencies) {
  return async (state: ReviewGraphStateValue) => {
    if (!state.context || !state.plan) throw new Error(`${agent} requires context and plan`);
    const startedAt = new Date().toISOString();
    if (!state.plan.enabledAgents.includes(agent)) {
      const skipped: AgentRun = {
        id: `agent_${randomUUID()}`,
        jobId: state.jobId,
        agentName: agent,
        status: "skipped",
        startedAt,
        finishedAt: startedAt,
        inputSummary: "Skipped by the review plan",
        findings: []
      };
      dependencies.jobStore.saveAgentRun(skipped);
      return { agentRuns: [skipped] };
    }

    const prompt = buildAgentPrompt(agent, state.context);
    try {
      const result = await dependencies.provider.generateAgentRun({ agent, ...prompt });
      const run: AgentRun = {
        id: `agent_${randomUUID()}`,
        jobId: state.jobId,
        agentName: agent,
        status: "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
        inputSummary: `Reviewed ${state.context.changedFiles.length} changed files`,
        findings: result.data.findings,
        tokenUsage: result.tokenUsage
      };
      dependencies.jobStore.saveAgentRun(run);
      return { agentRuns: [run], findings: run.findings };
    } catch (error) {
      const message = errorMessage(error);
      const run: AgentRun = {
        id: `agent_${randomUUID()}`,
        jobId: state.jobId,
        agentName: agent,
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        inputSummary: `Reviewed ${state.context.changedFiles.length} changed files`,
        findings: [],
        error: message
      };
      dependencies.jobStore.saveAgentRun(run);
      return { agentRuns: [run], errors: [`${agent}: ${message}`] };
    }
  };
}
