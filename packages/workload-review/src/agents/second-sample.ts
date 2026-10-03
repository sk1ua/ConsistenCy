import type { ReviewFinding } from "@consistency/schema";

function normalizedTitle(finding: ReviewFinding): string {
  return finding.title.toLowerCase().replace(/\s+/g, " ").trim();
}

function rangesOverlap(left: ReviewFinding, right: ReviewFinding): boolean {
  if (left.file !== right.file) return false;
  if (left.startLine === undefined || left.endLine === undefined || right.startLine === undefined || right.endLine === undefined) return false;
  return left.startLine <= right.endLine + 3 && right.startLine <= left.endLine + 3;
}

function hasLines(finding: ReviewFinding): boolean {
  return finding.startLine !== undefined && finding.endLine !== undefined;
}

export const VOTE_MAX_JACCARD = 0.8;

export type SampleSupport = {
  findings: ReviewFinding[];
  n1: number;
  n2: number;
  agreed: number;
  jaccard: number;
  fallback: boolean;
};

function withSupport(finding: ReviewFinding, support: number): ReviewFinding {
  return { ...finding, support };
}

function uniqueId(id: string, ids: Set<string>): string {
  let next = `${id}-s2`;
  let suffix = 2;
  while (ids.has(next)) {
    next = `${id}-s2-${suffix}`;
    suffix += 1;
  }
  ids.add(next);
  return next;
}

/**
 * Vote semantics: a finding that appears in both samples gets support 2.
 * Unmatched second-sample findings are appended with support 1. Jaccard above
 * the fixed ceiling carries no information, so every support falls back to 1.
 */
export function computeSampleSupport(first: readonly ReviewFinding[], second: readonly ReviewFinding[]): SampleSupport {
  const used = new Set<number>();
  const agreedIds = new Set<string>();
  for (const finding of first) {
    const match = second.findIndex((candidate, index) => {
      if (used.has(index)) return false;
      if (finding.file !== candidate.file) return false;
      if (hasLines(finding) && hasLines(candidate)) return rangesOverlap(finding, candidate);
      if (!hasLines(finding) && !hasLines(candidate)) return normalizedTitle(finding) === normalizedTitle(candidate);
      return false;
    });
    if (match < 0) continue;
    used.add(match);
    agreedIds.add(finding.id);
  }
  const denominator = first.length + second.length - agreedIds.size;
  const jaccard = denominator === 0 ? 0 : agreedIds.size / denominator;
  const fallback = jaccard > VOTE_MAX_JACCARD;
  const ids = new Set(first.map(finding => finding.id));
  const findings = [
    ...first.map(finding => withSupport(finding, !fallback && agreedIds.has(finding.id) ? 2 : 1)),
    ...second.flatMap((finding, index) => used.has(index) ? [] : [withSupport({ ...finding, id: uniqueId(finding.id, ids) }, 1)])
  ];
  return { findings, n1: first.length, n2: second.length, agreed: agreedIds.size, jaccard, fallback };
}

/** Keep the first sample intact, then append second-sample findings that are not nearby or same-titled duplicates. */
export function mergeSampleFindings(first: readonly ReviewFinding[], second: readonly ReviewFinding[]): ReviewFinding[] {
  const kept: ReviewFinding[] = [...first];
  const ids = new Set(kept.map(finding => finding.id));
  for (const finding of second) {
    const duplicate = kept.some(existing => rangesOverlap(existing, finding) || normalizedTitle(existing) === normalizedTitle(finding));
    if (duplicate) continue;
    let id = `${finding.id}-s2`;
    let suffix = 2;
    while (ids.has(id)) {
      id = `${finding.id}-s2-${suffix}`;
      suffix += 1;
    }
    ids.add(id);
    kept.push({ ...finding, id });
  }
  return kept;
}
