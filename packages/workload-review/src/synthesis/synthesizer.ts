/**
 * Synthesizer — consumes deterministic compose results + grounded Agent
 * findings and produces the ReviewReport. Runs under Scheduler admission
 * with WAIT_TOOL / WAIT_LLM around its protected operations.
 */

import { randomUUID } from "node:crypto";
import {
  KernelScheduler,
  type AgentId,
} from "@consistency/kernel";
import type {
  AgentRun,
  DomainAnalyzeSuccess,
  DomainComposeReviewSuccess,
  ReviewFinding,
  ReviewReport,
  TokenUsage,
} from "@consistency/schema";
import type { AgentFiberHandle } from "@consistency/harness-core";
import { buildComposeReviewFileResults } from "./compose.js";
import { buildReviewReport, deduplicateAndSortFindings } from "./report.js";
import { reportLanguageInstruction } from "../agents/prompts.js";
import type {
  AgentFacadeSet,
  DeterministicStage,
  ReviewPersistence,
} from "../workload/types.js";

export interface SynthesizerBodyOptions {
  readonly fiber: AgentFiberHandle;
  readonly scheduler: KernelScheduler;
  readonly agentId: AgentId;
  readonly jobId: string;
  readonly repositoryFullName: string;
  readonly pullRequestNumber?: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly deterministicResult: DomainAnalyzeSuccess;
  readonly findings: ReviewFinding[];
  readonly agentRuns: AgentRun[];
  readonly deterministic: DeterministicStage;
  readonly facades: AgentFacadeSet;
  readonly persistence: ReviewPersistence;
  readonly reportLanguage: "zh-CN" | "en-US";
  readonly providerName: string;
  readonly model?: string;
}

export interface SynthesizerBodyResult {
  readonly report: ReviewReport;
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

export async function runSynthesizerBody(options: SynthesizerBodyOptions): Promise<SynthesizerBodyResult> {
  const { scheduler, agentId, jobId, persistence, providerName, model } = options;
  const startedAt = new Date().toISOString();

  try {
    return await options.fiber.execute(async () => {
      // WAIT_TOOL: the deterministic compose stage is a protected tool call.
      scheduler.wait(agentId, { kind: "tool", toolName: "deterministic.compose" });
      let composed: DomainComposeReviewSuccess;
      try {
        const fileResults = buildComposeReviewFileResults(
          options.deterministicResult.files,
          options.findings,
        );
        const response = await options.deterministic.composeReview(fileResults);
        if (!response.ok) {
          throw new Error(`Compose review failed: ${response.error}`);
        }
        composed = response;
      } finally {
        scheduler.wake(agentId);
      }

      const readmitted = scheduler.admit();
      if (!readmitted || readmitted.id !== agentId) {
        throw new Error("synthesizer lost Scheduler admission after compose");
      }

      const findings = deduplicateAndSortFindings(options.findings);
      const {
        overallScore: score,
        riskLevel,
        summary: canonicalSummary,
        recommendations
      } = composed;

      const canonicalOverview = [
        canonicalSummary,
        ...recommendations.map(item => `Recommendation: ${item}`)
      ].filter(Boolean).join(" ").trim();

      const fallbackSummary = canonicalOverview || (
        findings.length === 0
          ? "No confirmed issues were identified by the enabled review agents."
          : `${findings.length} review findings were identified; the quality score is ${score}/100.`
      );

      let summary = fallbackSummary;
      let tokenUsage: TokenUsage | undefined;
      let error: string | undefined;

      try {
        // WAIT_LLM around the protected summary invocation.
        scheduler.wait(agentId, { kind: "llm", provider: providerName });
        let summaryResult: { text: string; tokenUsage?: typeof tokenUsage };
        try {
          summaryResult = await options.facades.llm.invokeText({
            schemaName: "review-summary",
            systemPrompt: [
              "Summarize a multi-agent pull request review in two concise sentences. Incorporate the canonical summary and recommendations into the overview without omitting critical recommendations. Do not add findings or claims that are absent from the supplied data.",
              reportLanguageInstruction(options.reportLanguage)
            ].join(" "),
            userPrompt: JSON.stringify({
              canonicalScore: score,
              canonicalRiskLevel: riskLevel,
              canonicalSummary,
              recommendations,
              findings
            })
          });
        } finally {
          scheduler.wake(agentId);
        }
        const readmittedAfterSummary = scheduler.admit();
        if (!readmittedAfterSummary || readmittedAfterSummary.id !== agentId) {
          throw new Error("synthesizer lost Scheduler admission after summary");
        }
        summary = canonicalOverview
          ? `${canonicalOverview}\n\nAgent Overview: ${summaryResult.text}`
          : summaryResult.text;
        tokenUsage = summaryResult.tokenUsage;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : "Unknown synthesizer failure";
      }

      const run: AgentRun = {
        id: `agent_${randomUUID()}`,
        jobId,
        agentName: "Synthesizer",
        status: error ? "failed" : "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
        inputSummary: `Synthesized ${options.findings.length} raw findings`,
        findings,
        error,
        tokenUsage,
        provider: providerName as AgentRun["provider"],
        model,
      };
      persistence.saveAgentRun(run);

      const report = buildReviewReport({
        jobId,
        repositoryFullName: options.repositoryFullName,
        pullRequestNumber: options.pullRequestNumber,
        baseSha: options.baseSha,
        headSha: options.headSha,
        summary,
        llmProvider: providerName,
        llmModel: model,
        agentRuns: [...options.agentRuns, run],
        findings,
        score,
        riskLevel,
        retrieval: options.deterministicResult.evidencePack
      });

      scheduler.succeedAgent(agentId);
      return { report, error };
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Unknown synthesizer failure";
    failAgentSafely(scheduler, agentId);
    const run: AgentRun = {
      id: `agent_${randomUUID()}`,
      jobId,
      agentName: "Synthesizer",
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      inputSummary: `Synthesized ${options.findings.length} raw findings`,
      findings: [],
      error: message,
      provider: providerName as AgentRun["provider"],
      model,
    };
    persistence.saveAgentRun(run);
    // Compose failure is fatal (parity with the legacy graph): no report
    // can be produced — rethrow after recording the failed telemetry.
    throw new Error(message);
  }
}
