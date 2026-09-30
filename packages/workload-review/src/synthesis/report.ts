/**
 * Report building — ported from the legacy runtime (parity, including
 * schema validation), plus deterministic cross-agent deduplication and the
 * findings-derived verdict band.
 */

import {
  reviewReportSchema,
  riskBandForFindings,
  type AgentRun,
  type RetrievalTrace,
  type ReviewCoverage,
  type ReviewFinding,
  type ReviewReport,
  type RiskLevel
} from "@consistency/schema";

const severityRank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 } as const;
const confidenceRank = { confirmed: 3, likely: 2, hypothesis: 1 } as const;

function findingKey(finding: ReviewFinding): string {
  return [finding.file.toLowerCase(), finding.title.toLowerCase()].join(":");
}

/** Normalize a title into a comparable Unicode token set. */
function titleWords(title: string): Set<string> {
  const normalized = title.normalize("NFKC").toLocaleLowerCase();
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (locales?: string | string[], options?: { granularity?: "word" }) => {
      segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>;
    };
  }).Segmenter;

  if (Segmenter) {
    const segmenter = new Segmenter("zh", { granularity: "word" });
    const segmented = [...segmenter.segment(normalized)]
      .filter(token => token.isWordLike !== false)
      .map(token => token.segment)
      .filter(Boolean);
    if (segmented.length > 0) return new Set(segmented);
  }

  // Older runtimes have no Segmenter; keep a deterministic Unicode fallback.
  const tokens = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu);
  return new Set(tokens ?? []);
}

/** Jaccard similarity between two titles' word sets. */
function titleSimilarity(left: string, right: string): number {
  const a = titleWords(left);
  const b = titleWords(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Same file + exact or near-identical title (word-set Jaccard ≥ 0.6). */
function isNearDuplicate(left: ReviewFinding, right: ReviewFinding): boolean {
  if (left.file.toLowerCase() !== right.file.toLowerCase()) return false;
  if (findingKey(left) === findingKey(right)) return true;
  return titleSimilarity(left.title, right.title) >= 0.6;
}

/** Findings on one file whose line ranges are at most this far apart are the same issue. */
export const FINDING_CLUSTER_DISTANCE = 3;

function lineRangeOf(finding: ReviewFinding): { start: number; end: number } | undefined {
  const { startLine, endLine } = finding;
  if (startLine === undefined || endLine === undefined) return undefined;
  return { start: Math.min(startLine, endLine), end: Math.max(startLine, endLine) };
}

/**
 * Same file with overlapping line ranges, or ranges at most
 * `FINDING_CLUSTER_DISTANCE` lines apart. A finding without line numbers
 * cannot be placed, so it falls through to the title comparison instead.
 */
function isLineNeighbor(left: ReviewFinding, right: ReviewFinding): boolean {
  if (left.file.toLowerCase() !== right.file.toLowerCase()) return false;
  const a = lineRangeOf(left);
  const b = lineRangeOf(right);
  if (a === undefined || b === undefined) return false;
  return a.start <= b.end + FINDING_CLUSTER_DISTANCE && b.start <= a.end + FINDING_CLUSTER_DISTANCE;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "and", "or", "not", "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "as", "if",
  "when", "then", "will", "can", "could", "may", "should", "must", "does", "do",
  "new", "changed", "change", "file", "files", "line", "lines", "code", "hunk",
  "security", "correctness", "maintainability", "test", "style", "evidence"
]);

/** Strip source artifacts before comparing prose; shared paths are not a topic. */
function topicWords(text: string): Set<string> {
  const prose = text
    .replace(/```[\s\S]*?```|`[^`]*`/g, " ")
    .replace(/(?:[\w.-]+[\\/])+[\w.-]+|\b[\w.-]+\.(?:py|ts|tsx|js|json|yml|yaml|sh)\b/gi, " ")
    .replace(/\b\w*[a-z][A-Z]\w*\b|\b\w+_\w+\b|\b\w+(?:\.\w+)+\b/g, " ");
  return new Set([...titleWords(prose)].filter(word => !STOP_WORDS.has(word) && !/^\d+$/.test(word) && word.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter(word => b.has(word)).length;
  return intersection / (a.size + b.size - intersection);
}

function differentTriggers(left: ReviewFinding, right: ReviewFinding): boolean {
  if (!left.trigger || !right.trigger) return false;
  const a = topicWords(left.trigger);
  const b = topicWords(right.trigger);
  return a.size >= 3 && b.size >= 3 && jaccard(a, b) < 0.2;
}

/** Explicit rule/category tags or at least 50% overlap of title/description keywords. */
function hasTopicOverlap(left: ReviewFinding, right: ReviewFinding): boolean {
  const categories = new Set((left.tags ?? []).filter(tag => /^(?:rule(?:id)?|category):\S+/i.test(tag)).map(tag => tag.toLowerCase()));
  if ((right.tags ?? []).some(tag => categories.has(tag.toLowerCase()))) return true;
  return jaccard(topicWords(`${left.title} ${left.evidence}`), topicWords(`${right.title} ${right.evidence}`)) >= 0.5;
}

/**
 * Same file with overlapping line ranges, or ranges at most
 * `FINDING_CLUSTER_DISTANCE` lines apart, AND topic similarity.
 */
function isLineAndTopicNeighbor(left: ReviewFinding, right: ReviewFinding): boolean {
  if (!isLineNeighbor(left, right)) return false;
  return hasTopicOverlap(left, right);
}

/**
 * True when the pair is joined by line proximity and topic similarity,
 * while wording is different enough that the title rule alone would not merge them.
 */
function joinsByLineProximity(left: ReviewFinding, right: ReviewFinding): boolean {
  return !isNearDuplicate(left, right) && isLineAndTopicNeighbor(left, right);
}

function belongsTogether(seed: ReviewFinding, finding: ReviewFinding): boolean {
  if (differentTriggers(seed, finding) || !hasTopicOverlap(seed, finding)) return false;
  return isNearDuplicate(seed, finding) || isLineNeighbor(seed, finding);
}

/**
 * Deterministic "most concrete evidence" measure, used below severity.
 * Length is the only portable proxy for specificity across providers: a
 * finding that pins the failing input or scenario at a concrete line says
 * more than one that restates the category.
 */
function evidenceSpecificity(finding: ReviewFinding): number {
  return (finding.evidence.length + finding.reasoning.length) * 10
    + (finding.evidenceIds?.length ?? 0)
    + (lineRangeOf(finding) === undefined ? 0 : 1);
}

function prefer(left: ReviewFinding, right: ReviewFinding): ReviewFinding {
  const score =
    severityRank[left.severity] - severityRank[right.severity]
    || evidenceSpecificity(left) - evidenceSpecificity(right)
    || confidenceRank[left.confidence] - confidenceRank[right.confidence];
  if (score !== 0) return score > 0 ? left : right;
  return left.id.localeCompare(right.id) <= 0 ? left : right;
}

/**
 * Deterministic cross-agent deduplication.
 *
 * Two findings on the same file collapse when their titles match closely
 * (legacy rule, wording-agnostic for Chinese) OR when their line ranges
 * overlap or sit within `FINDING_CLUSTER_DISTANCE` lines of each other. The
 * survivor is the highest-severity, then most-specific, then highest-
 * confidence one; the specialists it stands in for are recorded in
 * `alsoReportedBy`, and every merged finding is still returned in `duplicates`
 * so the report can disclose the merge instead of silently dropping it.
 */
export function deduplicateAndSortFindings(findings: ReviewFinding[], discloseAllMerges = false): {
  findings: ReviewFinding[];
  duplicates: ReviewFinding[];
} {
  const clusters: Array<{
    seed: ReviewFinding;
    survivor: ReviewFinding;
    merged: ReviewFinding[];
    members: ReviewFinding[];
    /** True once a member joined through line proximity rather than wording. */
    lineGrouped: boolean;
  }> = [];

  for (const finding of findings) {
    // Non-transitive clustering centered on the cluster's seed finding.
    const host = clusters.find(entry => belongsTogether(entry.seed, finding));
    if (!host) {
      clusters.push({ seed: finding, survivor: finding, merged: [], members: [finding], lineGrouped: false });
      continue;
    }
    if (joinsByLineProximity(host.seed, finding)) host.lineGrouped = true;
    host.members.push(finding);
    if (prefer(finding, host.survivor) === finding) {
      host.merged.push(host.survivor);
      host.survivor = finding;
    } else {
      host.merged.push(finding);
    }
  }

  const survivorOf = (entry: (typeof clusters)[number]): ReviewFinding => {
    let result = entry.survivor;
    if (entry.lineGrouped || (discloseAllMerges && entry.merged.length > 0)) {
      const alsoReportedBy = [...new Set(entry.members.flatMap(member => [member.agent, ...(member.alsoReportedBy ?? [])]))]
        .filter(agent => agent !== entry.survivor.agent)
        .sort();
      if (alsoReportedBy.length > 0) {
        result = { ...result, alsoReportedBy };
      }
      if (entry.merged.length > 0) {
        const mergedFindings = [
          ...(result.mergedFindings ?? []),
          ...entry.merged.flatMap(m => [{
            agent: m.agent,
            title: m.title,
            summary: (m.evidence || m.reasoning || m.recommendation || m.title).replace(/\s+/g, " ").trim().slice(0, 300)
          }, ...(m.mergedFindings ?? [])])
        ];
        result = { ...result, mergedFindings };
      }
    }
    return result;
  };

  const kept = clusters.map(survivorOf).sort((left, right) =>
    severityRank[right.severity] - severityRank[left.severity]
    || confidenceRank[right.confidence] - confidenceRank[left.confidence]
    || left.file.localeCompare(right.file)
    || (left.startLine ?? 0) - (right.startLine ?? 0)
  );
  const duplicates = clusters.flatMap(entry => entry.merged).sort((left, right) =>
    severityRank[right.severity] - severityRank[left.severity]
    || left.file.localeCompare(right.file)
  );
  return { findings: kept, duplicates };
}

export function buildReviewReport(input: {
  jobId: string;
  repositoryFullName: string;
  pullRequestNumber?: number;
  baseSha: string;
  headSha: string;
  summary: string;
  llmProvider?: string;
  llmModel?: string;
  agentRuns: AgentRun[];
  findings: ReviewFinding[];
  preExistingIssues?: ReviewFinding[];
  /**
   * Already-computed merge disclosure. A caller that ran the dedup pass itself
   * (the synthesizer, which scores and filters afterwards) passes its
   * `duplicates` here so the disclosure survives this second pass.
   */
  duplicates?: ReviewFinding[];
  /** Findings withheld from the main list after scoring; count only. */
  filteredFindingCount?: number;
  filteredBreakdown?: {
    capPerSpecialist?: number;
    lowScore?: number;
    capTotal?: number;
    capPerFile?: number;
  };
  score: number;
  riskLevel: RiskLevel;
  staticRiskLabel?: string;
  coverage?: ReviewCoverage;
  retrieval?: RetrievalTrace;
  createdAt?: string;
}): ReviewReport {
  const deduplicated = deduplicateAndSortFindings(input.findings, true);
  const findings = deduplicated.findings;
  const duplicates = input.duplicates ?? deduplicated.duplicates;

  return reviewReportSchema.parse({
    jobId: input.jobId,
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    baseSha: input.baseSha,
    headSha: input.headSha,
    summary: input.summary,
    score: input.score,
    riskLevel: input.riskLevel,
    ...(input.staticRiskLabel ? { staticRiskLabel: input.staticRiskLabel } : {}),
    riskBand: riskBandForFindings(findings),
    llmProvider: input.llmProvider,
    llmModel: input.llmModel,
    agentRuns: input.agentRuns,
    findings,
    ...(input.preExistingIssues?.length ? { preExistingIssues: input.preExistingIssues } : {}),
    ...(input.filteredFindingCount ? { filteredFindingCount: input.filteredFindingCount } : {}),
    ...(input.filteredBreakdown ? { filteredBreakdown: input.filteredBreakdown } : {}),
    ruleVersion: "v2",
    ...(duplicates.length > 0 ? { duplicates } : {}),
    ...(input.coverage ? { coverage: input.coverage } : {}),
    retrieval: input.retrieval,
    createdAt: input.createdAt ?? new Date().toISOString()
  });
}
