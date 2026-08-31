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
    reason,
    focusAreas: []
  };
}

const TEST_PATH_PATTERN = /(^|\/|\\)(tests?|__tests__|spec|fixtures?)(\/|\\|\.|$)|\.(test|spec)\.[jt]sx?$|\.d\.ts$/i;

interface ChangeMix {
  readonly productFiles: number;
  readonly testFiles: number;
  readonly configFiles: number;
  readonly docFiles: number;
  readonly total: number;
}

/** Local, deterministic change-mix triage: product vs test vs config vs docs. */
function classifyChangeMix(changedFiles: Array<{ path: string }>): ChangeMix {
  let productFiles = 0;
  let testFiles = 0;
  let configFiles = 0;
  let docFiles = 0;
  for (const file of changedFiles) {
    const path = file.path;
    if (/\.(md|mdx|txt|rst)$/i.test(path)) docFiles += 1;
    else if (TEST_PATH_PATTERN.test(path)) testFiles += 1;
    else if (/\.(json|ya?ml|toml|ini|cfg|conf|lock)$/i.test(path) || /(^|\/|\\)\.github(\/|\\)/.test(path)) configFiles += 1;
    else productFiles += 1;
  }
  return { productFiles, testFiles, configFiles, docFiles, total: changedFiles.length };
}

function formatChangeMix(mix: ChangeMix): string {
  const percent = (count: number) => (mix.total === 0 ? "0%" : `${Math.round((count / mix.total) * 100)}%`);
  return [
    "Change mix (triage input):",
    `- Product code: ${mix.productFiles} file(s) (${percent(mix.productFiles)})`,
    `- Tests: ${mix.testFiles} file(s) (${percent(mix.testFiles)})`,
    `- Config/build: ${mix.configFiles} file(s) (${percent(mix.configFiles)})`,
    `- Docs: ${mix.docFiles} file(s) (${percent(mix.docFiles)})`,
    "Prioritization policy: focus the review on PRODUCT code; test-file maintainability findings are LOW priority and should only be reported when high-value. Even when tests dominate the diff, product code must be fully covered.",
    "In your plan, set focusAreas to the product-code areas that deserve the most attention (pathPattern + short guidance each). focusAreas are advisory: agents must still report any real finding outside them."
  ].join("\n");
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

  const changeMix = classifyChangeMix(context.changedFiles);
  const changeMixPrompt = formatChangeMix(changeMix);

  try {
    return await options.fiber.execute(async () => {
      // WAIT_LLM around the protected planning invocation.
      scheduler.wait(agentId, { kind: "llm", provider: providerName });
      let rawResult: { data: unknown };
      try {
        rawResult = await options.facades.llm.invokeStructured({
          schema: reviewPlanSchema,
          schemaName: "review-plan",
          systemPrompt: `You are the ConsistenCy review planner. Select only relevant review agents. Use the exact agent names ${REVIEW_AGENTS.join(", ")}.`,
          userPrompt: [
            `Changed files: ${context.changedFiles.map(file => file.path).join(", ")}`,
            staticSummary,
            changeMixPrompt,
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

      const parsedPlan = reviewPlanSchema.parse(rawResult.data);
      const enabled = REVIEW_AGENTS.filter(agent => parsedPlan.enabledAgents.includes(agent));
      const plan: ReviewPlan = {
        enabledAgents: enabled,
        skippedAgents: REVIEW_AGENTS.filter(agent => !enabled.includes(agent)),
        riskAreas: parsedPlan.riskAreas,
        reason: parsedPlan.reason,
        focusAreas: parsedPlan.focusAreas
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
