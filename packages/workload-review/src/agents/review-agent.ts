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
import { tokenUsageFromError, type AgentRun, type DomainAnalyzeSuccess, type PRReviewContext, type RelevantContext, type ReviewFinding, type TokenUsage } from "@consistency/schema";
import type { AgentFiberHandle } from "@consistency/harness-core";
import { buildAgentPrompt } from "./prompts.js";
import { buildGroundingContext, groundReviewFindings } from "./grounding.js";
import { hasSpecificChangedCoverageTarget, isMissingCoverageFinding } from "./test-coverage.js";
import { verifyPrecedent } from "./precedent.js";
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

const severityRank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 } as const;

function capFindings(findings: ReviewFinding[], limit: number, maxCoverage = Infinity): ReviewFinding[] {
  let coverageCount = 0;
  return [...findings].sort((left, right) => severityRank[right.severity] - severityRank[left.severity]
    || (right.evidence.length + right.reasoning.length) - (left.evidence.length + left.reasoning.length)
    || left.id.localeCompare(right.id))
    .filter(finding => !isMissingCoverageFinding(finding) || ++coverageCount <= maxCoverage)
    .slice(0, limit);
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
  readonly focusAreas?: ReadonlyArray<{ pathPattern: string; guidance: string }>;
  readonly facades: AgentFacadeSet;
  readonly persistence: ReviewPersistence;
  readonly providerName: string;
  readonly model?: string;
  readonly maxFindingsPerSpecialist?: number;
  /** A single workload-level empty-result recovery pass; grounding stays intact. */
  readonly omitBaselineSnippets?: boolean;
  /** Default-off compact file context. Unset keeps the full numbered files. */
  readonly compactContext?: boolean;
  /** Lean Consistency must cite a file, line, and verbatim quote. */
  readonly citePrecedent?: boolean;
}

export interface ReviewAgentBodyResult {
  readonly findings: ReviewFinding[];
  readonly preExistingIssues: ReviewFinding[];
  readonly cappedFindingsCount: number;
  /** Distinguish a genuinely empty model response from rejected/appendix findings. */
  readonly rawFindingsCount: number;
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
  let paidUsage: TokenUsage | undefined;

  try {
    return await options.fiber.execute(async () => {
      const prompt = buildAgentPrompt(
        agentName,
        options.omitBaselineSnippets ? { ...options.context, baseFileContents: {} } : options.context,
        options.deterministicResult,
        options.evidence,
        options.reportLanguage,
        options.relevantContext,
        options.focusAreas,
        options.maxFindingsPerSpecialist ?? 3,
        options.compactContext === true,
        options.citePrecedent === true,
      );

      // WAIT_LLM: a remote inference operation is being submitted. This
      // releases local execution capacity; it does NOT preempt the provider.
      scheduler.wait(agentId, { kind: "llm", provider: providerName });
      let modelResult: { findings: ReviewFinding[]; tokenUsage?: TokenUsage };
      try {
        modelResult = await options.facades.llm.invokeAgentFindings({ agent: agentName, ...prompt });
        paidUsage = modelResult.tokenUsage;
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

      let precedentRejected = 0;
      const eligible = agentName === "Test"
        ? modelResult.findings.filter(finding => !isMissingCoverageFinding(finding) || hasSpecificChangedCoverageTarget(finding, options.context))
        : agentName === "Consistency"
          ? modelResult.findings.flatMap(finding => {
            const status = verifyPrecedent(finding, options.context);
            if (status !== "verified") {
              precedentRejected += 1;
              return [];
            }
            return [{ ...finding, tags: [...new Set([...(finding.tags ?? []), "precedent:verified"])] }];
          })
          : modelResult.findings;
      const coverageRejected = modelResult.findings.length - eligible.length;
      const grounding = buildGroundingContext(options.context, options.deterministicResult);
      const grounded = groundReviewFindings(
        eligible,
        grounding,
        options.evidenceStore,
        options.headSha,
      );
      const capped = capFindings(grounded.findings, options.maxFindingsPerSpecialist ?? 3, agentName === "Test" ? 1 : Infinity);
      const cappedCount = grounded.findings.length - capped.length;
      // Missing-coverage comments on out-of-scope/baseline behavior are not
      // actionable PR coverage gaps and must not reappear through the appendix.
      const preExisting = grounded.preExisting.filter(decision => agentName !== "Test" || !isMissingCoverageFinding(decision.finding));
      const rejectedCount = grounded.rejected.length + coverageRejected + grounded.preExisting.length - preExisting.length;

      const summaryParts = [
        summariseGrounding(
          options.context.changedFiles.length,
          rejectedCount,
          grounded.downgraded.length,
        )
      ];
      if (cappedCount > 0) {
        summaryParts.push(`${cappedCount} finding(s) capped by specialist limit`);
      }
      if (precedentRejected > 0) {
        summaryParts.push(`${precedentRejected} finding(s) rejected: unverifiable precedent`);
      }

      const run: AgentRun = {
        id: `agent_${randomUUID()}`,
        jobId,
        agentName,
        status: "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
        inputSummary: [...summaryParts, ...(options.omitBaselineSnippets ? ["Empty-result recovery: Correctness retry without baseline snippets"] : [])].join("; "),
        findings: capped,
        tokenUsage: modelResult.tokenUsage,
        provider: providerName as AgentRun["provider"],
        model,
      };
      persistence.saveAgentRun(run);
      scheduler.succeedAgent(agentId);

      return {
        findings: capped,
        preExistingIssues: preExisting.map(decision => decision.finding),
        cappedFindingsCount: cappedCount,
        rawFindingsCount: modelResult.findings.length,
        tokenUsage: modelResult.tokenUsage,
        rejectedCount,
        downgradedCount: grounded.downgraded.length,
      };
    });
  } catch (error) {
    const message = errorMessage(error);
    const tokenUsage = paidUsage ?? tokenUsageFromError(error);
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
      tokenUsage,
      provider: providerName as AgentRun["provider"],
      model,
    };
    persistence.saveAgentRun(run);
    return { findings: [], preExistingIssues: [], cappedFindingsCount: 0, rawFindingsCount: 0, rejectedCount: 0, downgradedCount: 0, tokenUsage, error: message };
  }
}
