/**
 * Post-deduplication finding scoring and filtering (review-noise step 4).
 *
 * The synthesizer already makes exactly ONE model call per review — the report
 * summary. Scoring rides that call: the same response carries a 0–10 score and
 * a one-sentence reason per finding, so no second request is issued.
 *
 * Everything here is pure and deterministic, so the filter is unit tested
 * without a provider.
 */

import type { FindingScore, ReviewFinding } from "@consistency/schema";

/** Findings scoring below this are withheld from the main list. */
export const DEFAULT_MIN_FINDING_SCORE = 5;
/** Maximum findings in the main list, after scoring. */
export const DEFAULT_MAX_REPORTED_FINDINGS = 8;
/** Maximum findings in the main list from any single file. */
export const DEFAULT_MAX_FINDINGS_PER_FILE = 3;

/**
 * The rubric handed to the synthesizer. Kept next to the filter that enforces
 * it so the instruction and the thresholds cannot drift apart.
 */
export const FINDING_SCORE_INSTRUCTION = [
  "For every supplied finding, set an integer \"score\" from 0 to 10 and a one-sentence \"scoreReason\".",
  "8-10: the finding names a concrete input or scenario that fails in code this change introduced.",
  "3-7: the failure is plausible but its trigger or its connection to a changed line is not demonstrated; a \"please confirm\" or speculative comment scores at most 6.",
  "0-2: pure style, naming, comment, docstring, or type-annotation preference.",
  "0: the finding is about deleted code or recommends reverting to an older implementation.",
  "Score every preExistingIssues entry too, using the same trigger and impact criteria without penalizing its baseline age; 8-10 means a concrete demonstrated failure. These entries are appendix-only and must not be described as introduced by this PR.",
  "Score only the findings supplied, using their exact ids; do not invent findings or ids."
].join(" ");

export interface FindingScoreFilterOptions {
  /** Score floor; findings without a score are never dropped on score. */
  readonly minScore?: number;
  /** Cap on the main list. */
  readonly maxReported?: number;
  /** Cap on the main list from one file. */
  readonly maxPerFile?: number;
}

export interface FindingScoreFilterBreakdown {
  lowScore: number;
  capPerFile: number;
  capTotal: number;
}

export interface FindingScoreFilterResult {
  /** Main-list findings: scored, above the floor, and within both caps. */
  readonly findings: ReviewFinding[];
  /** How many findings were withheld. Their content is never re-published. */
  readonly filteredCount: number;
  readonly breakdown?: FindingScoreFilterBreakdown;
}

const severityRank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 } as const;
const confidenceRank = { confirmed: 3, likely: 2, hypothesis: 1 } as const;

/** Unscored findings rank last but are never withheld for having no score. */
function rankScore(finding: ReviewFinding): number {
  return finding.score ?? -1;
}

/**
 * Attach the synthesizer's scores, then apply the score floor, the per-file
 * cap, and the total cap. Caps are applied highest-score-first, so the most
 * valuable findings survive; the surviving list is returned in the report's
 * usual presentation order.
 */
export function applyFindingScoreFilter(
  findings: readonly ReviewFinding[],
  scores: readonly FindingScore[],
  options: FindingScoreFilterOptions = {}
): FindingScoreFilterResult {
  const minScore = options.minScore ?? DEFAULT_MIN_FINDING_SCORE;
  const maxReported = options.maxReported ?? DEFAULT_MAX_REPORTED_FINDINGS;
  const maxPerFile = options.maxPerFile ?? DEFAULT_MAX_FINDINGS_PER_FILE;
  const scoresById = new Map(scores.map(entry => [entry.id, entry]));

  const scored: ReviewFinding[] = findings.map(finding => {
    const assigned = scoresById.get(finding.id);
    return assigned === undefined
      ? finding
      : { ...finding, score: assigned.score, scoreReason: assigned.reason };
  });

  // A provider that ignored the scoring instruction must not empty the report:
  // only a finding carrying a real score below the floor is withheld.
  const aboveFloor = scored.filter(finding => finding.score === undefined || finding.score >= minScore);
  const lowScoreCount = scored.length - aboveFloor.length;
  const ranked = aboveFloor
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => rankScore(right.finding) - rankScore(left.finding) || left.index - right.index)
    .map(entry => entry.finding);

  const perFileCounts = new Map<string, number>();
  const kept: ReviewFinding[] = [];
  let capPerFileCount = 0;
  let capTotalCount = 0;
  for (const finding of ranked) {
    const fileKey = finding.file.toLowerCase();
    const fileCount = perFileCounts.get(fileKey) ?? 0;
    if (fileCount >= maxPerFile) {
      capPerFileCount += 1;
      continue;
    }
    if (kept.length >= maxReported) {
      capTotalCount += 1;
      continue;
    }
    perFileCounts.set(fileKey, fileCount + 1);
    kept.push(finding);
  }

  // Presentation order stays the report's existing contract (severity, then
  // confidence, then location) even though the caps were applied by score.
  kept.sort((left, right) =>
    severityRank[right.severity] - severityRank[left.severity]
    || confidenceRank[right.confidence] - confidenceRank[left.confidence]
    || left.file.localeCompare(right.file)
    || (left.startLine ?? 0) - (right.startLine ?? 0));

  return {
    findings: kept,
    filteredCount: scored.length - kept.length,
    breakdown: {
      lowScore: lowScoreCount,
      capPerFile: capPerFileCount,
      capTotal: capTotalCount
    }
  };
}
