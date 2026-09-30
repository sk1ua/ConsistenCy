/**
 * Step 5 — scope deterministic findings and evidence to the change.
 *
 * The deterministic stage runs over the changed files and reports per-file
 * findings. Findings that name a line are kept only when that line is within
 * `DETERMINISTIC_SCOPE_PADDING` lines of a changed hunk; a finding the engine
 * reports without any line reference is kept only for a file that is part of
 * the change, because the engine gives no finer anchor and dropping file-scoped
 * signal would lose recall rather than noise.
 *
 * The same scope is applied to the three delivery channels of deterministic
 * signal: the analyze result's finding strings, the retrieval evidence pack,
 * and the TypeScript style/secret evidence records.
 *
 * `scope: "all"` restores the unscoped engine output; status lines are dropped
 * in both scopes because they were never findings.
 */

import type { DomainAnalyzeSuccess, DomainFileResult, RetrievalTrace } from "@consistency/schema";
import type { LineRange } from "../agents/grounding.js";

export type DeterministicScope = "diff" | "all";

/** How far outside a changed hunk a deterministic finding may still land. */
export const DETERMINISTIC_SCOPE_PADDING = 5;

/**
 * Line references the engine actually emits. Beyond `(line 42)`, the
 * duplication analyzer reports `func@L336`, and some analyzers use a bare
 * `L336`; all three must resolve to a structured line number.
 */
const LINE_REFERENCE_PATTERNS: readonly RegExp[] = [
  /\(line\s+(\d+)\)/gi,
  /\bline\s+(\d+)\b/gi,
  /@L(\d+)\b/g,
  /\bL(\d+)\b/g
];

/** Every distinct line number referenced by a finding string, in order. */
export function findingLineReferences(finding: string): number[] {
  const lines: number[] = [];
  for (const pattern of LINE_REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(finding)) !== null) {
      const line = Number(match[1]);
      if (Number.isFinite(line) && line > 0 && !lines.includes(line)) lines.push(line);
    }
  }
  return lines;
}

/** The first line reference in a finding string, if any. */
export function findingLineReference(finding: string): number | undefined {
  return findingLineReferences(finding)[0];
}

/**
 * Band/status boilerplate, not a finding: `[GREEN] Consistent (score=0.000)`,
 * `[GREY] No Baseline`, `Too few functions to detect duplication`. Counting
 * these as findings inflated the deterministic list with summary text.
 */
const BAND_STATUS = /^\s*\[(?:RED|ORANGE|YELLOW|GREEN|GREY|GRAY|BLUE|INFO|WARN)\]/i;
const STATUS_HEADERS = /^\s*(?:too few (?:functions|classes|methods)|no [a-z0-9_.-]+ issues? detected|not applicable|skipped\b)/i;

export function isDeterministicStatusLine(finding: string): boolean {
  return BAND_STATUS.test(finding) || STATUS_HEADERS.test(finding);
}

function withinChangedRange(ranges: readonly LineRange[], line: number): boolean {
  return ranges.some(range =>
    line >= range.start - DETERMINISTIC_SCOPE_PADDING
    && line <= range.end + DETERMINISTIC_SCOPE_PADDING);
}

function keepFinding(
  finding: string,
  ranges: readonly LineRange[],
  scope: DeterministicScope
): boolean {
  // Status text is not a finding in either scope.
  if (isDeterministicStatusLine(finding)) return false;
  if (scope === "all") return true;
  const lines = findingLineReferences(finding);
  if (lines.length === 0) return ranges.length > 0;
  return lines.some(line => withinChangedRange(ranges, line));
}

function scopeEvidencePack(
  pack: RetrievalTrace,
  changedRangesByFile: ReadonlyMap<string, readonly LineRange[]>
): RetrievalTrace {
  const packs = pack.packs
    .map(entry => {
      const ranges = changedRangesByFile.get(entry.file) ?? [];
      const selected = entry.selected_evidence.filter(item => {
        const line = item.candidate.start_line ?? undefined;
        if (line === undefined) return ranges.length > 0;
        return withinChangedRange(ranges, line);
      });
      return selected.length === entry.selected_evidence.length
        ? entry
        : { ...entry, selected_evidence: selected };
    })
    .filter(entry => entry.selected_evidence.length > 0);

  const totalSelected = packs.reduce((sum, entry) => sum + entry.selected_evidence.length, 0);
  return {
    ...pack,
    packs,
    summary: {
      ...pack.summary,
      files_with_evidence: packs.length,
      total_selected_evidence: totalSelected,
      average_selected_evidence_count: packs.length === 0 ? 0 : totalSelected / packs.length
    }
  };
}

/**
 * Keep only the deterministic findings that can be tied to the change.
 * File risk scores and every other field are left untouched: this bounds what
 * is REPORTED, not what the engine measured.
 */
export function scopeDeterministicFindings(
  result: DomainAnalyzeSuccess,
  changedRangesByFile: ReadonlyMap<string, readonly LineRange[]>,
  scope: DeterministicScope = "diff"
): DomainAnalyzeSuccess {
  const files: DomainFileResult[] = result.files.map(file => {
    const ranges = changedRangesByFile.get(file.path) ?? [];
    const findings = file.findings.filter(finding => keepFinding(finding, ranges, scope));
    return findings.length === file.findings.length ? file : { ...file, findings };
  });

  const evidencePack = result.evidencePack === undefined || scope === "all"
    ? result.evidencePack
    : scopeEvidencePack(result.evidencePack, changedRangesByFile);

  return { ...result, files, ...(evidencePack !== undefined ? { evidencePack } : {}) };
}

/**
 * Scope the TypeScript style/secret evidence records (the PR-4 analyzers) with
 * the same rule. Structural type so this module stays free of Kernel imports.
 */
export function scopeEvidenceInputs<T extends { location: { path: string; startLine?: number } }>(
  inputs: readonly T[],
  changedRangesByFile: ReadonlyMap<string, readonly LineRange[]>,
  scope: DeterministicScope = "diff"
): T[] {
  if (scope === "all") return [...inputs];
  return inputs.filter(input => {
    const ranges = changedRangesByFile.get(input.location.path) ?? [];
    if (ranges.length === 0) return false;
    const line = input.location.startLine;
    if (line === undefined) return true;
    return withinChangedRange(ranges, line);
  });
}
