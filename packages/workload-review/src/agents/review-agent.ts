/**
 * Review agent runner — executes ONE specialized agent's work under REAL
 * Scheduler admission + fiber lifecycle + Kernel capability enforcement.
 *
 * State transitions (all Scheduler-owned):
 *   READY → RUNNING (admit) → WAIT_LLM (before the protected model call)
 *   → READY (wake) → RUNNING (re-admit) → SUCCEEDED / FAILED
 *
 * The model invocation goes through CapabilityBoundLLMFacade (Kernel
 * authorize per call); findings pass the ported grounding gate plus Kernel
 * Evidence validation.
 */

import { randomUUID } from "node:crypto";
import {
  KernelScheduler,
  EvidenceStore,
  type AgentId,
  type AgentSnapshot,
  type EvidenceSnapshot,
} from "@consistency/kernel";
import type { AgentRun, DomainAnalyzeSuccess, PRReviewContext, RelevantContext, ReviewFinding, TokenUsage } from "@consistency/schema";
import type { AgentFiberHandle } from "@consistency/harness-core";
import { buildAgentPrompt } from "./prompts.js";
import { buildGroundingContext, groundReviewFindings } from "./grounding.js";
import type { AgentFacadeSet, ReviewAgentName, ReviewPersistence } from "../workload/types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown agent failure";
}

function summariseGrounding(changedFileCount: number, rejected: number, downgraded: number): string {
  const parts = [`Reviewed ${changedFileCount} changed files`];
  if (rejected > 0) parts.push(`${rejected} finding(s) rejected as ungrounded`);
  if (downgraded > 0) parts.push(`${downgraded} finding(s) downgraded for weak evidence`);
  return parts.join("; ");
}

export interface ReviewAgentBodyOptions {
  readonly fiber: AgentFiberHandle;
  readonly scheduler: KernelScheduler;
  readonly agentId: AgentId;
  readonly agentName: ReviewAgentName;
  readonly jobId: string;
  readonly context: PRReviewContext;
  readonly deterministicResult?: DomainAnalyzeSuccess;
  readonly evidence: readonly EvidenceSnapshot[];
  readonly evidenceStore: EvidenceStore;
  readonly headSha: string;
  readonly reportLanguage: "zh-CN" | "en-US";
  readonly relevantContext?: Record<string, RelevantContext>;
  readonly facades: AgentFacadeSet;
  readonly persistence: ReviewPersistence;
  readonly providerName: string;
  readonly model?: string;
}

export interface ReviewAgentBodyResult {
  readonly findings: ReviewFinding[];
  readonly tokenUsage?: TokenUsage;
  readonly rejectedCount: number;
  readonly downgradedCount: number;
  readonly error?: string;
}

/** Transition an agent to FAILED from any non-terminal state (fail-safe). */
function failAgentSafely(scheduler: KernelScheduler, agentId: AgentId): void {
  const agent: AgentSnapshot | undefined = scheduler.getAgent(agentId);
  if (!agent) return;
  if (agent.state === "RUNNING") {
    scheduler.failAgent(agentId);
  } else if (agent.state !== "SUCCEEDED" && agent.state !== "FAILED" && agent.state !== "CANCELLED") {
    scheduler.cancelAgent(agentId);
  }
}

export async function runReviewAgentBody(options: ReviewAgentBodyOptions): Promise<ReviewAgentBodyResult> {
  const { scheduler, agentId, agentName, jobId, persistence, providerName, model } = options;
  const startedAt = new Date().toISOString();

  try {
    return await options.fiber.execute(async () => {
      const prompt = buildAgentPrompt(
        agentName,
        options.context,
        options.deterministicResult,
        options.evidence,
        options.reportLanguage,
        options.relevantContext,
      );

      // WAIT_LLM: a remote inference operation is being submitted. This
      // releases local execution capacity; it does NOT preempt the provider.
      scheduler.wait(agentId, { kind: "llm", provider: providerName });
      let modelResult: { findings: ReviewFinding[]; tokenUsage?: TokenUsage };
      try {
        modelResult = await options.facades.llm.invokeAgentFindings({ agent: agentName, ...prompt });
      } finally {
        scheduler.wake(agentId);
      }

      // Re-admission for the local grounding phase (only this agent is READY
      // in the workload's sequential execution; the Scheduler still owns the
      // decision).
      const readmitted = scheduler.admit();
      if (!readmitted || readmitted.id !== agentId) {
        throw new Error("agent lost Scheduler admission after model invocation");
      }

      const grounding = buildGroundingContext(options.context, options.deterministicResult);
      const grounded = groundReviewFindings(
        modelResult.findings,
        grounding,
        options.evidenceStore,
        options.headSha,
      );

      const run: AgentRun = {
        id: `agent_${randomUUID()}`,
        jobId,
        agentName,
        status: "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
        inputSummary: summariseGrounding(
          options.context.changedFiles.length,
          grounded.rejected.length,
          grounded.downgraded.length,
        ),
        findings: grounded.findings,
        tokenUsage: modelResult.tokenUsage,
        provider: providerName as AgentRun["provider"],
        model,
      };
      persistence.saveAgentRun(run);
      scheduler.succeedAgent(agentId);

      return {
        findings: grounded.findings,
        tokenUsage: modelResult.tokenUsage,
        rejectedCount: grounded.rejected.length,
        downgradedCount: grounded.downgraded.length,
      };
    });
  } catch (error) {
    const message = errorMessage(error);
    failAgentSafely(scheduler, agentId);
    const run: AgentRun = {
      id: `agent_${randomUUID()}`,
      jobId,
      agentName,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      inputSummary: `Reviewed ${options.context.changedFiles.length} changed files`,
      findings: [],
      error: message,
      provider: providerName as AgentRun["provider"],
      model,
    };
    persistence.saveAgentRun(run);
    return { findings: [], rejectedCount: 0, downgradedCount: 0, error: message };
  }
}
