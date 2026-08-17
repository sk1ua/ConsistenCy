/**
 * Review Supervisor — the Workload-side planner.
 *
 * IMPORTANT: the Supervisor chooses WHAT work should be done (a ReviewPlan).
 * It NEVER decides what may RUN — that is the KernelScheduler's admission
 * decision. The supervisor cannot bypass admission by calling agents
 * directly; agent execution always goes through scheduler.admit().
 */

import { randomUUID } from "node:crypto";
import { reviewPlanSchema, type AgentRun, type DomainAnalyzeSuccess, type PRReviewContext, type ReviewPlan } from "@consistency/schema";
import {
  KernelScheduler,
  type AgentId,
} from "@consistency/kernel";
import type { AgentFiberHandle } from "@consistency/harness-core";
import { REVIEW_AGENTS, type AgentFacadeSet, type ReviewPersistence } from "../workload/types.js";

function defaultPlan(reason: string): ReviewPlan {
  return {
    enabledAgents: [...REVIEW_AGENTS],
    skippedAgents: [],
    riskAreas: ["changed code"],
    reason
  };
}

export interface SupervisorBodyOptions {
  readonly fiber: AgentFiberHandle;
  readonly scheduler: KernelScheduler;
  readonly agentId: AgentId;
  readonly jobId: string;
  readonly context: PRReviewContext;
  readonly deterministicResult?: DomainAnalyzeSuccess;
  readonly facades: AgentFacadeSet;
  readonly persistence: ReviewPersistence;
  readonly providerName: string;
  readonly model?: string;
}

export interface SupervisorBodyResult {
  readonly plan: ReviewPlan;
  readonly error?: string;
}

function failAgentSafely(scheduler: KernelScheduler, agentId: AgentId): void {
  const agent = scheduler.getAgent(agentId);
  if (!agent) return;
  if (agent.state === "RUNNING") scheduler.failAgent(agentId);
  else if (agent.state !== "SUCCEEDED" && agent.state !== "FAILED" && agent.state !== "CANCELLED") {
    scheduler.cancelAgent(agentId);
  }
}

export async function runSupervisorBody(options: SupervisorBodyOptions): Promise<SupervisorBodyResult> {
  const { scheduler, agentId, jobId, context, persistence, providerName, model } = options;
  const startedAt = new Date().toISOString();

  const staticSummary = options.deterministicResult?.files
    ? `Static Analysis Summary: High-risk files: ${options.deterministicResult.files.filter(f => f.riskScore >= 0.5).map(f => `${f.path} (score: ${f.riskScore})`).join(", ") || "none"}`
    : "";

  try {
    return await options.fiber.execute(async () => {
      // WAIT_LLM around the protected planning invocation.
      scheduler.wait(agentId, { kind: "llm", provider: providerName });
      let result: { data: ReviewPlan };
      try {
        result = await options.facades.llm.invokeStructured({
          schema: reviewPlanSchema,
          schemaName: "review-plan",
          systemPrompt: `You are the ConsistenCy review planner. Select only relevant review agents. Use the exact agent names ${REVIEW_AGENTS.join(", ")}.`,
          userPrompt: [
            `Changed files: ${context.changedFiles.map(file => file.path).join(", ")}`,
            staticSummary,
            `Project metadata: ${Object.keys(context.projectMetadata).join(", ") || "none"}`,
            `Diff excerpt:\n${context.diff.slice(0, 30_000)}`
          ].filter(Boolean).join("\n\n")
        });
      } finally {
        scheduler.wake(agentId);
      }

      const readmitted = scheduler.admit();
      if (!readmitted || readmitted.id !== agentId) {
        throw new Error("supervisor lost Scheduler admission after planning");
      }

      const enabled = REVIEW_AGENTS.filter(agent => result.data.enabledAgents.includes(agent));
      const plan: ReviewPlan = {
        enabledAgents: enabled,
        skippedAgents: REVIEW_AGENTS.filter(agent => !enabled.includes(agent)),
        riskAreas: result.data.riskAreas,
        reason: result.data.reason
      };

      const run: AgentRun = {
        id: `agent_${randomUUID()}`,
        jobId,
        agentName: "Planner",
        status: "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
        inputSummary: `Planned review for ${context.changedFiles.length} changed files`,
        findings: [],
        provider: providerName as AgentRun["provider"],
        model,
      };
      persistence.saveAgentRun(run);
      scheduler.succeedAgent(agentId);

      return { plan };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown planner failure";
    failAgentSafely(scheduler, agentId);
    const run: AgentRun = {
      id: `agent_${randomUUID()}`,
      jobId,
      agentName: "Planner",
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      inputSummary: `Planned review for ${context.changedFiles.length} changed files`,
      findings: [],
      error: message,
      provider: providerName as AgentRun["provider"],
      model,
    };
    persistence.saveAgentRun(run);
    return {
      plan: defaultPlan("Planner output was invalid, so the deterministic full review plan was used."),
      error: message
    };
  }
}
