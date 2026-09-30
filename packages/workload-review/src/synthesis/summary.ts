import type { ReviewFinding } from "@consistency/schema";

// The summary/scoring call sees candidates BEFORE score floors and caps. Do
// not publish its count-bearing sentences (or counts from canonical compose).
// Keep unrelated numbers, such as timeouts and version requirements, intact.
const ENGLISH_COUNTS = /\b(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|no|a|an|both|multiple|several|many)\s+(?:(?:critical|high|medium|low)(?:[- ]severity)?\s+|(?:new|confirmed|likely|potential|unique|actionable|reported|review|security|serious|major|minor|main-list|appendix|pre-existing)\s+){0,4}(?:findings?|issues?|bugs?|defects?|problems?|vulnerabilit(?:y|ies)|risks?)\b|\b(?:findings?|issues?|bugs?|defects?|critical|high|medium|low)(?:\s+(?:findings?|severity))?\s*[:=]\s*\d+/i;
const CHINESE_COUNTS = /[0-9零〇一二两三四五六七八九十百千]+\s*(?:条|处|个|项)?\s*(?:(?:新增|可操作|已确认|严重|高危|高风险|中等|中危|低危|既有|基线|安全)\s*){0,3}(?:问题|发现|缺陷|漏洞|风险|意见)|(?:问题|发现|缺陷|漏洞|风险|意见|高危|中危|低危)\s*[:：=]\s*[0-9零〇一二两三四五六七八九十百千]+|(?:主列表|附录)\s*[:：=]?\s*\d+\s*条/u;

/** Counts are derived only from the arrays that will actually be persisted. */
export function summaryForFinalFindings(
  summary: string,
  findings: readonly ReviewFinding[],
  appendix: readonly ReviewFinding[] = [],
  language: "zh-CN" | "en-US" = "en-US",
): string {
  const prose = summary.split(/(?<=[.!?])\s+|(?<=[。！？])|\r?\n+/u)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence && !ENGLISH_COUNTS.test(sentence) && !CHINESE_COUNTS.test(sentence))
    .join(" ");
  const count = (severity: ReviewFinding["severity"]) => findings.filter(finding => finding.severity === severity).length;
  const counts = language === "zh-CN"
    ? `去重和过滤后：主列表 ${findings.length} 条（严重 ${count("critical")}、高 ${count("high")}、中 ${count("medium")}、低 ${count("low")}、信息 ${count("info")}），附录 ${appendix.length} 条。`
    : `After deduplication and filtering: ${findings.length} main-list ${findings.length === 1 ? "finding" : "findings"} (${count("critical")} critical, ${count("high")} high, ${count("medium")} medium, ${count("low")} low, ${count("info")} info); ${appendix.length} appendix ${appendix.length === 1 ? "issue" : "issues"}.`;
  return [prose, counts].filter(Boolean).join("\n\n");
}
