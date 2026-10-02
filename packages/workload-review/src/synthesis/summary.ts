import type { ReviewFinding } from "@consistency/schema";

/** Preserve source prose verbatim; only the deterministic footer owns counts. */
export function summaryForFinalFindings(
  summary: string,
  findings: readonly ReviewFinding[],
  appendix: readonly ReviewFinding[] = [],
  language: "zh-CN" | "en-US" = "en-US",
): string {
  const count = (severity: ReviewFinding["severity"]) => findings.filter(finding => finding.severity === severity).length;
  const counts = language === "zh-CN"
    ? `去重和过滤后：主列表 ${findings.length} 条（严重 ${count("critical")}、高 ${count("high")}、中 ${count("medium")}、低 ${count("low")}、信息 ${count("info")}），附录 ${appendix.length} 条。`
    : `After deduplication and filtering: ${findings.length} main-list ${findings.length === 1 ? "finding" : "findings"} (${count("critical")} critical, ${count("high")} high, ${count("medium")} medium, ${count("low")} low, ${count("info")} info); ${appendix.length} appendix ${appendix.length === 1 ? "issue" : "issues"}.`;
  // Repeating an identical finalization is idempotent without editing prose or
  // attempting to recognize arbitrary count-bearing model sentences.
  if (summary === counts || summary.endsWith(`\n\n${counts}`)) return summary;
  return summary ? `${summary}\n\n${counts}` : counts;
}
