import {
  reviewReportSchema,
  type AgentRun,
  type RetrievalTrace,
  type ReviewFinding,
  type ReviewReport,
  type RiskLevel
} from "@consistency/schema";

const severityRank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 } as const;
const confidenceRank = { confirmed: 3, likely: 2, hypothesis: 1 } as const;

function findingKey(finding: ReviewFinding): string {
  return [finding.file.toLowerCase(), finding.title.toLowerCase()].join(":");
}

export function deduplicateAndSortFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const deduplicated = new Map<string, ReviewFinding>();
  for (const finding of findings) {
    const key = findingKey(finding);
    const existing = deduplicated.get(key);
    if (!existing || confidenceRank[finding.confidence] > confidenceRank[existing.confidence]) {
      deduplicated.set(key, finding);
    }
  }
  return [...deduplicated.values()].sort((left, right) =>
    severityRank[right.severity] - severityRank[left.severity]
    || confidenceRank[right.confidence] - confidenceRank[left.confidence]
    || left.file.localeCompare(right.file)
    || (left.startLine ?? 0) - (right.startLine ?? 0)
  );
}

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
  const findings = deduplicateAndSortFindings(input.findings);

  return reviewReportSchema.parse({
    jobId: input.jobId,
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    baseSha: input.baseSha,
    headSha: input.headSha,
    summary: input.summary,
    score: input.score,
    riskLevel: input.riskLevel,
    agentRuns: input.agentRuns,
    findings,
    retrieval: input.retrieval,
    createdAt: input.createdAt ?? new Date().toISOString()
  });
}
