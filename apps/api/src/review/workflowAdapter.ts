import type { DomainAnalyzeSuccess, DomainFileResult, EvidencePack, RetrievalTrace, WorkflowRun } from "@consistency/schema";

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
 * Project workflow artifact evidence onto the engine's RetrievalTrace shape
 * (audit P1-06: the default review workflow used to DROP its evidence after
 * consuming it for risk scores, leaving `report.retrieval` empty and the
 * Notebook's evidence-pack tool serving a placeholder). The packs mirror what
 * the legacy engine path produces so downstream consumers (report evidence
 * card, Notebook citations) need no per-path branching.
 */
function evidencePackFromRun(run: WorkflowRun): RetrievalTrace | undefined {
  const byFile = new Map<string, EvidencePack["selected_evidence"]>();
  const rulesByFile = new Map<string, Set<string>>();

  for (const artifact of run.artifacts) {
    if (artifact.status !== "succeeded" || artifact.evidence === undefined) continue;
    for (const item of artifact.evidence.items) {
      const rule = item.rule ?? artifact.stepId;
      const entries = byFile.get(item.file) ?? [];
      entries.push({
        candidate: {
          id: `${artifact.stepId}:${item.file}:${item.startLine ?? 0}`,
          file: item.file,
          kind: "changed_hunk",
          source: artifact.stepId,
          content: item.excerpt,
          ...(item.startLine !== undefined ? { start_line: item.startLine } : {}),
          ...(item.endLine !== undefined ? { end_line: item.endLine } : {}),
          metadata: item.metadata
        },
        score: { total: scoreFor(item), reasons: [`workflow step '${artifact.stepId}' reported this evidence`] },
        why_selected: [`Reported by workflow step '${artifact.stepId}'`]
      });
      byFile.set(item.file, entries);
      const rules = rulesByFile.get(item.file) ?? new Set<string>();
      rules.add(rule);
      rulesByFile.set(item.file, rules);
    }
  }

  if (byFile.size === 0) return undefined;

  const packs: EvidencePack[] = [...byFile.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, selected]) => ({
      file,
      retrieval_strategy: "workflow-artifacts",
      // The workflow path has no token-budget accounting of its own; zero is
      // the honest value and the strategy label says where this came from.
      context_budget_tokens: 0,
      query: {
        file,
        path_terms: file.split("/"),
        symbol_terms: [],
        import_terms: [],
        risk_terms: [...(rulesByFile.get(file) ?? [])].sort(),
        natural_query: `Workflow evidence for ${file}`,
        metadata: { workflow: run.specName, runId: run.runId }
      },
      selected_evidence: selected,
      discarded_candidates: [],
      compression: {
        candidate_count: selected.length,
        selected_count: selected.length
      }
    }));

  const totalSelected = packs.reduce((sum, pack) => sum + pack.selected_evidence.length, 0);
  return {
    strategy: `workflow:${run.specName}`,
    context_budget_tokens: 0,
    packs,
    summary: {
      files_with_evidence: packs.length,
      total_selected_evidence: totalSelected,
      average_selected_evidence_count: packs.length === 0 ? 0 : totalSelected / packs.length,
      average_compression_ratio: 1
    }
  };
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
    },
    evidencePack: evidencePackFromRun(run)
  };
}
