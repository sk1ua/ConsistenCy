import { z } from "zod";
import { severitySchema } from "./review";
import { codeChangeEventSchema, diffHunkSchema, gitShaSchema, repoRefSchema } from "./vcs";

const nonEmpty = z.string().trim().min(1);
const nonNegativeInt = z.number().int().nonnegative();
const unitInterval = z.number().min(0).max(1);

export const heartbeatStateSchema = z.enum([
  "stopped",
  "idle",
  "scanning",
  "indexing",
  "degraded"
]);

/**
 * Daemon configuration. Filesystem watching is opt-in: the daemon reads a
 * developer's live working tree, so it stays off until explicitly enabled.
 */
export const heartbeatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  pulseIntervalMs: z.number().int().min(1_000).max(3_600_000).default(30_000),
  watchFilesystem: z.boolean().default(true),
  indexPath: nonEmpty.default(".consistency/knowledge_graph.sqlite"),
  maxIndexedFileBytes: z.number().int().positive().default(1_048_576)
}).strict();

export const repoHealthMetricsSchema = z.object({
  windowDays: z.number().int().positive(),
  /** Lines changed per day across the window. */
  churnRate: z.number().nonnegative(),
  riskIndex: unitInterval,
  /** Change in riskIndex versus the previous window; negative is improving. */
  riskIndexTrend: z.number().min(-1).max(1),
  /** Findings at `high` or above that remain unresolved. */
  unsettledSecurityDebt: nonNegativeInt,
  filesTracked: nonNegativeInt,
  computedAt: z.string().datetime()
}).strict();

export const heartbeatPulseSchema = z.object({
  pulseId: nonEmpty,
  state: heartbeatStateSchema,
  repository: repoRefSchema,
  observedAt: z.string().datetime(),
  dirtyFileCount: nonNegativeInt,
  pendingEvents: nonNegativeInt,
  lastIndexedSha: gitShaSchema.optional(),
  metrics: repoHealthMetricsSchema.optional(),
  lastError: nonEmpty.optional()
}).strict().superRefine((pulse, context) => {
  if (pulse.state === "degraded" && pulse.lastError === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A degraded pulse must report lastError",
      path: ["lastError"]
    });
  }
});

const pulseStreamEventSchema = z.object({
  event: z.literal("pulse"),
  pulse: heartbeatPulseSchema
}).strict();

const changeStreamEventSchema = z.object({
  event: z.literal("change"),
  change: codeChangeEventSchema
}).strict();

const indexProgressStreamEventSchema = z.object({
  event: z.literal("index_progress"),
  processed: nonNegativeInt,
  total: nonNegativeInt,
  currentPath: nonEmpty.optional()
}).strict();

const errorStreamEventSchema = z.object({
  event: z.literal("error"),
  message: nonEmpty,
  recoverable: z.boolean()
}).strict();

/** Payloads emitted by the `/api/v2/heartbeat/stream` SSE endpoint. */
export const heartbeatStreamEventSchema = z.discriminatedUnion("event", [
  pulseStreamEventSchema,
  changeStreamEventSchema,
  indexProgressStreamEventSchema,
  errorStreamEventSchema
]).superRefine((streamEvent, context) => {
  if (streamEvent.event === "index_progress" && streamEvent.processed > streamEvent.total) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "processed must not exceed total",
      path: ["processed"]
    });
  }
});

export const historicalFixSchema = z.object({
  reference: nonEmpty,
  file: nonEmpty,
  summary: nonEmpty,
  fixedAt: z.string().datetime(),
  severity: severitySchema.optional()
}).strict();

export const relatedModuleSchema = z.object({
  path: nonEmpty,
  relation: z.enum(["imports", "imported_by", "sibling", "test"]),
  weight: unitInterval
}).strict();

export const pastSecurityReportSchema = z.object({
  jobId: nonEmpty,
  file: nonEmpty,
  title: nonEmpty,
  severity: severitySchema,
  reportedAt: z.string().datetime(),
  resolved: z.boolean()
}).strict();

export const callerGraphEdgeSchema = z.object({
  callerFile: nonEmpty,
  callerSymbol: nonEmpty,
  calleeFile: nonEmpty,
  calleeSymbol: nonEmpty,
  depth: z.number().int().positive()
}).strict();

export const relevantContextQuerySchema = z.object({
  file: nonEmpty,
  hunk: diffHunkSchema.optional(),
  limit: z.number().int().positive().max(50).default(10)
}).strict();

/** Return shape of the context augmentation API consumed by LLM synthesis. */
export const relevantContextSchema = z.object({
  historicalFixes: z.array(historicalFixSchema).default([]),
  relatedModules: z.array(relatedModuleSchema).default([]),
  pastSecurityReports: z.array(pastSecurityReportSchema).default([]),
  callerGraph: z.array(callerGraphEdgeSchema).default([])
}).strict();

export type HeartbeatState = z.infer<typeof heartbeatStateSchema>;
export type HeartbeatConfig = z.infer<typeof heartbeatConfigSchema>;
export type RepoHealthMetrics = z.infer<typeof repoHealthMetricsSchema>;
export type HeartbeatPulse = z.infer<typeof heartbeatPulseSchema>;
export type HeartbeatStreamEvent = z.infer<typeof heartbeatStreamEventSchema>;
export type HistoricalFix = z.infer<typeof historicalFixSchema>;
export type RelatedModule = z.infer<typeof relatedModuleSchema>;
export type PastSecurityReport = z.infer<typeof pastSecurityReportSchema>;
export type CallerGraphEdge = z.infer<typeof callerGraphEdgeSchema>;
export type RelevantContextQuery = z.infer<typeof relevantContextQuerySchema>;
export type RelevantContext = z.infer<typeof relevantContextSchema>;
