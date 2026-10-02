/**
 * Synthesizer — consumes deterministic compose results + grounded Agent
 * findings and produces the ReviewReport. Runs under Scheduler admission
 * with WAIT_TOOL / WAIT_LLM around its protected operations.
 */

import { randomUUID } from "node:crypto";
import { staticRiskLabelForFiles } from "@consistency/schema";
import {
  KernelScheduler,
  type AgentId,
} from "@consistency/kernel";
import type {
  AgentRun,
  DomainAnalyzeSuccess,
  DomainComposeReviewSuccess,
  FindingScore,
  ReviewCoverage,
  ReviewFinding,
  ReviewReport,
  TokenUsage,
} from "@consistency/schema";
import { tokenUsageFromError, recordTokenUsageOnError, findingScoresFromError } from "@consistency/schema";
import type { AgentFiberHandle } from "@consistency/harness-core";
import { buildComposeReviewFileResults } from "./compose.js";
import { modelSummaryProse } from "./summary-prose.js";
import { buildReviewReport, deduplicateAndSortFindings } from "./report.js";
import { isGenericCoverageFinding } from "../agents/test-coverage.js";
import { applyFindingScoreFilter, FINDING_SCORE_INSTRUCTION, FINDING_SCORE_INSTRUCTION_V2 } from "./finding-score.js";
import { reportLanguageInstruction } from "../agents/prompts.js";
import { redactModelVisibleText } from "../context/content-policy.js";
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
  /** Changed paths whose baseline content was absent or deliberately skipped. */
  readonly missingBaselinePaths?: readonly string[];
  /** Paths the deterministic stage actually scored, used for the static label. */
  readonly analyzedPaths?: readonly string[];
  readonly newFileCount?: number;
  readonly notAnalyzedReason?: string;
  readonly findings: ReviewFinding[];
  readonly preExistingIssues?: ReviewFinding[];
  readonly totalCappedBySpecialists?: number;
  readonly agentRuns: AgentRun[];
  readonly deterministic: DeterministicStage;
  readonly facades: AgentFacadeSet;
  readonly persistence: ReviewPersistence;
  readonly reportLanguage: "zh-CN" | "en-US";
  readonly providerName: string;
  readonly model?: string;
  /** Score floor for the main list; see synthesis/finding-score.ts. */
  readonly minFindingScore?: number;
  /** Main-list cap, applied after scoring. */
  readonly maxReportedFindings?: number;
  /** Per-file cap on the main list, applied after scoring. */
  readonly maxFindingsPerFile?: number;
  /** Default-off v2 rubric and per-file cap of 4. Unset keeps the v1 instruction. */
  readonly scoreRubricV2?: boolean;
  /** Lean-only: different specialists merge only on near-duplicate titles or prose. */
  readonly strictCrossAgentMerge?: boolean;
  /** Numbered changed lines, supplied only when the v2 rubric is enabled. */
  readonly numberedChangedCode?: string;
  /**
   * Coverage facts known before synthesis (planner + specialist outcomes).
   * The synthesizer adds its own status and derives the final outcome.
   */
  readonly coverage: Omit<ReviewCoverage, "outcome" | "synthesizerFailed">;
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

/** Deterministic, localized coverage warning prepended to degraded summaries. */
function coverageWarning(coverage: ReviewCoverage, language: "zh-CN" | "en-US"): string {
  const parts: string[] = [];
  if (coverage.failedAgents.length > 0) {
    parts.push(language === "zh-CN"
      ? `${coverage.failedAgents.length}/${coverage.enabledAgents.length} 个启用的检查代理执行失败`
      : `${coverage.failedAgents.length} of ${coverage.enabledAgents.length} enabled review agents failed`);
  }
  if (coverage.plannerFailed) {
    parts.push(language === "zh-CN" ? "规划器使用了兜底计划" : "the planner fell back to a default plan");
  }
  if (coverage.synthesizerFailed) {
    parts.push(language === "zh-CN" ? "汇总降级" : "synthesis was degraded");
  }
  if (coverage.deterministicFailed) {
    parts.push(language === "zh-CN" ? "确定性分析步骤未全部成功" : "the deterministic workflow did not complete every step");
  }
  const detail = parts.join(language === "zh-CN" ? "，" : "; ");
  return language === "zh-CN"
    ? `审查覆盖不完整（${detail}）：发现结果可能未覆盖全部改动，不能视为完整审查通过。`
    : `Review coverage incomplete (${detail}): findings may not cover the full change set; this is not a clean review.`;
}

export async function runSynthesizerBody(options: SynthesizerBodyOptions): Promise<SynthesizerBodyResult> {
  const { scheduler, agentId, jobId, persistence, providerName, model } = options;
  const startedAt = new Date().toISOString();
  let paidUsage: TokenUsage | undefined;

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

      const dedupOptions = { strictCrossAgent: options.strictCrossAgentMerge === true };
      const { findings: dedupedFindings, duplicates } = deduplicateAndSortFindings(
        options.scoreRubricV2 === true ? options.findings.filter(finding => !isGenericCoverageFinding(finding)) : options.findings,
        true,
        dedupOptions
      );
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

      const appendixCandidates = deduplicateAndSortFindings((options.preExistingIssues ?? []).filter(f => {
        const text = `${f.title} ${f.evidence} ${f.recommendation}`;
        return !/no (?:changes?|action) needed/i.test(text);
      }), true, dedupOptions).findings;

      let summary: string | undefined;
      let tokenUsage: TokenUsage | undefined;
      let error: string | undefined;
      let scores: readonly FindingScore[] = [];

      try {
        // WAIT_LLM around the protected summary invocation.
        scheduler.wait(agentId, { kind: "llm", provider: providerName });
        let summaryResult: { text: string; tokenUsage?: typeof tokenUsage; scores?: readonly FindingScore[] };
        try {
          // ONE call carries both the prose summary and the per-finding
          // scores: scoring never adds a second request.
          summaryResult = await options.facades.llm.invokeText({
            schemaName: "review-summary",
            systemPrompt: [
              "Summarize a multi-agent pull request review in two concise sentences. Incorporate the canonical summary and recommendations into the overview without omitting critical recommendations. Do not add findings or claims that are absent from the supplied data. Do not state finding counts or severity totals: supplied findings are candidates before score filtering and caps, and final counts will be added deterministically after filtering.",
              options.scoreRubricV2 === true ? `${FINDING_SCORE_INSTRUCTION} ${FINDING_SCORE_INSTRUCTION_V2}` : FINDING_SCORE_INSTRUCTION,
              reportLanguageInstruction(options.reportLanguage)
            ].join(" "),
            userPrompt: redactModelVisibleText(JSON.stringify({
              canonicalScore: score,
              canonicalRiskLevel: riskLevel,
              canonicalSummary,
              recommendations,
              findings: dedupedFindings,
              preExistingIssues: appendixCandidates,
              ...(options.scoreRubricV2 === true ? { changedCode: options.numberedChangedCode ?? "" } : {})
            }))
          });
          tokenUsage = summaryResult.tokenUsage;
          paidUsage = tokenUsage;
        } finally {
          scheduler.wake(agentId);
        }
        summary = modelSummaryProse(summaryResult.text) ?? canonicalOverview;
        scores = summaryResult.scores ?? [];
      } catch (caught) {
        scores = findingScoresFromError(caught);
        tokenUsage ??= tokenUsageFromError(caught);
        paidUsage = tokenUsage;
        error = caught instanceof Error ? caught.message : "Unknown synthesizer failure";
      }
      // wake() runs for both success and failure. Re-admit before producing
      // either the model summary or the canonical fallback report.
      const readmittedAfterSummary = scheduler.admit();
      if (!readmittedAfterSummary || readmittedAfterSummary.id !== agentId) {
        throw new Error("synthesizer lost Scheduler admission after summary");
      }

      // Step 4 runs whether or not the model call succeeded: with no scores
      // nothing is dropped on score, but the per-file and total caps still
      // bound the main list. A withheld finding is counted, never re-shown.
      const { findings, filteredCount, breakdown } = applyFindingScoreFilter(dedupedFindings, scores, {
        minScore: options.minFindingScore,
        maxReported: options.maxReportedFindings,
        maxPerFile: options.maxFindingsPerFile ?? (options.scoreRubricV2 === true ? 4 : undefined),
        capUnverifiedConsistency: options.scoreRubricV2 === true
      });

      const appendixFilter = applyFindingScoreFilter(appendixCandidates, scores, {
        minScore: options.minFindingScore,
        maxReported: options.maxReportedFindings,
        maxPerFile: options.maxFindingsPerFile ?? (options.scoreRubricV2 === true ? 4 : undefined),
        capUnverifiedConsistency: options.scoreRubricV2 === true
      });
      const totalFiltered = filteredCount + appendixFilter.filteredCount + (options.totalCappedBySpecialists ?? 0);
      const filteredBreakdown = {
        capPerSpecialist: options.totalCappedBySpecialists ?? 0,
        lowScore: (breakdown?.lowScore ?? 0) + (appendixFilter.breakdown?.lowScore ?? 0),
        capPerFile: (breakdown?.capPerFile ?? 0) + (appendixFilter.breakdown?.capPerFile ?? 0),
        capTotal: (breakdown?.capTotal ?? 0) + (appendixFilter.breakdown?.capTotal ?? 0)
      };

      // Appendix candidates share the same scoring call, but their caps do
      // not consume slots in the actionable list.
      const preExistingIssues = appendixFilter.findings;

      // Final coverage (audit P1-05): degraded coverage must be visible in
      // the durable report, never masked by a success-shaped summary.
      const coverage: ReviewCoverage = {
        ...options.coverage,
        synthesizerFailed: Boolean(error),
        outcome:
          options.coverage.failedAgents.length > 0
          || options.coverage.plannerFailed
          || Boolean(error)
          || Boolean(options.coverage.deterministicFailed)
            ? "degraded"
            : "complete"
      };
      const failureNote = coverage.outcome === "degraded"
        ? coverageWarning(coverage, options.reportLanguage)
        : "";

      const fallbackSummary = canonicalOverview || (
        coverage.outcome === "degraded" && findings.length === 0
          ? "No findings were produced and agent coverage is incomplete — this run does NOT represent a clean review."
          : findings.length === 0
            ? "No confirmed issues were identified by the enabled review agents."
            : `${findings.length} review findings were identified; the quality score is ${score}/100.`
      );
      // Deterministic prefix so a degraded run can never read as a clean
      // review regardless of how the model phrases its summary.
      const finalSummary = failureNote
        ? `${failureNote}\n\n${summary ?? fallbackSummary}`
        : (summary ?? fallbackSummary);

      const run: AgentRun = {
        id: `agent_${randomUUID()}`,
        jobId,
        agentName: "Synthesizer",
        status: error ? "failed" : "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
        inputSummary: totalFiltered > 0
          ? `Synthesized ${options.findings.length} raw findings; ${totalFiltered} withheld after scoring/capping`
          : `Synthesized ${options.findings.length} raw findings`,
        findings,
        error,
        tokenUsage,
        provider: providerName as AgentRun["provider"],
        model,
      };
      // Snapshot BEFORE saveAgentRun: the persistence wrapper appends the run
      // to options.agentRuns, so appending it again here would duplicate the
      // Synthesizer in report telemetry (audit P2-02).
      const agentRunsForReport = [...options.agentRuns, run];
      persistence.saveAgentRun(run);

      const scored = options.analyzedPaths ?? options.deterministicResult.files
        .filter(file => file.confidence > 0 || file.findings.length > 0 || file.riskLabel.includes("No Baseline"))
        .map(file => file.path);
      const labeledMissing = options.deterministicResult.files
        .filter(file => scored.includes(file.path) && file.riskLabel.includes("No Baseline"))
        .map(file => file.path);
      const missing = new Set([...(options.missingBaselinePaths ?? []).filter(path => scored.includes(path)), ...labeledMissing]);
      const baselined = scored.filter(path => !missing.has(path));
      const staticRiskLabel = staticRiskLabelForFiles(options.deterministicResult.files, {
        analyzedPaths: scored,
        baselinedPaths: baselined,
        newFileCount: options.newFileCount ?? missing.size,
        missingBaseline: scored.length > 0 && baselined.length === 0,
        notAnalyzedReason: scored.length === 0 ? options.notAnalyzedReason ?? "deterministic analysis returned no scored files" : undefined,
      });

      const report = buildReviewReport({
        jobId,
        repositoryFullName: options.repositoryFullName,
        pullRequestNumber: options.pullRequestNumber,
        baseSha: options.baseSha,
        headSha: options.headSha,
        summary: finalSummary,
        reportLanguage: options.reportLanguage,
        llmProvider: providerName,
        llmModel: model,
        agentRuns: agentRunsForReport,
        findings,
        duplicates,
        filteredFindingCount: totalFiltered,
        filteredBreakdown,
        preExistingIssues,
        score,
        riskLevel,
        staticRiskLabel,
        coverage,
        retrieval: options.deterministicResult.evidencePack,
        strictCrossAgentMerge: options.strictCrossAgentMerge
      });

      scheduler.succeedAgent(agentId);
      return { report, error };
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Unknown synthesizer failure";
    const tokenUsage = paidUsage ?? tokenUsageFromError(caught);
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
