import type { ReviewFinding } from "@consistency/schema";

const MAX_EXPANDED_RANGE = 5_000;

export type FindingIndex = {
  byFile: ReadonlyMap<string, readonly ReviewFinding[]>;
  byLine: ReadonlyMap<string, ReadonlyMap<number, readonly ReviewFinding[]>>;
  wideRanges: ReadonlyMap<string, readonly ReviewFinding[]>;
};

function appendToMap<Key>(map: Map<Key, ReviewFinding[]>, key: Key, finding: ReviewFinding): void {
  const current = map.get(key);
  if (current) current.push(finding);
  else map.set(key, [finding]);
}

/**
 * Builds the lookup once per report instead of filtering every finding for
 * every rendered diff line. Pathological multi-thousand-line ranges stay as
 * intervals so an untrusted report cannot allocate an unbounded line map.
 */
export function buildFindingIndex(findings: readonly ReviewFinding[]): FindingIndex {
  const byFile = new Map<string, ReviewFinding[]>();
  const mutableByLine = new Map<string, Map<number, ReviewFinding[]>>();
  const wideRanges = new Map<string, ReviewFinding[]>();

  for (const finding of findings) {
    appendToMap(byFile, finding.file, finding);
    if (finding.startLine === undefined) continue;

    const endLine = finding.endLine ?? finding.startLine;
    if (endLine - finding.startLine > MAX_EXPANDED_RANGE) {
      appendToMap(wideRanges, finding.file, finding);
      continue;
    }

    let lines = mutableByLine.get(finding.file);
    if (!lines) {
      lines = new Map<number, ReviewFinding[]>();
      mutableByLine.set(finding.file, lines);
    }
    for (let line = finding.startLine; line <= endLine; line += 1) {
      appendToMap(lines, line, finding);
    }
  }

  return { byFile, byLine: mutableByLine, wideRanges };
}

export function findingsForFile(index: FindingIndex, file: string): readonly ReviewFinding[] {
  return index.byFile.get(file) ?? [];
}

export function findingsForLine(index: FindingIndex, file: string, line?: number): readonly ReviewFinding[] {
  if (line === undefined) return [];
  const exact = index.byLine.get(file)?.get(line) ?? [];
  const wide = index.wideRanges.get(file);
  if (!wide || wide.length === 0) return exact;

  const matchingWide = wide.filter(finding =>
    finding.startLine !== undefined &&
    line >= finding.startLine &&
    line <= (finding.endLine ?? finding.startLine)
  );
  return matchingWide.length === 0 ? exact : [...exact, ...matchingWide];
}
