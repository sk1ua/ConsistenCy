/**
 * Finding grounding — ported from the legacy runtime (parity) and extended
 * with Kernel Evidence grounding:
 *
 *   - Model-supplied evidenceIds must ALL reference real EvidenceStore
 *     records; a finding citing an unknown id is REJECTED (AC-REV-10).
 *   - Findings without evidenceIds get the run's corroborating evidence
 *     attached deterministically (same path; line-intersecting when the
 *     finding carries line numbers) (AC-REV-9).
 *   - A "confirmed" finding always reaches the report with at least one
 *     evidenceId; with no intersecting record it is downgraded to "likely"
 *     instead (audit P1-06②).
 */

import type { DomainAnalyzeSuccess, PRReviewContext, ReviewFinding } from "@consistency/schema";
import type { EvidenceStore } from "@consistency/kernel";

export type LineRange = { start: number; end: number };

export type GroundedFileFacts = {
  changedRanges: LineRange[];
  lineCount?: number;
  hasDeterministicSignal: boolean;
  baseContent?: string;
  headContent?: string;
};

export type GroundingContext = {
  files: Map<string, GroundedFileFacts>;
};

export type GroundingOutcome = "accepted" | "downgraded" | "rejected" | "pre_existing";

export type GroundingDecision = {
  finding: ReviewFinding;
  outcome: GroundingOutcome;
  reason?: string;
};

export type GroundingResult = {
  findings: ReviewFinding[];
  decisions: GroundingDecision[];
  rejected: GroundingDecision[];
  downgraded: GroundingDecision[];
  preExisting: GroundingDecision[];
};

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function changedLineRanges(patch: string | undefined): LineRange[] {
  if (!patch) return [];
  const ranges: LineRange[] = [];
  const hunkRanges: LineRange[] = [];
  let lineNumber: number | undefined;
  let sawBodyLine = false;
  for (const line of patch.split("\n")) {
    const match = HUNK_HEADER.exec(line);
    if (match !== null) {
      const start = Number(match[1]);
      const length = match[2] === undefined ? 1 : Number(match[2]);
      if (!Number.isFinite(start)) continue;
      lineNumber = start;
      hunkRanges.push({ start, end: start + Math.max(length, 1) - 1 });
      continue;
    }
    if (lineNumber === undefined) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      sawBodyLine = true;
      const previous = ranges.at(-1);
      if (previous && previous.end + 1 === lineNumber) previous.end = lineNumber;
      else ranges.push({ start: lineNumber, end: lineNumber });
      lineNumber += 1;
    } else if (line.startsWith("-")) {
      sawBodyLine = true;
    } else if (line.startsWith(" ")) {
      sawBodyLine = true;
      lineNumber += 1;
    }
  }
  // Older context fixtures contain only hunk headers; preserve their range.
  return sawBodyLine ? ranges : hunkRanges;
}

function intersects(ranges: LineRange[], start: number, end: number, padding = 0): boolean {
  return ranges.some(range => start <= range.end + padding && end >= range.start - padding);
}

export function buildGroundingContext(
  context: PRReviewContext,
  deterministic?: DomainAnalyzeSuccess
): GroundingContext {
  const signalFiles = new Set<string>();
  for (const file of deterministic?.files ?? []) {
    if (file.findings.length > 0 || file.riskScore > 0) signalFiles.add(file.path);
  }

  const files = new Map<string, GroundedFileFacts>();
  for (const changed of context.changedFiles) {
    const content = context.fileContents[changed.path];
    const baseContent = context.baseFileContents?.[changed.path];
    const facts: GroundedFileFacts = {
      changedRanges: changedLineRanges(changed.patch),
      hasDeterministicSignal: signalFiles.has(changed.path),
      baseContent,
      headContent: content
    };
    if (content !== undefined) facts.lineCount = content.split("\n").length;
    files.set(changed.path, facts);
  }
  return { files };
}

function downgradeToLikely(finding: ReviewFinding): ReviewFinding {
  if (finding.confidence !== "confirmed") return finding;
  const { confidence: _confidence, ...rest } = finding;
  return { ...rest, confidence: "likely" };
}

function lineIntersects(
  evidenceStart: number | undefined,
  evidenceEnd: number | undefined,
  findingStart: number,
  findingEnd: number,
): boolean {
  if (evidenceStart === undefined) return true;
  const start = evidenceStart;
  const end = evidenceEnd ?? evidenceStart;
  return start <= findingEnd && end >= findingStart;
}

/**
 * Attach the run's corroborating Kernel Evidence to a finding.
 * Deterministic: ids in store query order (sha, path, line, …).
 */
function attachEvidence(
  finding: ReviewFinding,
  evidenceStore: EvidenceStore,
  headSha: string,
): ReviewFinding {
  const existing = finding.evidenceIds;
  if (existing && existing.length > 0) return finding; // model-supplied, validated separately

  const relevant = evidenceStore.query({ sha: headSha, path: finding.file });
  const ids: string[] = [];
  if (finding.startLine !== undefined) {
    const end = finding.endLine ?? finding.startLine;
    for (const record of relevant) {
      if (lineIntersects(record.location.startLine, record.location.endLine, finding.startLine, end)) {
        ids.push(record.id);
      }
    }
  } else {
    for (const record of relevant) ids.push(record.id);
  }
  if (ids.length === 0) return finding;
  return { ...finding, evidenceIds: ids };
}

/**
 * Enforces evidence anchoring on model output, plus Kernel Evidence
 * validation. Runs on the RESPONSE, so a model cannot talk its way past it.
 */
export function groundReviewFindings(
  findings: readonly ReviewFinding[],
  grounding: GroundingContext,
  evidenceStore: EvidenceStore,
  headSha: string,
): GroundingResult {
  const decisions: GroundingDecision[] = [];
  const validEvidenceIds = new Set<string>(evidenceStore.list().map((record) => record.id));

  for (const finding of findings) {
    // Kernel Evidence grounding: unknown ids reject the finding outright.
    if (finding.evidenceIds && finding.evidenceIds.length > 0) {
      const unknown = finding.evidenceIds.filter((id) => !validEvidenceIds.has(id));
      if (unknown.length > 0) {
        decisions.push({
          finding,
          outcome: "rejected",
          reason: `Cites unknown evidence id(s): ${unknown.join(", ")}`
        });
        continue;
      }
    }

    const facts = grounding.files.get(finding.file);

    if (facts === undefined) {
      decisions.push({
        finding,
        outcome: "rejected",
        reason: `References '${finding.file}', which is not part of this change`
      });
      continue;
    }

    if (
      finding.startLine !== undefined &&
      facts.lineCount !== undefined &&
      finding.startLine > facts.lineCount
    ) {
      decisions.push({
        finding,
        outcome: "rejected",
        reason: `Cites line ${finding.startLine} of '${finding.file}', which has ${facts.lineCount} lines`
      });
      continue;
    }

    const { startLine, endLine } = finding;
    const baseline = finding.baselineAssessment;
    // Source identity alone cannot establish unchanged behavior: a changed
    // caller, configuration, or guard can expose a defect on an untouched line.
    // Require both an explicit behavioral assessment and exact baseline code.
    if (baseline?.behaviorUnchanged && facts.baseContent !== undefined && facts.headContent !== undefined && startLine !== undefined && endLine !== undefined) {
      const baseLines = facts.baseContent.split(/\r?\n/);
      const headLines = facts.headContent.split(/\r?\n/);
      const validRange = baseline.baseStartLine <= baseline.baseEndLine && baseline.baseEndLine <= baseLines.length && endLine <= headLines.length && startLine <= endLine;
      const baseCode = baseLines.slice(baseline.baseStartLine - 1, baseline.baseEndLine).join("\n");
      const headCode = headLines.slice(startLine - 1, endLine).join("\n");
      if (validRange && headCode.trim().length > 0 && baseCode === headCode && !intersects(facts.changedRanges, startLine, endLine)) {
        decisions.push({ finding, outcome: "pre_existing", reason: baseline.reason });
        continue;
      }
    }

    // A distant allegation is withheld by default, not asserted to be proven
    // baseline-equivalent. Keep an indirect regression actionable only when the
    // model explicitly assesses changed behavior and explains the causal link.
    const explainedRegression = baseline?.behaviorUnchanged === false && baseline.reason.trim().length > 0;
    if (startLine !== undefined && endLine !== undefined && facts.changedRanges.length > 0
      && !intersects(facts.changedRanges, startLine, endLine, 3) && !explainedRegression) {
      decisions.push({ finding, outcome: "pre_existing", reason: "Outside changed lines ±3; no explicit explanation that this PR changes the cited behavior (distance fallback, not baseline proof)" });
      continue;
    }

    if (finding.confidence !== "confirmed") {
      decisions.push({ finding: attachEvidence(finding, evidenceStore, headSha), outcome: "accepted" });
      continue;
    }

    if (!facts.hasDeterministicSignal) {
      decisions.push({
        finding: downgradeToLikely(finding),
        outcome: "downgraded",
        reason: `No deterministic signal corroborates '${finding.file}'`
      });
      continue;
    }

    // Audit P1-06②: "confirmed" must mean evidence-anchored. A finding that
    // passed the hunk and signal gates but has no intersecting Evidence record
    // keeps its content yet cannot claim confirmation.
    const anchored = attachEvidence(finding, evidenceStore, headSha);
    if ((anchored.evidenceIds ?? []).length === 0) {
      decisions.push({
        finding: downgradeToLikely(anchored),
        outcome: "downgraded",
        reason: `No evidence record corroborates '${finding.file}' at the cited lines`
      });
      continue;
    }

    decisions.push({
      finding: anchored,
      outcome: "accepted"
    });
  }

  return {
    findings: decisions
      .filter(decision => decision.outcome === "accepted" || decision.outcome === "downgraded")
      .map(decision => decision.finding),
    decisions,
    rejected: decisions.filter(decision => decision.outcome === "rejected"),
    downgraded: decisions.filter(decision => decision.outcome === "downgraded"),
    preExisting: decisions.filter(decision => decision.outcome === "pre_existing")
  };
}
