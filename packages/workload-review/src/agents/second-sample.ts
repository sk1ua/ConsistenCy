import type { ReviewFinding } from "@consistency/schema";

function normalizedTitle(finding: ReviewFinding): string {
  return finding.title.toLowerCase().replace(/\s+/g, " ").trim();
}

function rangesOverlap(left: ReviewFinding, right: ReviewFinding): boolean {
  if (left.file !== right.file) return false;
  if (left.startLine === undefined || left.endLine === undefined || right.startLine === undefined || right.endLine === undefined) return false;
  return left.startLine <= right.endLine + 3 && right.startLine <= left.endLine + 3;
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
