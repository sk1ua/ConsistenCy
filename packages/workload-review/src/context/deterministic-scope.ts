/**
 * Step 5 — scope deterministic (Python engine) findings to the change.
 *
 * The deterministic stage runs over the changed files and reports per-file
 * findings. Findings that name a line are kept only when that line is within
 * `DETERMINISTIC_SCOPE_PADDING` lines of a changed hunk; a finding the engine
 * reports without any line reference is kept only for a file that is part of
 * the change, because the engine gives no finer anchor and dropping file-scoped
 * signal would lose recall rather than noise.
 *
 * `scope: "all"` restores the unscoped engine output.
 */

import type { DomainAnalyzeSuccess, DomainFileResult } from "@consistency/schema";
import type { LineRange } from "../agents/grounding.js";

export type DeterministicScope = "diff" | "all";

/** How far outside a changed hunk a deterministic finding may still land. */
export const DETERMINISTIC_SCOPE_PADDING = 5;

/** Pulls the first "line N" reference out of a finding string, if any. */
export function findingLineReference(finding: string): number | undefined {
  const match = /(?:^|[\s(])line\s+(\d+)/i.exec(finding);
  if (match === null) return undefined;
  const line = Number(match[1]);
  return Number.isFinite(line) ? line : undefined;
}

function withinChangedRange(ranges: readonly LineRange[], line: number): boolean {
  return ranges.some(range =>
    line >= range.start - DETERMINISTIC_SCOPE_PADDING
    && line <= range.end + DETERMINISTIC_SCOPE_PADDING);
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
  if (scope === "all") return result;

  const files: DomainFileResult[] = result.files.map(file => {
    const ranges = changedRangesByFile.get(file.path) ?? [];
    const findings = file.findings.filter(finding => {
      const line = findingLineReference(finding);
      if (line === undefined) return ranges.length > 0;
      return withinChangedRange(ranges, line);
    });
    return findings.length === file.findings.length ? file : { ...file, findings };
  });

  return { ...result, files };
}
