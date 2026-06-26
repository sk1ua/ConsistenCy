import { randomUUID } from "node:crypto";
import type { AgentRun } from "@consistency/schema";
import type { ReviewGraphStateValue } from "../graph/state";
import type { AgentDependencies } from "./types";
import { buildReviewReport, deduplicateAndSortFindings, scoreFindings } from "../report/reportBuilder";

export function createSynthesizerNode(dependencies: AgentDependencies) {
  return async (state: ReviewGraphStateValue) => {
    const startedAt = new Date().toISOString();
    const findings = deduplicateAndSortFindings(state.findings);
    const score = scoreFindings(findings);
    let summary = findings.length === 0
      ? "No confirmed issues were identified by the enabled review agents."
      : `${findings.length} review findings were identified; the quality score is ${score}/100.`;
    let tokenUsage;
    let error: string | undefined;
    try {
      const result = await dependencies.provider.generateSummary({
        systemPrompt: "Summarize a multi-agent pull request review in two concise sentences. Do not add findings or claims that are absent from the supplied data.",
        userPrompt: JSON.stringify({ score, findings })
      });
      summary = result.data.summary;
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
      tokenUsage
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
      findings
    });
    return {
      agentRuns: [run],
      report,
      ...(error ? { errors: [`Synthesizer: ${error}`] } : {})
    };
  };
}
