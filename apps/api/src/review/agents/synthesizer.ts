import { randomUUID } from "node:crypto";
import type { AgentRun } from "@consistency/schema";
import type { ReviewGraphStateValue } from "../graph/state";
import type { AgentDependencies } from "./types";
import { buildReviewReport, deduplicateAndSortFindings } from "../report/reportBuilder";

export function createSynthesizerNode(dependencies: AgentDependencies) {
  return async (state: ReviewGraphStateValue) => {
    if (!state.composedReview) {
      throw new Error("Canonical compose review result is required");
    }

    const startedAt = new Date().toISOString();
    const findings = deduplicateAndSortFindings(state.findings);
    const {
      overallScore: score,
      riskLevel,
      summary: canonicalSummary,
      recommendations
    } = state.composedReview;

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
    let tokenUsage;
    let error: string | undefined;

    try {
      const result = await dependencies.provider.generateSummary({
        systemPrompt: "Summarize a multi-agent pull request review in two concise sentences. Incorporate the canonical summary and recommendations into the overview without omitting critical recommendations. Do not add findings or claims that are absent from the supplied data.",
        userPrompt: JSON.stringify({
          canonicalScore: score,
          canonicalRiskLevel: riskLevel,
          canonicalSummary,
          recommendations,
          findings
        })
      });

      summary = canonicalOverview
        ? `${canonicalOverview}\n\nAgent Overview: ${result.data.summary}`
        : result.data.summary;
      tokenUsage = result.tokenUsage;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Unknown synthesizer failure";
    }

    const run: AgentRun = {
      id: `agent_${randomUUID()}`,
      jobId: state.jobId,
      agentName: "Synthesizer",
      status: error ? "failed" : "succeeded",
      startedAt,
      finishedAt: new Date().toISOString(),
      inputSummary: `Synthesized ${state.findings.length} raw findings`,
      findings,
      error,
      tokenUsage,
      provider: dependencies.provider.name,
      model: dependencies.provider.model
    };
    dependencies.jobStore.saveAgentRun(run);

    const report = buildReviewReport({
      jobId: state.jobId,
      repositoryFullName: state.repositoryFullName,
      pullRequestNumber: state.pullRequestNumber,
      baseSha: state.baseSha,
      headSha: state.headSha,
      summary,
      agentRuns: [...state.agentRuns, run],
      findings,
      score,
      riskLevel,
      retrieval: state.deterministicResult?.evidencePack
    });

    return {
      agentRuns: [run],
      report,
      ...(error ? { errors: [`Synthesizer: ${error}`] } : {})
    };
  };
}
