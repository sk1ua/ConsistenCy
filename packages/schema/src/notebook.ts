import { z } from "zod";
import { tokenUsageSchema } from "./review";

export const notebookCardKindSchema = z.enum([
  "change_map",
  "architecture_impact",
  "risk_brief",
  "fix_plan"
]);

export const notebookMessageRoleSchema = z.enum(["user", "assistant", "system"]);
export const notebookMessageStatusSchema = z.enum(["pending", "streaming", "completed", "failed", "degraded"]);
export const notebookIndexStatusSchema = z.enum(["queued", "indexing", "ready", "failed"]);

export const notebookCitationSchema = z.object({
  id: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  pullRequestNumber: z.number().int().positive(),
  jobId: z.string().trim().min(1),
  headSha: z.string().trim().min(1),
  file: z.string().trim().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  excerpt: z.string().trim().min(1),
  kind: z.enum(["file", "diff", "evidence", "finding", "history"])
}).strict().superRefine((value, context) => {
  if (value.endLine < value.startLine) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endLine"], message: "endLine must be >= startLine" });
  }
});

export const notebookSourceSchema = z.object({
  id: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  pullRequestNumber: z.number().int().positive(),
  jobId: z.string().trim().min(1),
  baseSha: z.string().trim().min(1),
  headSha: z.string().trim().min(1),
  indexStatus: notebookIndexStatusSchema,
  indexedAt: z.string().datetime().optional(),
  error: z.string().trim().min(1).optional()
}).strict();

export const notebookMessageSchema = z.object({
  id: z.string().trim().min(1),
  notebookId: z.string().trim().min(1),
  role: notebookMessageRoleSchema,
  content: z.string(),
  status: notebookMessageStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  sourceJobIds: z.array(z.string().trim().min(1)),
  citations: z.array(notebookCitationSchema),
  provider: z.enum(["mock", "deepseek", "openai"]).optional(),
  model: z.string().trim().min(1).optional(),
  tokenUsage: tokenUsageSchema.optional(),
  error: z.string().trim().min(1).optional()
}).strict();

export const notebookCardSchema = z.object({
  id: z.string().trim().min(1),
  notebookId: z.string().trim().min(1),
  kind: notebookCardKindSchema,
  title: z.string().trim().min(1),
  content: z.string().trim().min(1),
  sourceJobIds: z.array(z.string().trim().min(1)),
  citations: z.array(notebookCitationSchema),
  status: z.enum(["generated", "degraded", "failed"]),
  createdAt: z.string().datetime(),
  provider: z.enum(["mock", "deepseek", "openai"]).optional(),
  model: z.string().trim().min(1).optional()
}).strict();

export const notebookSchema = z.object({
  id: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  sources: z.array(notebookSourceSchema),
  messages: z.array(notebookMessageSchema),
  cards: z.array(notebookCardSchema)
}).strict();

export type NotebookCardKind = z.infer<typeof notebookCardKindSchema>;
export type NotebookCitation = z.infer<typeof notebookCitationSchema>;
export type NotebookSource = z.infer<typeof notebookSourceSchema>;
export type NotebookMessage = z.infer<typeof notebookMessageSchema>;
export type NotebookCard = z.infer<typeof notebookCardSchema>;
export type Notebook = z.infer<typeof notebookSchema>;

export const llmStreamEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text_delta"), text: z.string() }).strict(),
  z.object({ kind: z.literal("tool_call"), tool: z.string().trim().min(1), input: z.unknown() }).strict(),
  z.object({ kind: z.literal("tool_result"), tool: z.string().trim().min(1), result: z.unknown() }).strict(),
  z.object({ kind: z.literal("citation"), citation: notebookCitationSchema }).strict(),
  z.object({ kind: z.literal("usage"), usage: tokenUsageSchema }).strict(),
  z.object({ kind: z.literal("completed") }).strict(),
  z.object({ kind: z.literal("failed"), error: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("degraded"), reason: z.string().trim().min(1) }).strict()
]);

export type LLMStreamEvent = z.infer<typeof llmStreamEventSchema>;
