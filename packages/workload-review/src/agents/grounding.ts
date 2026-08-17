/**
 * Finding grounding — ported from the legacy runtime (parity) and extended
 * with Kernel Evidence grounding:
 *
 *   - Model-supplied evidenceIds must ALL reference real EvidenceStore
 *     records; a finding citing an unknown id is REJECTED (AC-REV-10).
 *   - Findings without evidenceIds get the run's corroborating evidence
 *     attached deterministically (same path; line-intersecting when the
 *     finding carries line numbers) (AC-REV-9).
 */

import type { DomainAnalyzeSuccess, PRReviewContext, ReviewFinding } from "@consistency/schema";
import type { EvidenceStore } from "@consistency/kernel";

export type LineRange = { start: number; end: number };

export type GroundedFileFacts = {
  changedRanges: LineRange[];
  lineCount?: number;
  hasDeterministicSignal: boolean;
};

export type GroundingContext = {
  files: Map<string, GroundedFileFacts>;
};

export type GroundingOutcome = "accepted" | "downgraded" | "rejected";

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
};

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function changedLineRanges(patch: string | undefined): LineRange[] {
  if (!patch) return [];
  const ranges: LineRange[] = [];
  for (const line of patch.split("\n")) {
    const match = HUNK_HEADER.exec(line);
    if (match === null) continue;
    const start = Number(match[1]);
    const length = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isFinite(start)) continue;
    ranges.push({ start, end: start + Math.max(length, 1) - 1 });
  }
  return ranges;
}

function intersects(ranges: LineRange[], start: number, end: number): boolean {
  return ranges.some(range => start <= range.end && end >= range.start);
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
    const facts: GroundedFileFacts = {
      changedRanges: changedLineRanges(changed.patch),
      hasDeterministicSignal: signalFiles.has(changed.path)
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

    if (finding.confidence !== "confirmed") {
      decisions.push({ finding: attachEvidence(finding, evidenceStore, headSha), outcome: "accepted" });
      continue;
    }

    const { startLine, endLine } = finding;

    if (!intersects(facts.changedRanges, startLine, endLine)) {
      decisions.push({
        finding: downgradeToLikely(finding),
        outcome: "downgraded",
        reason: `Lines ${startLine}-${endLine} of '${finding.file}' are outside the changed hunks`
      });
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

    decisions.push({
      finding: attachEvidence(finding, evidenceStore, headSha),
      outcome: "accepted"
    });
  }

  return {
    findings: decisions
      .filter(decision => decision.outcome !== "rejected")
      .map(decision => decision.finding),
    decisions,
    rejected: decisions.filter(decision => decision.outcome === "rejected"),
    downgraded: decisions.filter(decision => decision.outcome === "downgraded")
  };
}
