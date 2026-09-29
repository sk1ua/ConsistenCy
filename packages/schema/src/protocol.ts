import { z } from "zod";
import { workflowSpecSchema } from "./workflow";
import { retrievalTraceSchema, riskLevelSchema, type RetrievalTrace, type RiskLevel } from "./report";
import { workflowRunSchema } from "./workflow";
import { relevantContextSchema } from "./heartbeat";

const nonBlankStringSchema = z.string().refine(
  (value) => value.trim().length > 0,
  "Expected a non-blank string"
);

// Wire schemas (snake_case) matching Python stdio protocol
export const wireFileInputSchema = z.object({
  path: nonBlankStringSchema,
  content: z.string(),
  baseline: z.string().optional().nullable(),
  language: z.string().optional().nullable(),
  diff_hunks: z.array(z.string()).optional().nullable()
}).strict();

export const wireAnalyzeRequestSchema = z.object({
  id: nonBlankStringSchema,
  action: z.literal("analyze"),
  files: z.array(wireFileInputSchema),
  options: z.record(z.unknown()).optional()
}).strict();

export const wireComposeReviewFileSchema = z.object({
  path: nonBlankStringSchema,
  risk_score: z.number().min(0).max(1),
  findings: z.array(z.string())
}).strict();

export const wireComposeReviewRequestSchema = z.object({
  id: nonBlankStringSchema,
  action: z.literal("compose_review"),
  files: z.array(wireComposeReviewFileSchema),
  options: z.record(z.unknown()).optional()
}).strict();

export const wireRunWorkflowRequestSchema = z.object({
  id: nonBlankStringSchema,
  action: z.literal("run_workflow"),
  workflow: nonBlankStringSchema,
  /** Inline WorkflowSpec v2; when present the engine runs it instead of the named builtin. */
  spec: workflowSpecSchema.optional(),
  files: z.array(wireFileInputSchema),
  workspace_path: z.string().optional().nullable(),
  options: z.record(z.unknown()).optional()
}).strict();

export const wireRelevantContextRequestSchema = z.object({
  id: nonBlankStringSchema,
  action: z.literal("relevant_context"),
  files: z.array(wireFileInputSchema),
  targets: z.array(nonBlankStringSchema),
  index_path: z.string().optional().nullable(),
  options: z.record(z.unknown()).optional()
}).strict();

export const wireRecordReviewRequestSchema = z.object({
  id: nonBlankStringSchema,
  action: z.literal("record_review"),
  index_path: nonBlankStringSchema,
  job_id: nonBlankStringSchema,
  reference: nonBlankStringSchema,
  reported_at: nonBlankStringSchema,
  covered_files: z.array(nonBlankStringSchema),
  findings: z.array(z.object({
    file: nonBlankStringSchema,
    title: nonBlankStringSchema,
    severity: z.string()
  }).strict())
}).strict();

export const wireProtocolRequestSchema = z.discriminatedUnion("action", [
  wireAnalyzeRequestSchema,
  wireComposeReviewRequestSchema,
  wireRunWorkflowRequestSchema,
  wireRelevantContextRequestSchema,
  wireRecordReviewRequestSchema
]);

export const wireFileResultSchema = z.object({
  path: z.string(),
  risk_score: z.number().min(0).max(1),
  risk_label: z.string(),
  risk_color: z.string(),
  signals: z.record(z.unknown()),
  findings: z.array(z.string()),
  confidence: z.number(),
  breakdown: z.record(z.number()).optional().nullable(),
  agent_collaboration: z.record(z.unknown()).optional().nullable()
}).strict();

export const wireAnalyzeSuccessSchema = z.object({
  id: nonBlankStringSchema,
  ok: z.literal(true),
  files: z.array(wireFileResultSchema),
  consensus: z.record(z.unknown()).optional().nullable(),
  evidence_pack: retrievalTraceSchema.optional().nullable()
}).strict();

export const wireAnalyzeFailureSchema = z.object({
  id: nonBlankStringSchema,
  ok: z.literal(false),
  error: nonBlankStringSchema
}).strict();

export const wireAnalyzeResponseSchema = z.discriminatedUnion("ok", [
  wireAnalyzeSuccessSchema,
  wireAnalyzeFailureSchema
]);

export const wireComposeReviewSuccessSchema = z.object({
  id: nonBlankStringSchema,
  ok: z.literal(true),
  overall_score: z.number().int().min(0).max(100),
  risk_level: riskLevelSchema,
  summary: z.string(),
  recommendations: z.array(z.string())
}).strict();

export const wireComposeReviewFailureSchema = z.object({
  id: nonBlankStringSchema,
  ok: z.literal(false),
  error: nonBlankStringSchema
}).strict();

export const wireComposeReviewResponseSchema = z.discriminatedUnion("ok", [
  wireComposeReviewSuccessSchema,
  wireComposeReviewFailureSchema
]);

export const wireRunWorkflowSuccessSchema = z.object({
  id: nonBlankStringSchema,
  ok: z.literal(true),
  run: workflowRunSchema
}).strict();

export const wireRunWorkflowFailureSchema = z.object({
  id: nonBlankStringSchema,
  ok: z.literal(false),
  error: nonBlankStringSchema
}).strict();

export const wireRunWorkflowResponseSchema = z.discriminatedUnion("ok", [
  wireRunWorkflowSuccessSchema,
  wireRunWorkflowFailureSchema
]);

export const wireRelevantContextSuccessSchema = z.object({
  id: nonBlankStringSchema,
  ok: z.literal(true),
  contexts: z.record(relevantContextSchema)
}).strict();

export const wireRelevantContextFailureSchema = z.object({
  id: nonBlankStringSchema,
  ok: z.literal(false),
  error: nonBlankStringSchema
}).strict();

export const wireRelevantContextResponseSchema = z.discriminatedUnion("ok", [
  wireRelevantContextSuccessSchema,
  wireRelevantContextFailureSchema
]);

export const wireRecordReviewResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    id: nonBlankStringSchema,
    ok: z.literal(true),
    recorded: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative()
  }).strict(),
  z.object({
    id: nonBlankStringSchema,
    ok: z.literal(false),
    error: nonBlankStringSchema
  }).strict()
]);

export const wireGenericResponseSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().optional().nullable()
}).passthrough();

// Domain interfaces (camelCase)
export interface DomainFileResult {
  path: string;
  riskScore: number;
  riskLabel: string;
  riskColor: string;
  signals: Record<string, unknown>;
  findings: string[];
  confidence: number;
  breakdown?: Record<string, number>;
  agentCollaboration?: Record<string, unknown>;
}

export interface DomainAnalyzeSuccess {
  id: string;
  ok: true;
  files: DomainFileResult[];
  consensus?: Record<string, unknown>;
  evidencePack?: RetrievalTrace;
}

export interface DomainAnalyzeFailure {
  id: string;
  ok: false;
  error: string;
}

export type DomainAnalyzeResponse = DomainAnalyzeSuccess | DomainAnalyzeFailure;

export interface DomainComposeReviewSuccess {
  id: string;
  ok: true;
  overallScore: number;
  riskLevel: RiskLevel;
  summary: string;
  recommendations: string[];
}

export interface DomainComposeReviewFailure {
  id: string;
  ok: false;
  error: string;
}

export type DomainComposeReviewResponse = DomainComposeReviewSuccess | DomainComposeReviewFailure;

export type WireAnalyzeResponse = z.infer<typeof wireAnalyzeResponseSchema>;
export type WireComposeReviewResponse = z.infer<typeof wireComposeReviewResponseSchema>;
export type WireFileInput = z.infer<typeof wireFileInputSchema>;
export type WireAnalyzeRequest = z.infer<typeof wireAnalyzeRequestSchema>;
export type WireComposeReviewFile = z.infer<typeof wireComposeReviewFileSchema>;
export type WireComposeReviewRequest = z.infer<typeof wireComposeReviewRequestSchema>;
export type WireRunWorkflowRequest = z.infer<typeof wireRunWorkflowRequestSchema>;
export type WireRunWorkflowResponse = z.infer<typeof wireRunWorkflowResponseSchema>;
export type WireRelevantContextRequest = z.infer<typeof wireRelevantContextRequestSchema>;
export type WireRelevantContextResponse = z.infer<typeof wireRelevantContextResponseSchema>;

// Transformation functions (snake_case -> camelCase)
export function transformAnalyzeResponse(wire: WireAnalyzeResponse): DomainAnalyzeResponse {
  if (!wire.ok) {
    return {
      id: wire.id,
      ok: false,
      error: wire.error
    };
  }
  return {
    id: wire.id,
    ok: true,
    files: wire.files.map((file) => ({
      path: file.path,
      riskScore: file.risk_score,
      riskLabel: file.risk_label,
      riskColor: file.risk_color,
      signals: file.signals,
      findings: file.findings,
      confidence: file.confidence,
      breakdown: file.breakdown ?? undefined,
      agentCollaboration: file.agent_collaboration ?? undefined
    })),
    consensus: wire.consensus ?? undefined,
    evidencePack: wire.evidence_pack ?? undefined
  };
}

export function transformComposeReviewResponse(wire: WireComposeReviewResponse): DomainComposeReviewResponse {
  if (!wire.ok) {
    return {
      id: wire.id,
      ok: false,
      error: wire.error
    };
  }
  return {
    id: wire.id,
    ok: true,
    overallScore: wire.overall_score,
    riskLevel: wire.risk_level,
    summary: wire.summary,
    recommendations: wire.recommendations
  };
}

export function parseWireAnalyzeResponse(data: unknown): DomainAnalyzeResponse {
  const parsed = wireAnalyzeResponseSchema.parse(data);
  return transformAnalyzeResponse(parsed);
}

export function parseWireComposeReviewResponse(data: unknown): DomainComposeReviewResponse {
  const parsed = wireComposeReviewResponseSchema.parse(data);
  return transformComposeReviewResponse(parsed);
}
