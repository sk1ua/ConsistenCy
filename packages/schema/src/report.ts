import { z } from "zod";
import { agentRunSchema, reviewFindingSchema } from "./review";

export const riskLevelSchema = z.enum(["critical", "high", "medium", "low"]);
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

export const reviewReportSchema = z.object({
  jobId: z.string().trim().min(1),
  repositoryFullName: z.string().trim().min(1),
  pullRequestNumber: z.number().int().positive(),
  baseSha: z.string().trim().min(1),
  headSha: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  score: z.number().int().min(0).max(100),
  riskLevel: riskLevelSchema,
  agentRuns: z.array(agentRunSchema),
  findings: z.array(reviewFindingSchema),
  retrieval: retrievalTraceSchema.optional(),
  createdAt: z.string().datetime()
}).strict();

export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type EvidencePack = z.infer<typeof evidencePackSchema>;
export type RetrievalTrace = z.infer<typeof retrievalTraceSchema>;
export type ReviewReport = z.infer<typeof reviewReportSchema>;

export function riskLevelForScore(score: number): RiskLevel {
  if (score <= 39) return "critical";
  if (score <= 59) return "high";
  if (score <= 79) return "medium";
  return "low";
}

export function parseReviewReport(input: unknown): ReviewReport {
  return reviewReportSchema.parse(input);
}
