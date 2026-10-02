import type { ReviewFinding } from "@consistency/schema";

// Rewrite just the count expression, never its containing sentence: that
// sentence can also explain the regression or carry a critical recommendation.
const ENGLISH_COUNTS = /\b(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|no|both|multiple|several|many)\s+((?:(?:critical|high|medium|low|info)(?:[- ]severity)?\s+|(?:new|confirmed|likely|potential|unique|actionable|reported|review|security|serious|major|minor|main-list|appendix|pre-existing)\s+){0,4})(findings?|issues?|bugs?|defects?|problems?|vulnerabilit(?:y|ies)|risks?)\b/gi;
const ENGLISH_LABEL_COUNTS = /\b((?:findings?|issues?|bugs?|defects?|critical|high|medium|low|info)(?:\s+(?:findings?|severity))?\s*[:=]\s*)\d+/gi;
const CHINESE_COUNTS = /[0-9零〇一二两三四五六七八九十百千]+\s*((?:条|处|个|项)?\s*)((?:(?:新增|可操作|已确认|严重|高危|高风险|中等|中危|低危|既有|基线|安全)\s*){0,3})(问题|发现|缺陷|漏洞|风险|意见)/gu;
const CHINESE_LABEL_COUNTS = /((?:问题|发现|缺陷|漏洞|风险|意见|严重|高危|中危|低危)\s*[:：=]\s*|(?:主列表|附录)\s*[:：=]?\s*)[0-9零〇一二两三四五六七八九十百千]+/gu;

// Only our own complete generated footer may be removed on a second pass.
const GENERATED_COUNTS = /After deduplication and filtering: \d+ main-list findings? \(\d+ critical, \d+ high, \d+ medium, \d+ low, \d+ info\); \d+ appendix issues?\.|去重和过滤后：主列表 \d+ 条（严重 \d+、高 \d+、中 \d+、低 \d+、信息 \d+），附录 \d+ 条。/gu;

const singularNoun: Record<string, string> = {
  finding: "finding", findings: "finding", issue: "issue", issues: "issue", bug: "bug", bugs: "bug",
  defect: "defect", defects: "defect", problem: "problem", problems: "problem",
  vulnerability: "vulnerability", vulnerabilities: "vulnerability", risk: "risk", risks: "risk",
};

function proseLanguage(prose: string, fallback: "zh-CN" | "en-US"): "zh-CN" | "en-US" {
  const chinese = prose.match(/\p{Script=Han}/gu)?.length ?? 0;
  const english = prose.match(/[a-z]+/gi)?.length ?? 0;
  if (chinese === 0 && english === 0) return fallback;
  return chinese > english ? "zh-CN" : "en-US";
}

/** Counts are derived only from the arrays that will actually be persisted. */
export function summaryForFinalFindings(
  summary: string,
  findings: readonly ReviewFinding[],
  appendix: readonly ReviewFinding[] = [],
  language: "zh-CN" | "en-US" = "en-US",
): string {
  const count = (severity: ReviewFinding["severity"]) => findings.filter(finding => finding.severity === severity).length;
  const numberFor = (description: string): number => {
    if (/\b(?:appendix|pre-existing)\b|附录|既有|基线/i.test(description)) return appendix.length;
    if (/\bcritical\b|严重/i.test(description)) return count("critical");
    if (/\bhigh\b|高危|高风险/i.test(description)) return count("high");
    if (/\bmedium\b|中等|中危/i.test(description)) return count("medium");
    if (/\blow\b|低危/i.test(description)) return count("low");
    if (/\binfo\b|信息/i.test(description)) return count("info");
    return findings.length;
  };
  const source = summary.replace(GENERATED_COUNTS, "").trim();
  const actualLanguage = proseLanguage(source, language);
  const prose = source
    .replace(ENGLISH_COUNTS, (_match, modifiers: string, noun: string) => {
      const total = numberFor(modifiers);
      const singular = singularNoun[noun.toLowerCase()]!;
      const label = total === 1 ? singular : singular === "vulnerability" ? "vulnerabilities" : `${singular}s`;
      return `${total} ${modifiers}${label}`;
    })
    .replace(ENGLISH_LABEL_COUNTS, (_match, label: string) => `${label}${numberFor(label)}`)
    .replace(CHINESE_COUNTS, (_match, unit: string, modifiers: string, noun: string) => `${numberFor(modifiers)}${unit}${modifiers}${noun}`)
    .replace(CHINESE_LABEL_COUNTS, (_match, label: string) => `${label}${numberFor(label)}`);
  const counts = actualLanguage === "zh-CN"
    ? `去重和过滤后：主列表 ${findings.length} 条（严重 ${count("critical")}、高 ${count("high")}、中 ${count("medium")}、低 ${count("low")}、信息 ${count("info")}），附录 ${appendix.length} 条。`
    : `After deduplication and filtering: ${findings.length} main-list ${findings.length === 1 ? "finding" : "findings"} (${count("critical")} critical, ${count("high")} high, ${count("medium")} medium, ${count("low")} low, ${count("info")} info); ${appendix.length} appendix ${appendix.length === 1 ? "issue" : "issues"}.`;
  return [prose, counts].filter(Boolean).join("\n\n");
}
