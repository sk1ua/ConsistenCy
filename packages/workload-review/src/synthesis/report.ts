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

/**
 * True when the pair is joined ONLY by line proximity — wording is different
 * enough that the title rule would have left them apart.
 *
 * Grouping precedence is deliberate: an exact or near-identical title on the
 * same file still collapses exactly as it always did (and `duplicates` still
 * discloses it), while the line-range rule catches the case the title rule
 * cannot — one defect described in different words by different specialists.
 * `alsoReportedBy` is recorded on the survivor of a line-range grouping, where
 * the merge is otherwise invisible from the surviving text.
 */
function joinsByLineProximity(left: ReviewFinding, right: ReviewFinding): boolean {
  return !isNearDuplicate(left, right) && isLineNeighbor(left, right);
}

function belongsTogether(left: ReviewFinding, right: ReviewFinding): boolean {
  return isNearDuplicate(left, right) || isLineNeighbor(left, right);
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
export function deduplicateAndSortFindings(findings: ReviewFinding[]): {
  findings: ReviewFinding[];
  duplicates: ReviewFinding[];
} {
  const clusters: Array<{
    survivor: ReviewFinding;
    merged: ReviewFinding[];
    members: ReviewFinding[];
    /** True once a member joined through line proximity rather than wording. */
    lineGrouped: boolean;
  }> = [];

  for (const finding of findings) {
    // Compare against every member of a cluster, not only its current
    // survivor. This keeps near-duplicate grouping transitive when the
    // strongest finding has different wording from an earlier duplicate.
    const host = clusters.find(entry => entry.members.some(member => belongsTogether(member, finding)));
    if (!host) {
      clusters.push({ survivor: finding, merged: [], members: [finding], lineGrouped: false });
      continue;
    }
    if (host.members.some(member => joinsByLineProximity(member, finding))) host.lineGrouped = true;
    host.members.push(finding);
    if (prefer(finding, host.survivor) === finding) {
      host.merged.push(host.survivor);
      host.survivor = finding;
    } else {
      host.merged.push(finding);
    }
  }

  const survivorOf = (entry: (typeof clusters)[number]): ReviewFinding => {
    if (!entry.lineGrouped) return entry.survivor;
    const alsoReportedBy = [...new Set(entry.members.map(member => member.agent))]
      .filter(agent => agent !== entry.survivor.agent)
      .sort();
    return alsoReportedBy.length > 0 ? { ...entry.survivor, alsoReportedBy } : entry.survivor;
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
  score: number;
  riskLevel: RiskLevel;
  coverage?: ReviewCoverage;
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
    llmProvider: input.llmProvider,
    llmModel: input.llmModel,
    agentRuns: input.agentRuns,
    findings,
    ...(input.preExistingIssues?.length ? { preExistingIssues: input.preExistingIssues } : {}),
    ruleVersion: "v2",
    ...(duplicates.length > 0 ? { duplicates } : {}),
    ...(input.coverage ? { coverage: input.coverage } : {}),
    retrieval: input.retrieval,
    createdAt: input.createdAt ?? new Date().toISOString()
  });
}
