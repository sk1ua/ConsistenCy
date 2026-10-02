import { deduplicateAndSortFindings, riskBandForFindings, summaryForFinalFindings } from "@consistency/workload-review";
import {
  reviewReportSchema,
  promptTokensForAgentRuns,
  tokenUsageNotesForAgentRuns,
  type AgentRun,
  type RetrievalTrace,
  type ReviewFinding,
  type ReviewReport,
  type RiskLevel
} from "@consistency/schema";

export { deduplicateAndSortFindings };

export function buildReviewReport(input: {
  jobId: string;
  repositoryFullName: string;
  /** Absent for local reviews, which have no pull request. */
  pullRequestNumber?: number;
  baseSha: string;
  headSha: string;
  summary: string;
  agentRuns: AgentRun[];
  findings: ReviewFinding[];
  score: number;
  riskLevel: RiskLevel;
  retrieval?: RetrievalTrace;
  createdAt?: string;
}): ReviewReport {
  const { findings, duplicates } = deduplicateAndSortFindings(input.findings, true);
  const promptTokens = promptTokensForAgentRuns(input.agentRuns);
  const tokenUsageNotes = tokenUsageNotesForAgentRuns(input.agentRuns);

  return reviewReportSchema.parse({
    jobId: input.jobId,
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    baseSha: input.baseSha,
    headSha: input.headSha,
    summary: summaryForFinalFindings(input.summary, findings),
    score: input.score,
    riskLevel: input.riskLevel,
    riskBand: riskBandForFindings(findings),
    agentRuns: input.agentRuns,
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(tokenUsageNotes.length > 0 ? { tokenUsageNotes } : {}),
    findings,
    ...(duplicates.length > 0 ? { duplicates } : {}),
    retrieval: input.retrieval,
    createdAt: input.createdAt ?? new Date().toISOString()
  });
}
