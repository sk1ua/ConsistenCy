import { z } from "zod";
import { agentRunSchema, reviewAgentNameSchema, reviewFindingSchema, type Severity } from "./review";
import type { DomainFileResult } from "./protocol";

export const riskLevelSchema = z.enum(["critical", "high", "medium", "low"]);

/**
 * Execution coverage of a review run. Distinguishes "execution completed with
 * full agent coverage" from "execution completed but coverage is degraded":
 * a run whose enabled specialists (or planner/synthesizer) failed still
 * produces a durable report, but that report must never read as a clean,
 * complete review (audit P1-05). "No findings" stays a legitimate outcome of
 * a COMPLETE run.
 */
export const reviewCoverageSchema = z.object({
  outcome: z.enum(["complete", "degraded"]),
  /** Specialists enabled by the plan for this run. */
  enabledAgents: z.array(reviewAgentNameSchema),
  /** Enabled specialists whose execution failed. */
  failedAgents: z.array(reviewAgentNameSchema),
  plannerFailed: z.boolean(),
  synthesizerFailed: z.boolean(),
  /**
   * Default `pr-review` workflow had one or more failed/skipped steps (audit
   * P1-09). Optional so reports from before this field keep parsing.
   */
  deterministicFailed: z.boolean().optional()
}).strict();
export type ReviewCoverage = z.infer<typeof reviewCoverageSchema>;
const evidenceKindSchema = z.enum([
  "changed_hunk",
  "file_snippet",
  "baseline_snippet",
  "history_signal",
  "agent_finding",
  "import_context",
  "callsite_hint",
  "review_comment_hint",
  "security_hint",
  "evolution_hint"
]);

export const evidenceQuerySchema = z.object({
  file: z.string(),
  path_terms: z.array(z.string()),
  symbol_terms: z.array(z.string()),
  import_terms: z.array(z.string()),
  risk_terms: z.array(z.string()),
  natural_query: z.string(),
  metadata: z.record(z.unknown())
}).passthrough();

export const evidenceCandidateSchema = z.object({
  id: z.string(),
  file: z.string(),
  kind: evidenceKindSchema,
  source: z.string(),
  content: z.string(),
  start_line: z.number().int().positive().nullable().optional(),
  end_line: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

export const evidenceScoreSchema = z.object({
  total: z.number(),
  path_relevance: z.number().optional(),
  symbol_overlap: z.number().optional(),
  import_overlap: z.number().optional(),
  risk_signal_overlap: z.number().optional(),
  changed_line_proximity: z.number().optional(),
  severity_boost: z.number().optional(),
  history_boost: z.number().optional(),
  security_boost: z.number().optional(),
  local_similarity: z.number().optional(),
  reasons: z.array(z.string()).optional()
}).passthrough();

export const selectedEvidenceSchema = z.object({
  candidate: evidenceCandidateSchema,
  score: evidenceScoreSchema,
  why_selected: z.array(z.string())
}).passthrough();

export const discardedEvidenceSchema = z.object({
  candidate_id: z.string(),
  kind: z.string(),
  score: z.number(),
  why_discarded: z.array(z.string())
}).passthrough();

export const evidencePackSchema = z.object({
  file: z.string(),
  retrieval_strategy: z.string(),
  context_budget_tokens: z.number().int().nonnegative(),
  query: evidenceQuerySchema,
  selected_evidence: z.array(selectedEvidenceSchema),
  discarded_candidates: z.array(discardedEvidenceSchema),
  compression: z.object({
    candidate_count: z.number().int().nonnegative().optional(),
    selected_count: z.number().int().nonnegative().optional(),
    estimated_input_tokens: z.number().int().nonnegative().optional(),
    estimated_output_tokens: z.number().int().nonnegative().optional(),
    compression_ratio: z.number().nonnegative().optional()
  }).passthrough()
}).passthrough();

export const retrievalTraceSchema = z.object({
  strategy: z.string(),
  context_budget_tokens: z.number().int().nonnegative(),
  packs: z.array(evidencePackSchema),
  summary: z.object({
    files_with_evidence: z.number().int().nonnegative(),
    total_selected_evidence: z.number().int().nonnegative(),
    average_selected_evidence_count: z.number().nonnegative(),
    average_compression_ratio: z.number().nonnegative()
  }).passthrough()
}).passthrough();

/**
 * Durable projection of a Kernel Evidence record (audit P1-04). Findings
 * reference these by `evidenceIds`; persisting them alongside the report
 * keeps those references resolvable after the in-memory EvidenceStore dies
 * with the run — across API restarts and working-tree drift. `payload` is
 * analyzer output (secret rules carry redacted excerpts by construction).
 */
export const reviewEvidenceRecordSchema = z.object({
  id: z.string().trim().min(1),
  source: z.enum(["ast", "sast", "git", "lint", "symbol", "test", "agent"]),
  ruleId: z.string().optional(),
  location: z.object({
    path: z.string().trim().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional()
  }).strict(),
  confidence: z.number().min(0).max(1),
  payload: z.record(z.string(), z.unknown()).optional(),
  provenance: z.object({
    repository: z.string(),
    sha: z.string(),
    analyzer: z.string(),
    analyzerVersion: z.string()
  }).strict(),
  fingerprint: z.string().optional()
}).strict();

export type ReviewEvidenceRecord = z.infer<typeof reviewEvidenceRecordSchema>;

export const reviewReportSchema = z.object({
  jobId: z.string().trim().min(1),
  repositoryFullName: z.string().trim().min(1),
  /** Absent for local reviews, which have no pull request. */
  pullRequestNumber: z.number().int().positive().optional(),
  baseSha: z.string().trim().min(1),
  headSha: z.string().trim().min(1),
  // Validate nonblank summaries without transforming the model's prose.
  summary: z.string().min(1).refine(value => value.trim().length > 0, "Summary must not be blank"),
  score: z.number().int().min(0).max(100),
  riskLevel: riskLevelSchema,
  /** Deterministic static analysis label (e.g. "No Baseline", "Moderate Drift", "skipped") */
  staticRiskLabel: z.string().optional(),
  /**
   * Verdict band derived from the FINAL LLM findings' severity distribution
   * (any high → high; else any medium → medium; else low; no findings →
   * none). Deliberately separate from `riskLevel`, which is the
   * deterministic static-analysis score band; UIs should present the two as
   * distinct, explicitly named fields. Optional so persisted reports from
   * before this field existed keep parsing.
   */
  riskBand: z.enum(["high", "medium", "low", "none"]).optional(),
  llmProvider: z.string().trim().min(1).optional(),
  llmModel: z.string().trim().min(1).optional(),
  agentRuns: z.array(agentRunSchema),
  /** Known prompt input + cached input across all runs, including failed calls. */
  promptTokens: z.number().int().nonnegative().optional(),
  /** Usage missing on failed/partial calls is unknown, not a zero-cost call. */
  tokenUsageNotes: z.array(z.string().trim().min(1)).optional(),
  findings: z.array(reviewFindingSchema),
  /** Findings outside the changed-line scope; excluded from the main verdict and score. */
  preExistingIssues: z.array(reviewFindingSchema).optional(),
  /**
   * How many grounded findings were withheld from the main list after scoring
   * (below the score floor, past the per-file cap, or past the total cap).
   * Only the COUNT is persisted: the withheld findings are not re-published in
   * the report they were filtered out of.
   */
  filteredFindingCount: z.number().int().nonnegative().optional(),
  /** Breakdown of filtered findings by reason. */
  filteredBreakdown: z.object({
    capPerSpecialist: z.number().int().nonnegative().optional(),
    lowScore: z.number().int().nonnegative().optional(),
    capTotal: z.number().int().nonnegative().optional(),
    capPerFile: z.number().int().nonnegative().optional(),
  }).partial().optional(),
  /**
   * Findings merged away by deterministic cross-agent deduplication
   * (same file, near-identical title). Kept for honesty instead of being
   * silently dropped. Optional for backward compatibility.
   */
  duplicates: z.array(reviewFindingSchema).optional(),
  /**
   * Diagnostic copies of findings a filter withheld. Present only when the
   * caller opts in; absent means the report is byte-identical to the count-only form.
   */
  withheldFindings: z.array(z.object({
    stage: z.enum([
      "precedent", "noise", "maint-filter", "coverage", "grounding-rejected",
      "grounding-preexisting-dropped", "specialist-cap", "low-score", "cap-per-file",
      "cap-total", "merged",
    ]),
    agent: z.string(),
    score: z.number().int().optional(),
    scoreReason: z.string().optional(),
    finding: reviewFindingSchema,
  }).strict()).optional(),
  /**
   * Agent execution coverage. Optional so persisted reports from before this
   * field existed keep parsing (legacy reports read as coverage-unknown).
   */
  coverage: reviewCoverageSchema.optional(),
  retrieval: retrievalTraceSchema.optional(),
  /**
   * Kernel Evidence records backing `findings[].evidenceIds` (audit P1-04).
   * Optional so persisted reports from before this field existed keep
   * parsing (their evidence ids read as unresolvable, never fabricated).
   */
  evidence: z.array(reviewEvidenceRecordSchema).optional(),
  /**
   * Scoring and aggregation rule version. "v1" denotes legacy peak single-file
   * scoring; "v2" denotes multi-dimensional balanced scoring with deterministic
   * critical safety gates.
   */
  ruleVersion: z.string().trim().min(1).optional(),
  createdAt: z.string().datetime()
}).strict();

/**
 * Derive the verdict band from the final findings' severity distribution.
 * Deterministic; the static-analysis `score`/`riskLevel` are inputs to the
 * review, not to this band.
 */
export function riskBandForFindings(findings: Array<{ severity: Severity }>): "high" | "medium" | "low" | "none" {
  if (findings.some(finding => finding.severity === "critical" || finding.severity === "high")) return "high";
  if (findings.some(finding => finding.severity === "medium")) return "medium";
  if (findings.length > 0) return "low";
  return "none";
}

export type StaticRiskCoverage = {
  /** Changed paths the deterministic stage actually scored. */
  readonly analyzedPaths?: readonly string[];
  /** Analyzed paths that had a usable baseline. */
  readonly baselinedPaths?: readonly string[];
  /** Added files that were not part of the baseline comparison. */
  readonly newFileCount?: number;
  /** Why nothing was analyzed, when the file list is not evidence of a clean review. */
  readonly notAnalyzedReason?: string;
  /** Every analyzed file lacked a baseline. A single new file is not enough. */
  readonly missingBaseline?: boolean;
};

function usableRiskFiles(files: readonly DomainFileResult[], analyzed?: ReadonlySet<string>): DomainFileResult[] {
  return files.filter(file => {
    if (analyzed && !analyzed.has(file.path)) return false;
    if (file.confidence === 0 && file.findings.length === 0 && Array.isArray(file.signals.steps) && file.signals.steps.length === 0) return false;
    if (/^(?:skipped|unsupported|failed|not analyzed)$/i.test(file.riskLabel.trim())) return false;
    return file.riskLabel.trim().length > 0 || file.findings.length > 0 || file.riskScore > 0;
  });
}

/**
 * Select the peak analyzed-file risk without treating an unanalyzed PR as clean.
 * No Baseline applies only when every analyzed file lacks a baseline. Mixed
 * additions keep the baselined peak and disclose the new-file count.
 */
export function staticRiskLabelForFiles(
  files: readonly DomainFileResult[],
  options?: StaticRiskCoverage
): string {
  const analyzed = options?.analyzedPaths ? new Set(options.analyzedPaths) : undefined;
  const usable = usableRiskFiles(files, analyzed);
  const placeholderBaseline = files.filter(file => file.riskLabel.includes("No Baseline") && file.findings.length === 0 && file.confidence === 0);
  if (usable.length === 0) {
    if (options?.missingBaseline || (files.length > 0 && placeholderBaseline.length === files.length)) return "No Baseline";
    const reason = options?.notAnalyzedReason ?? "deterministic analysis returned no scored files";
    return `Not Analyzed (${reason})`;
  }
  const baselined = options?.baselinedPaths
    ? usable.filter(file => options.baselinedPaths!.includes(file.path) && !file.riskLabel.includes("No Baseline"))
    : usable.filter(file => !file.riskLabel.includes("No Baseline"));
  const allMissing = options?.missingBaseline === true || (baselined.length === 0 && usable.every(file => file.riskLabel.includes("No Baseline")));
  const ranked = (allMissing ? usable : baselined.length > 0 ? baselined : usable)
    .slice()
    .sort((left, right) => right.riskScore - left.riskScore || left.path.localeCompare(right.path));
  const peak = ranked[0]!.riskLabel.trim() || (allMissing ? "No Baseline" : "Consistent");
  const labels = [peak];
  if (allMissing && !peak.includes("No Baseline")) labels.push("No Baseline");
  else if (!allMissing && (options?.newFileCount ?? 0) > 0) labels.push(`${options!.newFileCount} new file${options!.newFileCount === 1 ? "" : "s"}`);
  if (files.some(file => /\bskipped\b/i.test(file.riskLabel)) && !/\bskipped\b/i.test(labels.join(" "))) labels.push("skipped");
  return labels.filter(Boolean).join(" / ");
}

/** Both terminal and Markdown render the same static label, not a different band. */
export function staticRiskDisplayLabel(level: string, staticLabel?: string): string {
  return staticLabel ? staticLabel.replace(/\bskipped\b/gi, "Skipped") : level.toUpperCase();
}

export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type EvidencePack = z.infer<typeof evidencePackSchema>;
export type RetrievalTrace = z.infer<typeof retrievalTraceSchema>;
export type ReviewReport = z.infer<typeof reviewReportSchema>;

/**
 * Canonical risk band lower bounds, mirrored from the Python engine rule table
 * (`engine/models/enums.py` -> `RISK_BANDS`; specification:
 * `docs/risk-scoring-rules.md` §5, rule version `risk-rules/v3.1`).
 *
 * These values are the single source of truth for the tier boundaries on both
 * sides of the protocol. The cross-language parity test
 * `tests/test_scoring_rule_parity.py` parses this file and fails when either
 * side drifts, so do not re-declare the numbers anywhere else.
 */
export const CANONICAL_RISK_BAND_THRESHOLDS = {
  critical: 0.75,
  high: 0.5,
  medium: 0.25
} as const;

/**
 * `overall_score` is the engine's projection of the final risk:
 * `overall_score = round(100 * (1 - risk))`. A band whose risk lower bound is
 * `t` therefore starts at `100 * (1 - t)`.
 */
export const CANONICAL_OVERALL_SCORE_BOUNDS = {
  critical: 100 * (1 - CANONICAL_RISK_BAND_THRESHOLDS.critical),
  high: 100 * (1 - CANONICAL_RISK_BAND_THRESHOLDS.high),
  medium: 100 * (1 - CANONICAL_RISK_BAND_THRESHOLDS.medium)
} as const;

export function riskLevelForScore(score: number): RiskLevel {
  if (score <= CANONICAL_OVERALL_SCORE_BOUNDS.critical) return "critical";
  if (score <= CANONICAL_OVERALL_SCORE_BOUNDS.high) return "high";
  if (score <= CANONICAL_OVERALL_SCORE_BOUNDS.medium) return "medium";
  return "low";
}

export function parseReviewReport(input: unknown): ReviewReport {
  return reviewReportSchema.parse(input);
}
