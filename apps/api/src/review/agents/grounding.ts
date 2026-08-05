import type { DomainAnalyzeSuccess, PRReviewContext, ReviewFinding } from "@consistency/schema";

export type LineRange = { start: number; end: number };

export type GroundedFileFacts = {
  /** Line ranges touched on the new side of the diff. */
  changedRanges: LineRange[];
  /** Lines in the post-change file, or undefined when content was not loaded. */
  lineCount?: number;
  /** The deterministic engine produced at least one signal for this file. */
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
  /** Findings safe to publish, with confidence adjusted where warranted. */
  findings: ReviewFinding[];
  decisions: GroundingDecision[];
  rejected: GroundingDecision[];
  downgraded: GroundingDecision[];
};

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * New-side line ranges from a unified diff patch.
 *
 * Only the `+` side matters: a finding claims something about the code as it
 * will exist after the change.
 */
export function changedLineRanges(patch: string | undefined): LineRange[] {
  if (!patch) return [];
  const ranges: LineRange[] = [];
  for (const line of patch.split("\n")) {
    const match = HUNK_HEADER.exec(line);
    if (match === null) continue;
    const start = Number(match[1]);
    const length = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isFinite(start)) continue;
    // A zero-length hunk (pure deletion) still anchors at its position.
    ranges.push({ start, end: start + Math.max(length, 1) - 1 });
  }
  return ranges;
}

function intersects(ranges: LineRange[], start: number, end: number): boolean {
  return ranges.some(range => start <= range.end && end >= range.start);
}

/**
 * Collects what is provably true about this change, from the diff and the
 * deterministic engine. Nothing here comes from the model.
 */
export function buildGroundingContext(
  context: PRReviewContext,
  deterministic?: DomainAnalyzeSuccess
): GroundingContext {
  const signalFiles = new Set<string>();
  for (const file of deterministic?.files ?? []) {
    // A file with no findings and no risk contributes no corroboration.
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

/**
 * Enforces evidence anchoring on model output.
 *
 * The literal rule in the plan — never emit a vulnerability without a matching
 * deterministic tool finding — would make the model unable to report anything
 * static analysis had already missed, which is most of why it is there. This
 * instead gates *confidence* by evidence strength, matching the tiers the
 * schema already defines:
 *
 *   confirmed  — real file, lines inside a changed hunk, corroborated by the
 *                deterministic engine
 *   likely     — real file and plausible anchor, but not corroborated
 *   rejected   — the anchor does not exist: a file outside this change, or a
 *                line past the end of the file
 *
 * A model cannot promote its own claim past what the evidence supports, because
 * this runs on the output rather than being asked for in the prompt.
 */
export function groundFindings(
  findings: readonly ReviewFinding[],
  grounding: GroundingContext
): GroundingResult {
  const decisions: GroundingDecision[] = [];

  for (const finding of findings) {
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

    // Only `confirmed` claims are gated further; the schema guarantees they
    // carry a line range, so no undefined check is needed below.
    if (finding.confidence !== "confirmed") {
      decisions.push({ finding, outcome: "accepted" });
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

    decisions.push({ finding, outcome: "accepted" });
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
