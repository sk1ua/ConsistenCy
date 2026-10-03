import { z } from "zod";

export const severitySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export const confidenceSchema = z.enum(["confirmed", "likely", "hypothesis"]);
export const agentStatusSchema = z.enum(["skipped", "running", "succeeded", "failed"]);
const reviewAgentNames = [
  "Planner",
  "Security",
  "Correctness",
  "Test",
  "Maintainability",
  "Style",
  "ArchitectureAuditor",
  "Consistency",
  "Synthesizer",
  "PythonCompatibilityAdapter",
  "DeterministicAnalyzer"
] as const;

/**
 * Default tool-schema enum. `Generalist` is absent so a closed switch cannot
 * change a specialist request. Report parsing accepts it only when asked.
 */
export const reviewAgentNameSchema = z.enum(reviewAgentNames);
export const reportAgentNameSchema = z.enum([...reviewAgentNames, "Generalist"]);
export function isReviewAgentName(agent: string): agent is z.infer<typeof reviewAgentNameSchema> {
  return (reviewAgentNames as readonly string[]).includes(agent);
}

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
  tags: z.array(nonEmpty).optional(),
  /**
   * Canonical v3 grounding: references into the Kernel EvidenceStore for the
   * run. OPTIONAL and additive — legacy findings without evidenceIds remain
   * valid during migration; the Review workload attaches and validates them.
   */
  evidenceIds: z.array(nonEmpty).optional(),
  /**
   * Why the finding is not certain.
   *
   * REQUIRED at `hypothesis`, where the prompt asks the model to explain its
   * doubt, and OPTIONAL elsewhere. Allowing it on every member is deliberate:
   * a model that labels a finding `likely` while also stating its uncertainty
   * was expressing doubt and mislabelling one field — discarding its whole
   * agent run over that is a worse trade than keeping the note. Observed with
   * `mimo-v2.6-flash`, which lost Maintainability (and degraded coverage) to
   * `findings[2].uncertainty` while five sibling agents passed.
   */
  uncertainty: nonEmpty.optional(),
  /**
   * The concrete input or scenario that fails — the prompt requires every
   * finding to name one, which is what separates a demonstrated defect from a
   * "please verify" suggestion. OPTIONAL and additive: legacy findings and
   * findings whose trigger is already spelled out in `evidence` stay valid.
   */
  trigger: nonEmpty.optional(),
  /**
   * Cited convention location. Optional on the wire; lean Consistency keeps a
   * finding only after this citation verifies against supplied code.
   */
  precedent: z.object({
    file: nonEmpty,
    line: positiveLine,
    quote: nonEmpty
  }).strict().optional(),
  /** Exact baseline proof, or an explicit causal explanation of an indirect regression. */
  baselineAssessment: z.discriminatedUnion("behaviorUnchanged", [
    z.object({
      baseStartLine: positiveLine,
      baseEndLine: positiveLine,
      behaviorUnchanged: z.literal(true),
      reason: nonEmpty
    }).strict(),
    z.object({
      baseStartLine: positiveLine.optional(),
      baseEndLine: positiveLine.optional(),
      behaviorUnchanged: z.literal(false),
      reason: nonEmpty
    }).strict()
  ]).optional(),
  /**
   * Specialists that reported the same location in different words and were
   * merged into this finding by deterministic line-range clustering. OPTIONAL
   * and additive: a finding that was never merged omits it, and merges that
   * only repeated the same wording stay disclosed through `duplicates`.
   */
  alsoReportedBy: z.array(reviewAgentNameSchema).optional(),
  /**
   * Items merged into this finding by deduplication, keeping their title and a summary point.
   */
  mergedFindings: z.array(z.object({
    agent: reviewAgentNameSchema.optional(),
    title: nonEmpty,
    summary: nonEmpty
  }).strict()).optional(),
  /**
   * Synthesizer-assigned relevance score, 0–10, and its one-sentence reason.
   * OPTIONAL and additive: a provider that ignores the scoring instruction
   * leaves them unset, and an unscored finding is never dropped on score.
   */
  score: z.number().int().min(0).max(10).optional(),
  scoreReason: nonEmpty.optional()
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
  uncertainty: nonEmpty.default("Hypothesis; the triggering scenario has not been verified.")
}).strict();

/**
 * Wire schema sent to specialists and the synthesizer. `source` and `support`
 * are host annotations, never model outputs, so they stay off this schema:
 * adding them here would change the tool schema of every request.
 */
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

/**
 * One synthesizer-assigned relevance score. The synthesizer already makes one
 * summary call per review; scoring rides on that call rather than adding a
 * second one.
 */
export const findingScoreSchema = z.object({
  id: nonEmpty,
  score: z.number().int().min(0).max(10),
  reason: nonEmpty
}).strict();
export type FindingScore = z.infer<typeof findingScoreSchema>;

/** Accept the legacy model spelling without weakening the canonical schema. */
export function normalizeFindingScore(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  if (!("scoreReason" in value)) return input;
  const { scoreReason, ...rest } = value;
  return { ...rest, reason: rest.reason ?? scoreReason };
}

export function recoverFindingScores(input: unknown): FindingScore[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap(entry => {
    const parsed = findingScoreSchema.safeParse(normalizeFindingScore(entry));
    return parsed.success ? [parsed.data] : [];
  });
}

const errorFindingScores = new WeakMap<object, readonly FindingScore[]>();

export function recordFindingScoresOnError(error: unknown, scores: readonly FindingScore[]): void {
  if (error !== null && typeof error === "object" && scores.length) errorFindingScores.set(error, scores);
}

export function findingScoresFromError(error: unknown): FindingScore[] {
  const seen = new Set<object>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const recorded = errorFindingScores.get(current);
    if (recorded) return [...recorded];
    if ("findingScores" in current) {
      const scores = recoverFindingScores(current.findingScores);
      if (scores.length) return scores;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return [];
}

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  cachedTokens: z.number().int().nonnegative().optional(),
  cacheReadStatus: z.enum(["reported", "unavailable_or_zero"]).optional(),
  /** Known counters exclude at least one attempt whose usage was not reported. */
  usageStatus: z.literal("partial").optional(),
  promptTokens: z.number().int().nonnegative().optional()
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
  tokenUsage: tokenUsageSchema.optional(),
  /** Pi catalog provider id ("mock" reserved for deterministic tests). */
  provider: z.string().trim().min(1).max(64).optional(),
  model: nonEmpty.optional()
}).strict();

export const reviewPlanSchema = z.object({
  enabledAgents: z.array(reviewAgentNameSchema),
  skippedAgents: z.array(reviewAgentNameSchema),
  riskAreas: z.array(nonEmpty),
  reason: nonEmpty,
  /**
   * Optional planner triage output: areas the review agents should focus on
   * first (typically product code over tests). Advisory only — agents may
   * still report any real finding outside these areas. Optional so plans
   * produced before this field existed keep parsing.
   */
  focusAreas: z
    .array(
      z
        .object({
          pathPattern: nonEmpty,
          guidance: nonEmpty
        })
        .strict()
    )
    .default([])
}).strict();

export type ReviewPlanFocusArea = {
  pathPattern: string;
  guidance: string;
};

export type Severity = z.infer<typeof severitySchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type ReviewAgentName = z.infer<typeof reviewAgentNameSchema>;
export type ReportAgentName = z.infer<typeof reportAgentNameSchema>;
/**
 * Host annotations written only when a lean opt-in produced them. They stay
 * off `reviewFindingSchema` so a closed switch cannot change a tool schema.
 * Zod omits an unset optional key, so a finding that never received them
 * stringifies exactly as before.
 */
export type ReviewFindingAttribution = {
  source?: "specialist" | "generalist";
  support?: number;
};

type WireFinding = z.infer<typeof reviewFindingSchema>;
type WidenAgent<T> = T extends unknown
  ? Omit<T, "agent"> & ReviewFindingAttribution & {
    agent: T extends { agent: infer Agent } ? Agent | "Generalist" : never;
  }
  : never;

export type ReviewFinding = WidenAgent<WireFinding>;

/** Drops host annotations so a model prompt cannot see sample support or source. */
export function findingForModel(finding: ReviewFinding): WireFinding {
  if (finding.source === undefined && finding.support === undefined && finding.agent !== "Generalist") {
    return finding as WireFinding;
  }
  const { source: _source, support: _support, agent, ...wire } = finding;
  return { ...wire, agent: agent === "Generalist" ? "Maintainability" : agent } as WireFinding;
}

const findingAttributionSchema = z.object({
  source: z.enum(["specialist", "generalist"]).optional(),
  support: z.number().int().positive().optional()
}).strict();

/**
 * Report persistence parser. `Generalist` is accepted only here; the tool
 * schema sent to specialists stays on `reviewAgentNameSchema`. Closed-switch
 * findings never carry source, support, or that agent, so their parsed shape
 * is unchanged.
 */
function withoutAttribution(value: Record<string, unknown>, agent: unknown): Record<string, unknown> {
  const { source: _source, support: _support, ...wire } = value;
  return agent === "Generalist" ? { ...wire, agent: "Maintainability" } : wire;
}

export function parseReportFinding(input: unknown): ReviewFinding {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return reviewFindingSchema.parse(input);
  }
  const value = input as Record<string, unknown>;
  const parsed = reviewFindingSchema.parse(withoutAttribution(value, value.agent));
  const attribution = findingAttributionSchema.parse({
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.support === undefined ? {} : { support: value.support })
  });
  const restored = value.agent === "Generalist" ? { ...parsed, agent: "Generalist" as const } : parsed;
  if (attribution.source === undefined && attribution.support === undefined) return restored;
  return { ...restored, ...attribution };
}

export const reportFindingSchema: z.ZodType<ReviewFinding, z.ZodTypeDef, unknown> = z.unknown().transform((value, context) => {
  try {
    return parseReportFinding(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      error.issues.forEach(issue => context.addIssue(issue));
      return z.NEVER;
    }
    throw error;
  }
});

export const reportAgentRunSchema = agentRunSchema.extend({
  agentName: z.union([reviewAgentNameSchema, z.literal("Generalist")]),
  findings: z.array(reportFindingSchema)
}).strict();

export type TokenUsage = z.infer<typeof tokenUsageSchema>;
type WireAgentRun = z.infer<typeof agentRunSchema>;
export type AgentRun = Omit<WireAgentRun, "agentName" | "findings"> & {
  agentName: WireAgentRun["agentName"] | "Generalist";
  findings: ReviewFinding[];
};
export type ReviewPlan = z.infer<typeof reviewPlanSchema>;
