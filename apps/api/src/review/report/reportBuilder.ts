import { deduplicateAndSortFindings, riskBandForFindings } from "@consistency/workload-review";
import {
  reviewReportSchema,
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
  const { findings, duplicates } = deduplicateAndSortFindings(input.findings);

  return reviewReportSchema.parse({
    jobId: input.jobId,
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    baseSha: input.baseSha,
    headSha: input.headSha,
    summary: input.summary,
    score: input.score,
    riskLevel: input.riskLevel,
    riskBand: riskBandForFindings(findings),
    agentRuns: input.agentRuns,
    findings,
    ...(duplicates.length > 0 ? { duplicates } : {}),
    retrieval: input.retrieval,
    createdAt: input.createdAt ?? new Date().toISOString()
  });
}
