import { randomUUID } from "node:crypto";
import type { AgentRun } from "@consistency/schema";
import type { ReviewGraphStateValue } from "../graph/state";
import { buildAgentPrompt } from "./prompt";
import { buildGroundingContext, groundFindings, type GroundingResult } from "./grounding";
import type { AgentDependencies, ExecutableReviewAgent } from "./types";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown agent failure";
}

/** Records what the grounding gate did, so a run is auditable after the fact. */
function summariseGrounding(changedFileCount: number, grounded: GroundingResult): string {
  const parts = [`Reviewed ${changedFileCount} changed files`];
  if (grounded.rejected.length > 0) {
    parts.push(`${grounded.rejected.length} finding(s) rejected as ungrounded`);
  }
  if (grounded.downgraded.length > 0) {
    parts.push(`${grounded.downgraded.length} finding(s) downgraded for weak evidence`);
  }
  return parts.join("; ");
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
        findings: [],
        provider: dependencies.provider.name,
        model: dependencies.provider.model
      };
      dependencies.jobStore.saveAgentRun(skipped);
      return { agentRuns: [skipped] };
    }

    const prompt = buildAgentPrompt(
      agent,
      state.context,
      state.deterministicResult,
      dependencies.reportLanguage,
      state.relevantContext
    );
    try {
      const result = await dependencies.provider.generateAgentRun({ agent, ...prompt });

      // Model output is gated on evidence before it can reach a report. This
      // runs on the response rather than being requested in the prompt, so a
      // model cannot talk its way past it.
      const grounding = buildGroundingContext(state.context, state.deterministicResult);
      const grounded = groundFindings(result.data.findings, grounding);

      const run: AgentRun = {
        id: `agent_${randomUUID()}`,
        jobId: state.jobId,
        agentName: agent,
        status: "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
        inputSummary: summariseGrounding(state.context.changedFiles.length, grounded),
        findings: grounded.findings,
        tokenUsage: result.tokenUsage,
        provider: dependencies.provider.name,
        model: dependencies.provider.model
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
        error: message,
        provider: dependencies.provider.name,
        model: dependencies.provider.model
      };
      dependencies.jobStore.saveAgentRun(run);
      return { agentRuns: [run], errors: [`${agent}: ${message}`] };
    }
  };
}
