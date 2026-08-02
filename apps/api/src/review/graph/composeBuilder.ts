import type { DomainFileResult, ReviewFinding, WireComposeReviewFile } from "@consistency/schema";

export function buildComposeReviewFileResults(
  deterministicFiles: DomainFileResult[],
  llmFindings: ReviewFinding[],
  options: {
    maxFindingsTotal?: number;
    maxFindingChars?: number;
  } = {}
): WireComposeReviewFile[] {
  const maxFindingsTotal = options.maxFindingsTotal ?? 20;
  const maxFindingChars = options.maxFindingChars ?? 500;

  // Group LLM findings by file path (preserving original order)
  const llmByFile = new Map<string, string[]>();
  for (const finding of llmFindings) {
    const summary = `${finding.agent} [${finding.severity}/${finding.confidence}]: ${finding.title} - ${finding.reasoning}`.slice(0, maxFindingChars);
    const existing = llmByFile.get(finding.file) ?? [];
    existing.push(summary);
    llmByFile.set(finding.file, existing);
  }

  let totalFindingsCount = 0;
  const fileResults: WireComposeReviewFile[] = [];

  for (const file of deterministicFiles) {
    const staticFindings = file.findings.map((f) => f.slice(0, maxFindingChars));
    const llmList = llmByFile.get(file.path) ?? [];
    const combined = [...staticFindings, ...llmList];

    const remainingQuota = Math.max(0, maxFindingsTotal - totalFindingsCount);
    const selectedFindings = combined.slice(0, remainingQuota);
    totalFindingsCount += selectedFindings.length;

    fileResults.push({
      path: file.path,
      risk_score: file.riskScore,
      findings: selectedFindings
    });
  }

  return fileResults;
}
