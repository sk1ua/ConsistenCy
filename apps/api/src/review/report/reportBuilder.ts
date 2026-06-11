import { riskLevelForScore, reviewReportSchema, type AgentRun, type ReviewFinding, type ReviewReport } from "@consistency/schema";

const severityRank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 } as const;
const confidenceRank = { confirmed: 3, likely: 2, hypothesis: 1 } as const;
const confirmedDeductions = { critical: 30, high: 20, medium: 10, low: 3, info: 0 } as const;

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

export function scoreFindings(findings: ReviewFinding[]): number {
  const deduction = findings.reduce((total, finding) => {
    const base = confirmedDeductions[finding.severity];
    if (finding.confidence === "confirmed") return total + base;
    if (finding.confidence === "likely") return total + Math.ceil(base / 2);
    return total;
  }, 0);
  return Math.max(0, 100 - deduction);
}

export function buildReviewReport(input: {
  jobId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  summary: string;
  agentRuns: AgentRun[];
  findings: ReviewFinding[];
  createdAt?: string;
}): ReviewReport {
  const findings = deduplicateAndSortFindings(input.findings);
  const score = scoreFindings(findings);
  return reviewReportSchema.parse({
    ...input,
    findings,
    score,
    riskLevel: riskLevelForScore(score),
    createdAt: input.createdAt ?? new Date().toISOString()
  });
}
