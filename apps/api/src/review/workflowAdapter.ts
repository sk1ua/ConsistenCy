import type { DomainAnalyzeSuccess, DomainFileResult, WorkflowRun } from "@consistency/schema";

/** Fallback risk for evidence that carries no analyzer score of its own. */
const RISK_BY_SEVERITY: Record<string, number> = {
  critical: 0.9,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
  info: 0.1
};

function riskLabelFor(score: number): string {
  if (score >= 0.75) return "Severe Drift";
  if (score >= 0.5) return "Moderate Drift";
  if (score >= 0.25) return "Minor Drift";
  return "Stable";
}

function riskColourFor(score: number): string {
  if (score >= 0.75) return "RED";
  if (score >= 0.5) return "ORANGE";
  if (score >= 0.25) return "YELLOW";
  return "GREEN";
}

function scoreFor(item: { severity?: string; metadata: Record<string, unknown> }): number {
  // The engine.* plugins carry the agent's own calibrated score; prefer it.
  const declared = item.metadata["score"];
  if (typeof declared === "number" && Number.isFinite(declared)) {
    return Math.min(1, Math.max(0, declared));
  }
  return RISK_BY_SEVERITY[item.severity ?? "info"] ?? 0.1;
}

/**
 * Projects a workflow run onto the analysis contract the review graph consumes.
 *
 * A file's risk is the highest score any step attributed to it, matching how the
 * `analyze` action reports the dominant signal rather than an average that would
 * dilute one severe finding among many trivial ones.
 *
 * Steps that failed or were skipped contribute no evidence, so a missing linter
 * lowers coverage rather than silently lowering risk.
 */
export function workflowRunToAnalyzeResult(
  requestId: string,
  run: WorkflowRun
): DomainAnalyzeSuccess {
  const byFile = new Map<string, { findings: string[]; score: number; steps: Set<string> }>();

  for (const artifact of run.artifacts) {
    if (artifact.status !== "succeeded" || artifact.evidence === undefined) continue;
    for (const item of artifact.evidence.items) {
      const entry = byFile.get(item.file) ?? { findings: [], score: 0, steps: new Set<string>() };
      const location = item.startLine === undefined ? "" : ` (line ${item.startLine})`;
      const rule = item.rule === undefined ? artifact.stepId : item.rule;
      entry.findings.push(`[${rule}]${location} ${item.excerpt}`.trim());
      entry.score = Math.max(entry.score, scoreFor(item));
      entry.steps.add(artifact.stepId);
      byFile.set(item.file, entry);
    }
  }

  const files: DomainFileResult[] = [...byFile.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, entry]) => ({
      path,
      riskScore: Number(entry.score.toFixed(4)),
      riskLabel: riskLabelFor(entry.score),
      riskColor: riskColourFor(entry.score),
      signals: { steps: [...entry.steps].sort() },
      findings: entry.findings,
      confidence: 1
    }));

  return {
    id: requestId,
    ok: true,
    files,
    consensus: {
      workflow: run.specName,
      runId: run.runId,
      status: run.status,
      steps: run.artifacts.map(artifact => ({
        stepId: artifact.stepId,
        uses: artifact.uses,
        status: artifact.status,
        durationMs: artifact.durationMs ?? null
      }))
    }
  };
}
