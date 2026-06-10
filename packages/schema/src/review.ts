import { z } from "zod";

export const severitySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export const confidenceSchema = z.enum(["confirmed", "likely", "hypothesis"]);
export const agentStatusSchema = z.enum(["skipped", "running", "succeeded", "failed"]);
export const reviewAgentNameSchema = z.enum([
  "Planner",
  "Security",
  "Correctness",
  "Test",
  "Maintainability",
  "Style",
  "Synthesizer",
  "PythonCompatibilityAdapter"
]);

const nonEmpty = z.string().trim().min(1);
const positiveLine = z.number().int().positive();
const findingBase = z.object({
  id: nonEmpty,
  agent: reviewAgentNameSchema,
  title: nonEmpty,
  severity: severitySchema,
  evidence: nonEmpty,
  reasoning: nonEmpty,
  recommendation: nonEmpty,
  suggestedPatch: nonEmpty.optional(),
  tags: z.array(nonEmpty).optional()
});

const confirmedFindingSchema = findingBase.extend({
  confidence: z.literal("confirmed"),
  file: nonEmpty,
  startLine: positiveLine,
  endLine: positiveLine
}).strict();

const likelyFindingSchema = findingBase.extend({
  confidence: z.literal("likely"),
  file: nonEmpty,
  startLine: positiveLine.optional(),
  endLine: positiveLine.optional()
}).strict();

const hypothesisFindingSchema = findingBase.extend({
  confidence: z.literal("hypothesis"),
  file: nonEmpty,
  startLine: positiveLine.optional(),
  endLine: positiveLine.optional(),
  uncertainty: nonEmpty
}).strict();

export const reviewFindingSchema = z
  .discriminatedUnion("confidence", [confirmedFindingSchema, likelyFindingSchema, hypothesisFindingSchema])
  .superRefine((finding, context) => {
    const { startLine, endLine } = finding;
    const hasStart = startLine !== undefined;
    const hasEnd = endLine !== undefined;
    if (hasStart !== hasEnd) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "startLine and endLine must be provided together",
        path: hasStart ? ["endLine"] : ["startLine"]
      });
    }
    if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endLine must be greater than or equal to startLine",
        path: ["endLine"]
      });
    }
  });

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional()
}).strict();

export const agentRunSchema = z.object({
  id: nonEmpty,
  jobId: nonEmpty,
  agentName: reviewAgentNameSchema,
  status: agentStatusSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  inputSummary: nonEmpty,
  findings: z.array(reviewFindingSchema),
  error: nonEmpty.optional(),
  tokenUsage: tokenUsageSchema.optional()
}).strict();

export const reviewPlanSchema = z.object({
  enabledAgents: z.array(reviewAgentNameSchema),
  skippedAgents: z.array(reviewAgentNameSchema),
  riskAreas: z.array(nonEmpty),
  reason: nonEmpty
}).strict();

export type Severity = z.infer<typeof severitySchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type ReviewAgentName = z.infer<typeof reviewAgentNameSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
export type ReviewPlan = z.infer<typeof reviewPlanSchema>;
