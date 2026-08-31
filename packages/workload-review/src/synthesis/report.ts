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

function prefer(left: ReviewFinding, right: ReviewFinding): ReviewFinding {
  return (
    severityRank[left.severity] > severityRank[right.severity]
      || (severityRank[left.severity] === severityRank[right.severity]
        && confidenceRank[left.confidence] > confidenceRank[right.confidence])
  ) ? left : right;
}

/**
 * Deterministic cross-agent deduplication: exact file+title matches collapse
 * as before, and near-duplicate titles on the same file (different agents
 * phrasing the same observation) merge too. The surviving finding is the
 * highest-severity (then highest-confidence) one; merged findings are returned
 * separately so the report can disclose them instead of silently dropping them.
 */
export function deduplicateAndSortFindings(findings: ReviewFinding[]): {
  findings: ReviewFinding[];
  duplicates: ReviewFinding[];
} {
  const survivors: Array<{ finding: ReviewFinding; merged: ReviewFinding[]; members: ReviewFinding[] }> = [];
  for (const finding of findings) {
    // Compare against every member of a cluster, not only its current
    // survivor. This keeps near-duplicate grouping transitive when the
    // strongest finding has different wording from an earlier duplicate.
    const host = survivors.find(entry => entry.members.some(member => isNearDuplicate(member, finding)));
    if (host) {
      host.members.push(finding);
      if (prefer(finding, host.finding) === finding) {
        host.merged.push(host.finding);
        host.finding = finding;
      } else {
        host.merged.push(finding);
      }
    } else {
      survivors.push({ finding, merged: [], members: [finding] });
    }
  }

  const kept = survivors.map(entry => entry.finding).sort((left, right) =>
    severityRank[right.severity] - severityRank[left.severity]
    || confidenceRank[right.confidence] - confidenceRank[left.confidence]
    || left.file.localeCompare(right.file)
    || (left.startLine ?? 0) - (right.startLine ?? 0)
  );
  const duplicates = survivors.flatMap(entry => entry.merged).sort((left, right) =>
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
  score: number;
  riskLevel: RiskLevel;
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
    ...(duplicates.length > 0 ? { duplicates } : {}),
    retrieval: input.retrieval,
    createdAt: input.createdAt ?? new Date().toISOString()
  });
}
