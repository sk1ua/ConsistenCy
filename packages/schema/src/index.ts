import analysisResultJsonSchema from "../../../schemas/analysis_result.schema.json" assert { type: "json" };
import prReportJsonSchema from "../../../schemas/pr_report.schema.json" assert { type: "json" };
import { z } from "zod";

const scoreSchema = z.number().min(0).max(1);
const stringListSchema = z.array(z.string());
const signalScoreMapSchema = z
  .object({
    style: z.number().optional(),
    structural: z.number().optional(),
    semantic: z.number().optional(),
    duplication: z.number().optional(),
    security: z.number().optional(),
    evolution: z.number().optional()
  })
  .catchall(z.number());

export const evidenceItemSchema = z
  .object({
    signal_name: z.string().min(1),
    text: z.string(),
    source: z.string().optional(),
    confidence: z.number().optional(),
    metadata: z.record(z.unknown()).optional()
  })
  .passthrough();

export const explainabilitySchema = z
  .object({
    dominant_signals: stringListSchema,
    contributions: signalScoreMapSchema,
    evidence_chain: z.array(evidenceItemSchema),
    confidence: scoreSchema,
    uncertainty_note: z.string().optional()
  })
  .passthrough();

export const agentCollaborationSchema = z
  .object({
    scope: z.string(),
    decision: z.string(),
    consensus_score: scoreSchema,
    confidence: scoreSchema,
    quorum: z.string(),
    participants: stringListSchema,
    protocol: z.string(),
    votes: z.array(z.record(z.unknown())).optional(),
    top_findings: z.array(z.record(z.unknown())).optional(),
    disagreements: stringListSchema.optional(),
    next_actions: stringListSchema.optional(),
    review_queue: z.array(z.record(z.unknown())).optional()
  })
  .passthrough();

export const analysisResultSchema = z
  .object({
    risk_score: scoreSchema,
    raw_score: scoreSchema,
    risk_level: z.string().min(1),
    risk_colour: z.string().min(1),
    breakdown: signalScoreMapSchema,
    signal_results: z.record(
      z
        .object({
          signal_name: z.string().min(1),
          score: scoreSchema,
          evidence: stringListSchema,
          confidence: scoreSchema,
          metadata: z.record(z.unknown())
        })
        .passthrough()
    ),
    signal_composition: signalScoreMapSchema,
    dominant_signals: stringListSchema,
    confidence: scoreSchema,
    explainability: explainabilitySchema,
    agent_collaboration: agentCollaborationSchema,
    evidence: stringListSchema,
    agent_details: z.record(z.record(z.unknown())),
    baseline_strategy: z.string().nullable().optional()
  })
  .passthrough();

export const commitEntrySchema = z
  .object({
    sha: z.string().min(1),
    date: z.string(),
    author: z.string(),
    message: z.string(),
    risk_score: scoreSchema,
    risk_level: z.string(),
    evolution_score: scoreSchema,
    evolution_details: z.record(z.unknown()),
    files_analyzed: z.number().int().nonnegative(),
    evolution_evidence: stringListSchema
  })
  .passthrough();

export const topRiskyFileSchema = z
  .object({
    file: z.string().min(1),
    avg_risk: scoreSchema,
    max_risk: scoreSchema,
    hits: z.number().int().nonnegative(),
    churn_lines: z.number().int().nonnegative(),
    complexity: z.number().nonnegative(),
    owner: z.string(),
    owner_share: scoreSchema,
    risk_breakdown: signalScoreMapSchema,
    signal_composition: signalScoreMapSchema,
    dominant_signals: stringListSchema,
    confidence: scoreSchema,
    rank_in_pr: z.number().int().positive(),
    total_pr_files: z.number().int().positive(),
    review_effort_min: z.number().int().nonnegative(),
    review_effort_max: z.number().int().nonnegative(),
    agent_collaboration: agentCollaborationSchema
  })
  .passthrough();

export const prReportSchema = z
  .object({
    base_ref: z.string(),
    head_ref: z.string(),
    commit_count: z.number().int().nonnegative(),
    avg_risk: scoreSchema,
    max_risk: scoreSchema,
    high_risk_commits: z.number().int().nonnegative(),
    commits: z.array(commitEntrySchema),
    commit_trend: z.array(z.record(z.unknown())),
    risk_composition: z.record(z.unknown()),
    evidence_summary: z.array(z.record(z.unknown())),
    top_risky_files: z.array(topRiskyFileSchema),
    file_deep_dive: z.array(z.record(z.unknown())),
    security_findings: z.array(z.record(z.unknown())),
    agent_collaboration: agentCollaborationSchema,
    code_snippets: z.array(z.record(z.unknown())),
    cache: z.record(z.number().int().nonnegative())
  })
  .passthrough();

export type AnalysisResult = z.infer<typeof analysisResultSchema>;
export type PRReport = z.infer<typeof prReportSchema>;

export const jsonSchemas = {
  analysisResult: analysisResultJsonSchema,
  prReport: prReportJsonSchema
} as const;

export function parseAnalysisResult(input: unknown): AnalysisResult {
  return analysisResultSchema.parse(input);
}

export function parsePRReport(input: unknown): PRReport {
  return prReportSchema.parse(input);
}
