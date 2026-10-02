/**
 * Terminal renderer for a finished review report.
 *
 * Design rule (deliberate, and the reason this module exists at all): what the
 * review could NOT check is more prominent than what it did check. A clean
 * "no findings" result from a degraded run must never be able to pass for a
 * clean result from a complete run, so constraints get their own always-present
 * block, a marker in the headline, and a footnote that redefines a bare `✓`.
 *
 * Two independent risk measures are rendered side by side and never merged:
 *   - `riskLevel` — deterministic static-analysis band (what an agent may not
 *     rewrite; it clears only when the risk is gone).
 *   - `riskBand`  — verdict band derived from the final findings' severities.
 * The schema explicitly warns that UIs must present these as distinct, named
 * fields (`packages/schema/src/report.ts:157-165`), so the renderer keeps them
 * apart instead of inventing a combined number.
 */

import { staticRiskDisplayLabel, tokenUsageNotesForAgentRuns, tokenUsageStatus, type ReviewReport, type Severity } from "@consistency/schema";
import { indent, oneLine, plural, type Palette } from "./terminal";

export type ConstraintCode =
  | "AGENT_FAILED"
  | "PLANNER_FAILED"
  | "SYNTHESIZER_FAILED"
  | "DETERMINISTIC_FAILED"
  | "EVIDENCE_UNRESOLVED"
  | "CAPABILITY_LEAK";

export type ConstraintEntry = {
  code: ConstraintCode;
  /** Human sentence, already free of colour and layout control. */
  message: string;
  /** What the reader can do about it; omitted when nothing actionable exists. */
  remedy?: string;
};

/**
 * Constraints that changed what was inspected (as opposed to what was found).
 * Only these earn the loud marker and the "no findings is not a pass"
 * footnote; a dangling evidence reference is reported but is not a coverage
 * loss, because the finding itself still exists.
 */
const COVERAGE_CODES: ReadonlySet<ConstraintCode> = new Set<ConstraintCode>([
  "AGENT_FAILED",
  "PLANNER_FAILED",
  "SYNTHESIZER_FAILED",
  "DETERMINISTIC_FAILED"
]);

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低",
  info: "提示"
};

/** Ascending rank: index 0 is the most urgent, used for stable ordering. */
const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "info"];
/** Triage default: `info` findings do not fail a build unless asked to. */
export const DEFAULT_THRESHOLD: Severity = "low";

export function severityRank(severity: Severity): number {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

export function isAtOrAbove(severity: Severity, threshold: Severity): boolean {
  return severityRank(severity) <= severityRank(threshold);
}

const CONFIDENCE_LABEL: Record<"confirmed" | "likely" | "hypothesis", string> = {
  confirmed: "已确认",
  likely: "很可能",
  hypothesis: "假设"
};

const CONFIDENCE_ORDER: Record<"confirmed" | "likely" | "hypothesis", number> = {
  confirmed: 0,
  likely: 1,
  hypothesis: 2
};

const RISK_LABEL: Record<string, string> = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低",
  none: "无",
  no_baseline: "无基线 (No Baseline)",
  skipped: "已跳过 (Skipped)"
};

export function riskBandLabel(band: string | undefined): string {
  return band === undefined ? "未记录" : RISK_LABEL[band] ?? band;
}

export function riskLevelLabel(level: string, staticLabel?: string): string {
  if (staticLabel) return staticRiskDisplayLabel(level, staticLabel);
  const noBaseline = level === "no_baseline";
  const skipped = level === "skipped";
  if (noBaseline && skipped) return "无基线 (No Baseline) / 已跳过基线比对 (Skipped)";
  if (noBaseline) return "无基线 (No Baseline)";
  if (skipped) return "已跳过基线比对 (Skipped)";
  return RISK_LABEL[level] ?? level;
}

/** Constraints that degraded the run; drives the marker, footnote and exit code. */
export function coverageConstraints(constraints: readonly ConstraintEntry[]): ConstraintEntry[] {
  return constraints.filter(entry => COVERAGE_CODES.has(entry.code));
}

/**
 * Collects every reason this report is narrower than a full review. Ordering is
 * stable (coverage first, then dangling references) so two runs of the same
 * input always print the same block.
 */
export function collectConstraints(report: ReviewReport): ConstraintEntry[] {
  const entries: ConstraintEntry[] = [];
  const coverage = report.coverage;

  if (coverage) {
    if (coverage.failedAgents.length > 0) {
      entries.push({
        code: "AGENT_FAILED",
        message: `${plural(coverage.failedAgents.length, "个专项审查 agent")}执行失败，未参与本报告：${coverage.failedAgents.join("、")}`,
        remedy: "重跑该仓库的审查；失败通常来自 provider 超时或预算耗尽"
      });
    }
    if (coverage.plannerFailed) {
      entries.push({
        code: "PLANNER_FAILED",
        message: "Planner 失败：本次没有按风险分配专项 agent 的审查计划",
        remedy: "关注 coverage 是否降级，必要时缩小变更范围后重跑"
      });
    }
    if (coverage.synthesizerFailed) {
      entries.push({
        code: "SYNTHESIZER_FAILED",
        message: "Synthesizer 失败：结论未经跨 agent 综合研判，findings 为各 agent 原始输出",
        remedy: "把本次 findings 当作候选而非定论；重跑可获得综合结论"
      });
    }
    if (coverage.deterministicFailed === true) {
      entries.push({
        code: "DETERMINISTIC_FAILED",
        message: "确定性分析工作流有失败或跳过的步骤：静态分析证据不完整",
        remedy: "检查 Python 引擎是否可用；部分证据缺失会削弱 findings 的 grounding"
      });
    }
  }

  // Findings survive the run even when their evidence records were never
  // persisted, so a dangling reference is a provenance gap, not a missing
  // finding. Reported without the coverage marker.
  const known = new Set((report.evidence ?? []).map(record => record.id));
  const dangling = new Set<string>();
  for (const finding of report.findings) {
    for (const id of finding.evidenceIds ?? []) {
      if (!known.has(id)) dangling.add(id);
    }
  }
  if (dangling.size > 0) {
    entries.push({
      code: "EVIDENCE_UNRESOLVED",
      message: `${plural(dangling.size, "条证据引用")}在本报告中无法解析（证据记录未持久化）：${[...dangling].slice(0, 3).join("、")}${dangling.size > 3 ? " 等" : ""}`,
      remedy: "这些引用是真实记录，不是伪造；但不能用于回溯原始证据内容"
    });
  }

  return entries;
}

/** Capability hygiene diagnostics attached by the runtime, when present. */
export function capabilityConstraints(result: {
  capabilitiesIssued?: number;
  capabilitiesRevoked?: number;
}): ConstraintEntry[] {
  const issued = result.capabilitiesIssued;
  const revoked = result.capabilitiesRevoked;
  if (typeof issued !== "number" || typeof revoked !== "number") return [];
  if (issued <= revoked) return [];
  return [
    {
      code: "CAPABILITY_LEAK",
      message: `本次运行签发了 ${issued} 个能力句柄，终态仅回收 ${revoked} 个`,
      remedy: "这是内核级诊断信号，请连同 runId 一起上报"
    }
  ];
}

export type RenderOptions = {
  palette: Palette;
  /** Emit reasoning, recommendation, evidence ids and the evidence block. */
  verbose?: boolean;
  /** Cap on findings printed; the remainder are counted. */
  limit?: number;
  /** `false` drops the run header; used when several reports are concatenated. */
  header?: boolean;
};

/**
 * "✓ 3 个文件已完整分析，发现 1 项" vs the same counts with `[!]`.
 *
 * The identical numbers are deliberately paired with different markers so the
 * degraded case cannot be skim-read as a clean run.
 */
function headline(report: ReviewReport, constraints: readonly ConstraintEntry[], palette: Palette): string {
  const files = new Set<string>();
  for (const finding of report.findings) files.add(finding.file);

  const clean = coverageConstraints(constraints).length === 0;
  const token = clean ? palette.green("✓") : palette.yellow("[!]");
  const parts: string[] = [];
  parts.push(`${plural(files.size, "个文件")}已${clean ? "完整" : "部分"}分析`);
  parts.push(`发现 ${report.findings.length} 项`);
  if (report.duplicates && report.duplicates.length > 0) {
    parts.push(palette.dim(`（另有 ${report.duplicates.length} 项跨 agent 去重合并）`));
  }
  return `${token} ${parts.join("，")}`;
}

/** Compact `!1 ~2` marker for the top border, derived from real constraint codes. */
function constraintMarker(constraints: readonly ConstraintEntry[], palette: Palette): string {
  if (constraints.length === 0) return "";
  const loud = coverageConstraints(constraints).length;
  const quiet = constraints.length - loud;
  const segments: string[] = [];
  if (loud > 0) segments.push(palette.yellow(`!${loud}`));
  if (quiet > 0) segments.push(palette.dim(`~${quiet}`));
  return `  ${segments.join(" ")}`;
}

function renderFinding(
  finding: ReviewReport["findings"][number],
  palette: Palette,
  verbose: boolean
): string[] {
  const location = finding.startLine !== undefined && finding.endLine !== undefined
    ? `${finding.file}:${finding.startLine}-${finding.endLine}`
    : finding.file;
  const facts = [CONFIDENCE_LABEL[finding.confidence], finding.agent];
  if (finding.score !== undefined) {
    facts.push(`评分 ${finding.score}/10`);
  }
  if (finding.alsoReportedBy && finding.alsoReportedBy.length > 0) {
    facts.push(`同报: ${finding.alsoReportedBy.join(", ")}`);
  }
  if (finding.evidenceIds && finding.evidenceIds.length > 0) {
    facts.push(`${finding.evidenceIds.length} 条证据`);
  }
  const token = finding.severity === "critical" || finding.severity === "high"
    ? palette.red(`[${SEVERITY_LABEL[finding.severity]}]`)
    : finding.severity === "medium"
      ? palette.yellow(`[${SEVERITY_LABEL[finding.severity]}]`)
      : palette.dim(`[${SEVERITY_LABEL[finding.severity]}]`);

  const lines: string[] = [];
  lines.push(`${token} ${finding.title}`);
  lines.push(palette.dim(`    └ ${location} · ${facts.join(" · ")}`));
  if (finding.trigger) {
    lines.push(palette.dim(`      触发场景: ${oneLine(finding.trigger)}`));
  }
  if (verbose) {
    lines.push("");
    lines.push(indent(palette.dim("证据  ") + oneLine(finding.evidence), "    "));
    lines.push(indent(palette.dim("研判  ") + oneLine(finding.reasoning), "    "));
    lines.push(indent(palette.dim("建议  ") + oneLine(finding.recommendation), "    "));
    if (finding.confidence === "hypothesis") {
      lines.push(indent(palette.dim("不确定  ") + oneLine(finding.uncertainty), "    "));
    }
    if (finding.evidenceIds && finding.evidenceIds.length > 0) {
      lines.push(indent(palette.dim("证据 id  ") + finding.evidenceIds.join(", "), "    "));
    }
  }
  return lines;
}

function renderFindings(report: ReviewReport, options: RenderOptions): string[] {
  const { palette, verbose = false, limit } = options;
  const lines: string[] = [];
  lines.push("");

  if (report.findings.length === 0) {
    lines.push(palette.dim("  （无 findings）"));
    return lines;
  }

  const ordered = [...report.findings].sort((left, right) => {
    const bySeverity = severityRank(left.severity) - severityRank(right.severity);
    if (bySeverity !== 0) return bySeverity;
    const byConfidence = CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence];
    if (byConfidence !== 0) return byConfidence;
    return left.file.localeCompare(right.file);
  });

  const cap = limit ?? ordered.length;
  for (const finding of ordered.slice(0, cap)) {
    lines.push(...renderFinding(finding, palette, verbose));
  }
  if (ordered.length > cap) {
    lines.push(palette.dim(`  … 另有 ${ordered.length - cap} 项，使用 --all 查看`));
  }
  return lines;
}

function renderEvidence(report: ReviewReport, palette: Palette): string[] {
  const records = report.evidence ?? [];
  if (records.length === 0) return [];
  const bySource = new Map<string, number>();
  for (const record of records) {
    bySource.set(record.source, (bySource.get(record.source) ?? 0) + 1);
  }
  const summary = [...bySource.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([source, count]) => `${source} ${count}`)
    .join(" · ");
  const lines: string[] = [];
  lines.push("");
  lines.push(palette.bold("证据") + palette.dim(`  ${plural(records.length, "条")}记录`));
  lines.push(`  ${summary}`);
  const analyzers = new Set(records.map(record => `${record.provenance.analyzer}@${record.provenance.analyzerVersion}`));
  if (analyzers.size > 0) {
    lines.push(palette.dim(`  来源 ${[...analyzers].join("、")}`));
  }
  return lines;
}

function renderConstraints(report: ReviewReport, constraints: readonly ConstraintEntry[], palette: Palette): string[] {
  const lines: string[] = [];
  lines.push("");
  if (constraints.length === 0) {
    // "No constraints recorded" is not the same claim as "coverage was
    // complete". A report without a coverage block carries no evidence either
    // way, so it must not earn the green checkmark the reader is meant to trust.
    lines.push(
      report.coverage
        ? palette.green("✓ 本次审查覆盖完整") + palette.dim("  （所有已启用的分析均已执行）")
        : palette.dim("· 本次审查未记录覆盖范围（coverage 缺失，无法确认哪些分析实际执行过）")
    );
    return lines;
  }
  const loud = coverageConstraints(constraints).length;
  lines.push(
    palette.bold("本次审查未能覆盖") +
    palette.dim(`  ${plural(constraints.length, "项约束")}${loud > 0 ? `，其中 ${loud} 项影响覆盖范围` : ""}`)
  );
  for (const entry of constraints) {
    const bold = COVERAGE_CODES.has(entry.code);
    const token = bold ? palette.yellow("[!]") : palette.dim("[~]");
    lines.push(`  ${token} ${entry.message}`);
    if (entry.remedy) lines.push(indent(palette.dim(entry.remedy), "      "));
  }
  if (loud > 0) {
    lines.push("");
    lines.push(palette.yellow("  [!] = 该部分本次未检查，不代表已检查且通过。[~] = 已检查，但证据链不完整。"));
  }
  return lines;
}

function renderAgents(report: ReviewReport, palette: Palette): string[] {
  if (report.agentRuns.length === 0) return [];
  const lines: string[] = [];
  lines.push("");
  lines.push(palette.bold("agent 执行"));
  for (const run of report.agentRuns) {
    const token = run.status === "succeeded"
      ? palette.green("✓")
      : run.status === "failed"
        ? palette.red("✗")
        : run.status === "running"
          ? palette.yellow("…")
          : palette.dim("–");
    const facts: string[] = [`${run.findings.length} 项`];
    if (run.tokenUsage?.totalTokens !== undefined) facts.push(`${run.tokenUsage.totalTokens} tokens`);
    if ((run.status === "succeeded" || run.status === "failed") && run.agentName !== "DeterministicAnalyzer") {
      const cached = run.tokenUsage?.cachedTokens;
      facts.push(cached === undefined ? "cached tokens: unknown（未报告）" : cached > 0 ? `${cached} cached tokens` : "0 cached tokens (未报告或未命中)");
      const usageStatus = tokenUsageStatus(run.tokenUsage);
      if (usageStatus !== "reported") facts.push(`token usage: ${usageStatus}`);
    }
    if (run.provider) facts.push(run.model ? `${run.provider}/${run.model}` : run.provider);
    lines.push(`  ${token} ${run.agentName}${palette.dim(`  ${facts.join(" · ")}`)}`);
    if (run.status === "failed" && run.error) {
      lines.push(indent(palette.dim(oneLine(run.error)), "      "));
    }
  }
  for (const note of report.tokenUsageNotes ?? tokenUsageNotesForAgentRuns(report.agentRuns, "zh-CN")) {
    lines.push(indent(palette.dim(note), "  "));
  }
  return lines;
}

function renderFooter(report: ReviewReport, palette: Palette): string[] {
  const lines: string[] = [];
  lines.push("");
  const facts: string[] = [];
  facts.push(`job ${report.jobId}`);
  facts.push(`${report.baseSha.slice(0, 7)} → ${report.headSha.slice(0, 7)}`);
  if (report.pullRequestNumber !== undefined) facts.push(`PR #${report.pullRequestNumber}`);
  if (report.llmProvider) facts.push(report.llmModel ? `${report.llmProvider}/${report.llmModel}` : report.llmProvider);
  if (report.ruleVersion) facts.push(`规则 ${report.ruleVersion}`);
  lines.push(palette.dim(`  ${facts.join(" · ")}`));
  return lines;
}

/**
 * Renders one finished report. The header carries both risk measures explicitly
 * named, and the constraint block is always present — an empty block is a
 * positive statement about coverage, not an absent section.
 */
export function renderReport(report: ReviewReport, options: RenderOptions): string {
  const { palette, header = true } = options;
  const constraints = collectConstraints(report);
  const lines: string[] = [];

  const riskLine =
    `  ${palette.bold(String(report.score).padStart(3, " "))} 静态分析评分 · 风险 ${riskLevelLabel(report.riskLevel, report.staticRiskLabel)}` +
    `    结论风险带 ${riskBandLabel(report.riskBand)}`;
  if (header) {
    const width = 64;
    lines.push(palette.dim("─".repeat(width)));
    lines.push(
      `${palette.bold("审查报告")}${palette.dim(`  ${report.repositoryFullName}`)}${constraintMarker(constraints, palette)}`
    );
    lines.push(palette.dim("─".repeat(width)));
    lines.push("");
    lines.push(riskLine);
    lines.push(palette.dim("      （两者独立：评分来自确定性静态分析，风险带来自最终 findings 的严重度分布）"));
    lines.push("");
    lines.push(headline(report, constraints, palette));
  } else {
    lines.push(riskLine);
    lines.push(headline(report, constraints, palette));
  }

  lines.push(...renderFindings(report, options));
  if (report.filteredFindingCount) {
    lines.push(palette.dim(
      `  （另有 ${report.filteredFindingCount} 条发现评分不足或超出条数上限，已过滤，不在此展示）`
    ));
  }
  if (options.verbose) lines.push(...renderEvidence(report, palette));
  lines.push(...renderConstraints(report, constraints, palette));
  lines.push(...renderAgents(report, palette));
  lines.push(...renderFooter(report, palette));
  if (report.preExistingIssues?.length) {
    lines.push("", palette.bold(`Pre-existing issues (${report.preExistingIssues.length})`));
    for (const finding of report.preExistingIssues) {
      lines.push(palette.dim(`  ${finding.file}:${finding.startLine ?? "?"} ${oneLine(finding.title)}`));
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Exit-code contract, kept in one place so the CLI and its tests cannot drift:
 *   0 — ran and nothing met the threshold
 *   1 — ran and the threshold was met (findings-first signal, safe for CI)
 *   2 — did not run, or coverage was lost (the run cannot be trusted as a gate)
 */
export function exitCodeFor(
  report: ReviewReport,
  constraints: readonly ConstraintEntry[],
  threshold: Severity
): 0 | 1 | 2 {
  if (coverageConstraints(constraints).length > 0) return 2;
  const blocking = report.findings.some(finding => isAtOrAbove(finding.severity, threshold));
  return blocking ? 1 : 0;
}
