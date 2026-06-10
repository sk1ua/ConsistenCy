import { z } from "zod";
import { agentRunSchema, reviewFindingSchema } from "./review";

export const riskLevelSchema = z.enum(["critical", "high", "medium", "low"]);

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
  createdAt: z.string().datetime()
}).strict();

export type RiskLevel = z.infer<typeof riskLevelSchema>;
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

