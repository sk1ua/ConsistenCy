import { z } from "zod";
import { reviewReportSchema } from "./report";
import { confidenceSchema, severitySchema } from "./review";
import { heartbeatStateSchema, repoHealthMetricsSchema } from "./heartbeat";
import {
  sha256DigestSchema,
  stepIdSchema,
  stepKindSchema,
  stepStatusSchema,
  workflowEvidenceSchema,
  workflowSpecSchema
} from "./workflow";
import { vcsChangedFileSchema } from "./vcs";

const nonEmpty = z.string().trim().min(1);
const identifier = nonEmpty.max(200);
const timestamp = z.string().datetime();
const unitInterval = z.number().min(0).max(1);

function containsAbsolutePath(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return /^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|file:)/i.test(value);
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some(entry => containsAbsolutePath(entry, seen));
}

/** Public labels must never be used as a transport for a local absolute path. */
export const repositoryDisplayNameSchema = nonEmpty.max(200).superRefine((value, context) => {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|file:)/i.test(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Repository displayName must not be an absolute path"
    });
  }
});

export const repositoryRelativePathSchema = nonEmpty.max(4_096).superRefine((value, context) => {
  const normalized = value.replace(/\\/g, "/");
  if (/^(?:[A-Za-z]:\/|\/|file:)/i.test(normalized) || normalized.split("/").includes("..")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected a repository-relative path without traversal"
    });
  }
});

export const riskScoreSchema = z.number().min(0).max(100).describe(
  "Audit risk score where 0 is lowest risk and 100 is highest risk"
);

export const repositorySourceSchema = z.enum(["local_git", "github", "gitlab"]);
export const repositoryTrustLevelSchema = z.enum(["untrusted_readonly", "trusted_local"]);

/**
 * Renderer-safe repository DTO. The server-side checkout locator is
 * deliberately absent and must stay in the API persistence layer.
 */
export const repositorySchema = z.object({
  id: identifier,
  displayName: repositoryDisplayNameSchema,
  source: repositorySourceSchema,
  remoteFullName: nonEmpty.max(300).optional(),
  defaultBranch: nonEmpty.max(255).optional(),
  trustLevel: repositoryTrustLevelSchema,
  monitoringEnabled: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict().superRefine((repository, context) => {
  if (repository.source !== "local_git" && repository.remoteFullName === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["remoteFullName"],
      message: "A remote repository requires remoteFullName"
    });
  }
  if (repository.source !== "local_git" && repository.trustLevel !== "untrusted_readonly") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trustLevel"],
      message: "Remote repository code is always untrusted for execution"
    });
  }
});

export const createRepositoryRequestSchema = z.object({
  displayName: repositoryDisplayNameSchema,
  source: repositorySourceSchema,
  remoteFullName: nonEmpty.max(300).optional(),
  defaultBranch: nonEmpty.max(255).optional(),
  monitoringEnabled: z.boolean().default(false)
}).strict().superRefine((repository, context) => {
  if (repository.source !== "local_git" && repository.remoteFullName === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["remoteFullName"],
      message: "A remote repository requires remoteFullName"
    });
  }
});

/** Desktop-main-only request. This must never be used as a renderer response DTO. */
export const internalLocalRepositoryRegistrationRequestSchema = z.object({
  path: nonEmpty.max(4_096),
  displayName: repositoryDisplayNameSchema.optional(),
  monitoringEnabled: z.boolean().default(true)
}).strict();

/** Persisted renderer-safe pulse. The observed checkout root is deliberately omitted. */
export const repositoryPulseSchema = z.object({
  pulseId: identifier,
  repositoryId: identifier,
  state: heartbeatStateSchema,
  observedAt: timestamp,
  dirtyFileCount: z.number().int().nonnegative(),
  pendingEvents: z.number().int().nonnegative(),
  branch: nonEmpty.max(255).optional(),
  headRevision: nonEmpty.max(255).optional(),
  metrics: repoHealthMetricsSchema.optional(),
  lastError: nonEmpty.max(2_000).optional()
}).strict();

export const repositoryEventTypeSchema = z.enum([
  "working_tree",
  "commit_pushed",
  "branch_switched",
  "pull_request",
  "schedule",
  "manual"
]);
export const repositoryEventSourceSchema = z.enum(["local_git", "github", "gitlab", "scheduler", "user"]);

export const repositoryEventSchema = z.object({
  id: identifier,
  repositoryId: identifier,
  type: repositoryEventTypeSchema,
  source: repositoryEventSourceSchema,
  dedupeKey: nonEmpty.max(500),
  occurredAt: timestamp,
  baseRevision: nonEmpty.max(255).optional(),
  headRevision: nonEmpty.max(255).optional(),
  changedFiles: z.array(vcsChangedFileSchema).default([]),
  metadata: z.record(z.unknown()).default({})
}).strict().superRefine((event, context) => {
  event.changedFiles.forEach((file, index) => {
    const pathResult = repositoryRelativePathSchema.safeParse(file.path);
    if (!pathResult.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changedFiles", index, "path"],
        message: "Changed file paths must be repository-relative"
      });
    }
    if (file.previousPath !== undefined && !repositoryRelativePathSchema.safeParse(file.previousPath).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changedFiles", index, "previousPath"],
        message: "Previous file paths must be repository-relative"
      });
    }
  });
  if (containsAbsolutePath(event.metadata)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["metadata"],
      message: "Repository event metadata must not expose absolute paths"
    });
  }
});

export const workflowRevisionSchema = z.object({
  id: identifier,
  workflowId: identifier,
  revision: z.number().int().positive(),
  digest: sha256DigestSchema,
  spec: workflowSpecSchema,
  createdAt: timestamp
}).strict();

export const createWorkflowRevisionRequestSchema = z.object({
  workflowId: identifier,
  spec: workflowSpecSchema
}).strict();

export const policyOutcomeSchema = z.enum(["pass", "warn", "fail", "unknown"]);
export const policyEnforcementSchema = z.enum(["advisory", "blocking"]);

export const policyRevisionSchema = z.object({
  id: identifier,
  policyId: identifier,
  revision: z.number().int().positive(),
  name: nonEmpty.max(200),
  digest: sha256DigestSchema,
  requiredChecks: z.array(stepIdSchema).default([]),
  minimumCoverage: unitInterval.default(1),
  warnAtRiskScore: riskScoreSchema.default(40),
  failAtRiskScore: riskScoreSchema.default(70),
  enforcement: policyEnforcementSchema.default("advisory"),
  createdAt: timestamp
}).strict().superRefine((policy, context) => {
  if (policy.warnAtRiskScore > policy.failAtRiskScore) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["warnAtRiskScore"],
      message: "warnAtRiskScore must be less than or equal to failAtRiskScore"
    });
  }
  if (new Set(policy.requiredChecks).size !== policy.requiredChecks.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requiredChecks"],
      message: "requiredChecks must not contain duplicates"
    });
  }
});

export const createPolicyRevisionRequestSchema = z.object({
  policyId: identifier,
  name: nonEmpty.max(200),
  requiredChecks: z.array(stepIdSchema).default([]),
  minimumCoverage: unitInterval.default(1),
  warnAtRiskScore: riskScoreSchema.default(40),
  failAtRiskScore: riskScoreSchema.default(70),
  enforcement: policyEnforcementSchema.default("advisory")
}).strict().superRefine((policy, context) => {
  if (policy.warnAtRiskScore > policy.failAtRiskScore) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["warnAtRiskScore"],
      message: "warnAtRiskScore must be less than or equal to failAtRiskScore"
    });
  }
  if (new Set(policy.requiredChecks).size !== policy.requiredChecks.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requiredChecks"],
      message: "requiredChecks must not contain duplicates"
    });
  }
});

export const policyEvaluationSchema = z.object({
  outcome: policyOutcomeSchema,
  riskScore: riskScoreSchema,
  coverage: unitInterval,
  requiredChecks: z.array(stepIdSchema),
  completedChecks: z.array(stepIdSchema),
  missingRequiredChecks: z.array(stepIdSchema),
  reasons: z.array(nonEmpty)
}).strict().superRefine((evaluation, context) => {
  if (evaluation.missingRequiredChecks.length > 0 && evaluation.outcome !== "unknown") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome"],
      message: "Missing required checks force policy outcome to unknown"
    });
  }
});

export function evaluateAuditPolicy(
  policy: Pick<PolicyRevision, "requiredChecks" | "minimumCoverage" | "warnAtRiskScore" | "failAtRiskScore">,
  input: { riskScore: number; coverage: number; completedChecks: string[] }
): PolicyEvaluation {
  const completed = [...new Set(input.completedChecks)];
  const completedSet = new Set(completed);
  const missing = policy.requiredChecks.filter(check => !completedSet.has(check));
  const reasons: string[] = [];
  let outcome: PolicyOutcome;

  if (missing.length > 0 || input.coverage < policy.minimumCoverage) {
    outcome = "unknown";
    if (missing.length > 0) reasons.push(`Missing required checks: ${missing.join(", ")}`);
    if (input.coverage < policy.minimumCoverage) {
      reasons.push(`Coverage ${input.coverage} is below required ${policy.minimumCoverage}`);
    }
  } else if (input.riskScore >= policy.failAtRiskScore) {
    outcome = "fail";
    reasons.push(`Risk score ${input.riskScore} reached fail threshold ${policy.failAtRiskScore}`);
  } else if (input.riskScore >= policy.warnAtRiskScore) {
    outcome = "warn";
    reasons.push(`Risk score ${input.riskScore} reached warning threshold ${policy.warnAtRiskScore}`);
  } else {
    outcome = "pass";
    reasons.push(`Risk score ${input.riskScore} is below warning threshold ${policy.warnAtRiskScore}`);
  }

  return policyEvaluationSchema.parse({
    outcome,
    riskScore: input.riskScore,
    coverage: input.coverage,
    requiredChecks: policy.requiredChecks,
    completedChecks: completed,
    missingRequiredChecks: missing,
    reasons
  });
}

function isCronField(value: string, minimum: number, maximum: number): boolean {
  if (value.length === 0) return false;
  return value.split(",").every(segment => {
    const stepParts = segment.split("/");
    if (stepParts.length > 2) return false;
    const [base, rawStep] = stepParts;
    if (base === undefined || base.length === 0) return false;
    if (rawStep !== undefined) {
      const step = Number(rawStep);
      if (!/^\d+$/.test(rawStep) || !Number.isInteger(step) || step <= 0 || step > maximum - minimum + 1) {
        return false;
      }
    }
    if (base === "*") return true;
    const bounds = base.split("-");
    if (bounds.length > 2 || bounds.some(bound => !/^\d+$/.test(bound))) return false;
    const start = Number(bounds[0]);
    const end = Number(bounds.at(-1));
    return Number.isInteger(start)
      && Number.isInteger(end)
      && start >= minimum
      && start <= maximum
      && end >= minimum
      && end <= maximum
      && start <= end;
  });
}

export const cronExpressionSchema = nonEmpty.max(200).superRefine((value, context) => {
  const fields = value.split(/\s+/);
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
  if (fields.length !== ranges.length || fields.some((field, index) => {
    const range = ranges[index];
    return range === undefined || !isCronField(field, range[0], range[1]);
  })) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected a five-field numeric cron expression using *, lists, ranges, or steps"
    });
  }
});

export const ianaTimezoneSchema = nonEmpty.max(100).superRefine((value, context) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected a supported IANA timezone"
    });
  }
});

export const cronScheduleSpecSchema = z.object({
  type: z.literal("schedule").optional(),
  cron: cronExpressionSchema,
  timezone: ianaTimezoneSchema,
  missedRunPolicy: z.literal("skip").default("skip")
}).strict();

export const automationTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }).strict(),
  z.object({
    type: z.literal("repository_event"),
    eventTypes: z.array(repositoryEventTypeSchema).min(1),
    debounceMs: z.number().int().min(0).max(3_600_000).default(5_000)
  }).strict(),
  z.object({
    type: z.literal("schedule"),
    cron: nonEmpty.max(200),
    timezone: nonEmpty.max(100),
    missedRunPolicy: z.literal("skip").default("skip")
  }).strict()
]);

export const executionProfileSchema = z.enum(["static_readonly", "trusted_sandbox"]);

export const automationSchema = z.object({
  id: identifier,
  repositoryId: identifier,
  name: nonEmpty.max(200),
  trigger: automationTriggerSchema,
  workflowRevisionId: identifier,
  policyRevisionId: identifier,
  executionProfile: executionProfileSchema.default("static_readonly"),
  enabled: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();

export const createAutomationRequestSchema = automationSchema.omit({
  id: true,
  enabled: true,
  createdAt: true,
  updatedAt: true
}).extend({ enabled: z.boolean().default(true) }).strict().superRefine((automation, context) => {
  if (automation.trigger.type !== "schedule") return;
  const parsed = cronScheduleSpecSchema.safeParse(automation.trigger);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trigger", ...issue.path],
      message: issue.message
    });
  }
});

export const auditRunStatusSchema = z.enum([
  "created",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled"
]);
export const auditRunSourceSchema = z.enum(["manual", "repository_event", "schedule", "legacy_job"]);
export const auditPublicationStatusSchema = z.enum(["pending", "published", "failed", "skipped"]);

export const auditRunSchema = z.object({
  id: identifier,
  repositoryId: identifier,
  source: auditRunSourceSchema,
  sourceEventId: identifier.optional(),
  scheduledFor: timestamp.optional(),
  automationId: identifier.optional(),
  workflowRevisionId: identifier,
  policyRevisionId: identifier,
  executionProfile: executionProfileSchema,
  baseRevision: nonEmpty.max(255).optional(),
  headRevision: nonEmpty.max(255).optional(),
  status: auditRunStatusSchema,
  riskScore: riskScoreSchema.optional(),
  coverage: unitInterval.optional(),
  policyEvaluation: policyEvaluationSchema.optional(),
  publicationStatus: auditPublicationStatusSchema,
  createdAt: timestamp,
  startedAt: timestamp.optional(),
  finishedAt: timestamp.optional(),
  error: nonEmpty.optional()
}).strict();

export const createAuditRunRequestSchema = auditRunSchema.omit({
  id: true,
  status: true,
  riskScore: true,
  coverage: true,
  policyEvaluation: true,
  publicationStatus: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  error: true
}).extend({
  source: auditRunSourceSchema.default("manual"),
  executionProfile: executionProfileSchema.default("static_readonly")
}).strict();

export const auditRunPlanningTriggerSourceSchema = z.enum(["manual", "repository_event", "schedule"]);
export const auditRunPlanningReceiptDispositionSchema = z.enum(["created", "coalesced"]);
export const auditRunPlanningDispositionSchema = z.enum(["created", "coalesced", "deduplicated"]);
export const auditRunPlanningReasonSchema = z.enum(["new_draft", "active_run", "trigger_replay"]);

/** Internal transaction input. The planning key is safe to persist or return because it is a SHA-256 digest. */
export const planAuditRunDraftRequestSchema = z.object({
  planningKey: sha256DigestSchema,
  repositoryId: identifier,
  automationId: identifier,
  workflowRevisionId: identifier,
  workflowDigest: sha256DigestSchema,
  policyRevisionId: identifier,
  executionProfile: executionProfileSchema,
  source: auditRunPlanningTriggerSourceSchema,
  sourceEventId: identifier.optional(),
  scheduledFor: timestamp.optional(),
  baseRevision: nonEmpty.max(255).optional(),
  headRevision: nonEmpty.max(255).optional()
}).strict().superRefine((request, context) => {
  if (request.source === "repository_event" && request.sourceEventId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceEventId"],
      message: "Repository-event planning requires sourceEventId"
    });
  }
  if (request.source !== "repository_event" && request.sourceEventId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceEventId"],
      message: "Only repository-event planning may include sourceEventId"
    });
  }
  if (request.source === "schedule" && request.scheduledFor === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scheduledFor"],
      message: "Schedule planning requires scheduledFor"
    });
  }
  if (request.source !== "schedule" && request.scheduledFor !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scheduledFor"],
      message: "Only schedule planning may include scheduledFor"
    });
  }
});

export const auditRunPlanningReceiptSchema = z.object({
  id: identifier,
  planningKey: sha256DigestSchema,
  repositoryId: identifier,
  automationId: identifier,
  workflowDigest: sha256DigestSchema,
  source: auditRunPlanningTriggerSourceSchema,
  sourceEventId: identifier.optional(),
  scheduledFor: timestamp.optional(),
  auditRunId: identifier,
  disposition: auditRunPlanningReceiptDispositionSchema,
  createdAt: timestamp
}).strict().superRefine((receipt, context) => {
  if (receipt.source === "repository_event" && receipt.sourceEventId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceEventId"],
      message: "Repository-event receipt requires sourceEventId"
    });
  }
  if (receipt.source !== "repository_event" && receipt.sourceEventId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceEventId"],
      message: "Only repository-event receipt may include sourceEventId"
    });
  }
  if (receipt.source === "schedule" && receipt.scheduledFor === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scheduledFor"],
      message: "Schedule receipt requires scheduledFor"
    });
  }
  if (receipt.source !== "schedule" && receipt.scheduledFor !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scheduledFor"],
      message: "Only schedule receipt may include scheduledFor"
    });
  }
});

export const AUDIT_DRAFT_ONLY_EXECUTION_REASON =
  "Audit execution is unavailable; this request only planned a durable draft" as const;

export const auditRunPlanningResultSchema = z.object({
  disposition: auditRunPlanningDispositionSchema,
  reason: auditRunPlanningReasonSchema,
  receipt: auditRunPlanningReceiptSchema,
  auditRun: auditRunSchema,
  execution: z.object({
    available: z.literal(false),
    reason: z.literal(AUDIT_DRAFT_ONLY_EXECUTION_REASON)
  }).strict()
}).strict().superRefine((result, context) => {
  const expectedReason = result.disposition === "created"
    ? "new_draft"
    : result.disposition === "coalesced"
      ? "active_run"
      : "trigger_replay";
  if (result.reason !== expectedReason) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reason"],
      message: "Planning disposition and reason do not agree"
    });
  }
  if (result.disposition !== "deduplicated" && result.receipt.disposition !== result.disposition) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receipt", "disposition"],
      message: "Planning receipt does not record the returned disposition"
    });
  }
  if (
    result.receipt.auditRunId !== result.auditRun.id
    || result.receipt.repositoryId !== result.auditRun.repositoryId
    || result.receipt.automationId !== result.auditRun.automationId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receipt"],
      message: "Planning receipt does not reference the returned AuditRun"
    });
  }
});

export const repositoryEventPlanningResultSchema = z.object({
  eventId: identifier,
  matchedAutomationCount: z.number().int().nonnegative(),
  results: z.array(auditRunPlanningResultSchema)
}).strict().superRefine((result, context) => {
  if (result.matchedAutomationCount !== result.results.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["matchedAutomationCount"],
      message: "matchedAutomationCount must equal the number of planning results"
    });
  }
});

export const automationScheduleStateStatusSchema = z.enum(["scheduled", "invalid"]);
export const automationScheduleWindowOutcomeSchema = z.enum(["created", "coalesced", "skipped"]);
export const automationScheduleSkipReasonSchema = z.literal("missed_window_policy_skip");

export const automationScheduleStateSchema = z.object({
  automationId: identifier,
  cron: nonEmpty.max(200),
  timezone: nonEmpty.max(100),
  status: automationScheduleStateStatusSchema,
  nextScheduledAt: timestamp.optional(),
  lastScheduledFor: timestamp.optional(),
  lastOutcome: automationScheduleWindowOutcomeSchema.optional(),
  lastPlanningReceiptId: identifier.optional(),
  lastAuditRunId: identifier.optional(),
  error: nonEmpty.max(2_000).optional(),
  updatedAt: timestamp
}).strict().superRefine((state, context) => {
  if (state.status === "scheduled" && state.nextScheduledAt === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["nextScheduledAt"], message: "Scheduled state requires nextScheduledAt" });
  }
  if (state.status === "invalid" && state.error === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "Invalid state requires an error" });
  }
});

export const automationScheduleWindowSchema = z.object({
  id: identifier,
  automationId: identifier,
  scheduledFor: timestamp,
  outcome: automationScheduleWindowOutcomeSchema,
  planningReceiptId: identifier.optional(),
  auditRunId: identifier.optional(),
  reason: automationScheduleSkipReasonSchema.optional(),
  recordedAt: timestamp
}).strict().superRefine((window, context) => {
  if (window.outcome === "skipped") {
    if (window.reason === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Skipped window requires a reason" });
    }
    if (window.planningReceiptId !== undefined || window.auditRunId !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Skipped window must not reference a planned run" });
    }
  } else if (window.planningReceiptId === undefined || window.auditRunId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["planningReceiptId"], message: "Planned window requires receipt and run references" });
  }
});

export const runStepArtifactSchema = z.object({
  id: identifier,
  auditRunId: identifier,
  stepId: stepIdSchema,
  uses: stepKindSchema,
  status: stepStatusSchema,
  required: z.boolean(),
  inputDigest: sha256DigestSchema,
  toolVersion: nonEmpty.max(200).optional(),
  rulesetDigest: sha256DigestSchema.optional(),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  evidence: workflowEvidenceSchema.optional(),
  logSummary: z.string().max(20_000).optional(),
  skipReason: nonEmpty.optional(),
  error: nonEmpty.optional()
}).strict().superRefine((artifact, context) => {
  if (artifact.status === "skipped" && artifact.skipReason === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["skipReason"],
      message: "A skipped step must explain why it was skipped"
    });
  }
});

export const auditIssueStateSchema = z.enum([
  "open",
  "reviewing",
  "accepted_risk",
  "false_positive",
  "resolved"
]);
export const findingOccurrenceKindSchema = z.enum(["new", "existing", "resolved", "regressed"]);

export const auditLocationSchema = z.object({
  file: repositoryRelativePathSchema,
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional()
}).strict().superRefine((location, context) => {
  if ((location.startLine === undefined) !== (location.endLine === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Line bounds must be provided together" });
  }
  if (location.startLine !== undefined && location.endLine !== undefined && location.endLine < location.startLine) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endLine"], message: "endLine must be >= startLine" });
  }
});

export const auditIssueSchema = z.object({
  id: identifier,
  repositoryId: identifier,
  fingerprint: nonEmpty.max(500),
  ruleId: nonEmpty.max(300),
  title: nonEmpty.max(500),
  severity: severitySchema,
  confidence: confidenceSchema,
  state: auditIssueStateSchema,
  location: auditLocationSchema.optional(),
  evidenceSummary: nonEmpty.max(20_000),
  firstSeenRunId: identifier,
  lastSeenRunId: identifier,
  firstSeenAt: timestamp,
  lastSeenAt: timestamp,
  resolvedAt: timestamp.optional(),
  stateReason: nonEmpty.max(2_000).optional(),
  tags: z.array(nonEmpty.max(100)).default([])
}).strict();

export const createAuditIssueRequestSchema = auditIssueSchema.omit({
  id: true,
  state: true,
  firstSeenAt: true,
  lastSeenAt: true,
  resolvedAt: true,
  stateReason: true
}).extend({ tags: z.array(nonEmpty.max(100)).default([]) }).strict();

export const auditIssueActionSchema = z.enum([
  "review",
  "accept_risk",
  "mark_false_positive",
  "resolve",
  "reopen",
  // Compatibility aliases for the initial flat API skeleton.
  "acknowledge",
  "suppress"
]);
export const auditIssueActionRequestSchema = z.object({
  reason: nonEmpty.max(2_000).optional()
}).strict();

export const findingOccurrenceSchema = z.object({
  id: identifier,
  issueId: identifier,
  auditRunId: identifier,
  artifactId: identifier.optional(),
  kind: findingOccurrenceKindSchema,
  severity: severitySchema,
  confidence: confidenceSchema,
  location: auditLocationSchema.optional(),
  evidenceSummary: nonEmpty.max(20_000),
  observedAt: timestamp
}).strict();

export const evolutionMetricsSchema = z.object({
  churnRate: z.number().nonnegative(),
  hotspotCount: z.number().int().nonnegative(),
  ownershipRisk: unitInterval,
  dependencyCycleCount: z.number().int().nonnegative(),
  filesTracked: z.number().int().nonnegative()
}).strict();

export const evolutionSnapshotSchema = z.object({
  id: identifier,
  repositoryId: identifier,
  auditRunId: identifier.optional(),
  headRevision: nonEmpty.max(255),
  capturedAt: timestamp,
  riskScore: riskScoreSchema,
  previousRiskScore: riskScoreSchema.optional(),
  riskDelta: z.number().min(-100).max(100).optional(),
  metrics: evolutionMetricsSchema,
  changedComponents: z.array(z.object({
    name: nonEmpty.max(300),
    change: z.enum(["added", "modified", "removed"]),
    riskDelta: z.number().min(-100).max(100)
  }).strict()).default([])
}).strict();

export const auditReportV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: identifier,
  repository: repositorySchema,
  run: auditRunSchema,
  review: reviewReportSchema,
  workflowRevision: workflowRevisionSchema,
  artifacts: z.array(runStepArtifactSchema),
  policyEvaluation: policyEvaluationSchema,
  issueDelta: z.object({
    newIssueIds: z.array(identifier),
    existingIssueIds: z.array(identifier),
    resolvedIssueIds: z.array(identifier),
    regressedIssueIds: z.array(identifier)
  }).strict(),
  evolution: evolutionSnapshotSchema.optional(),
  createdAt: timestamp
}).strict().superRefine((report, context) => {
  if (report.repository.id !== report.run.repositoryId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["run", "repositoryId"], message: "Run repository does not match report repository" });
  }
  if (report.policyEvaluation.outcome !== report.run.policyEvaluation?.outcome) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["policyEvaluation"], message: "Report and run policy outcomes must match" });
  }
});

export const auditCapabilitiesSchema = z.object({
  domainVersion: z.literal(2),
  persistence: z.boolean(),
  repositoryRegistration: z.boolean(),
  localPathRegistration: z.literal(false),
  repositoryTimeline: z.boolean(),
  repositoryMetrics: z.boolean(),
  workflowValidation: z.literal(true),
  automationDefinitions: z.boolean(),
  automationScheduling: z.boolean(),
  automationHistory: z.boolean(),
  auditRunDrafts: z.boolean(),
  auditExecution: z.literal(false),
  auditRunArtifacts: z.boolean(),
  auditRunEvents: z.literal(false),
  auditReports: z.boolean(),
  auditExport: z.literal(false),
  issueTriage: z.boolean(),
  evolutionPersistence: z.boolean(),
  policyEvaluation: z.boolean()
}).strict();

export type Repository = z.infer<typeof repositorySchema>;
export type RepositoryTrustLevel = z.infer<typeof repositoryTrustLevelSchema>;
export type CreateRepositoryRequest = z.input<typeof createRepositoryRequestSchema>;
export type InternalLocalRepositoryRegistrationRequest = z.input<typeof internalLocalRepositoryRegistrationRequestSchema>;
export type RepositoryPulse = z.infer<typeof repositoryPulseSchema>;
export type RepositoryEvent = z.infer<typeof repositoryEventSchema>;
export type RepositoryEventType = z.infer<typeof repositoryEventTypeSchema>;
export type WorkflowRevision = z.infer<typeof workflowRevisionSchema>;
export type CreateWorkflowRevisionRequest = z.input<typeof createWorkflowRevisionRequestSchema>;
export type PolicyOutcome = z.infer<typeof policyOutcomeSchema>;
export type PolicyEvaluation = z.infer<typeof policyEvaluationSchema>;
export type PolicyRevision = z.infer<typeof policyRevisionSchema>;
export type CreatePolicyRevisionRequest = z.input<typeof createPolicyRevisionRequestSchema>;
export type Automation = z.infer<typeof automationSchema>;
export type CreateAutomationRequest = z.input<typeof createAutomationRequestSchema>;
export type AuditRun = z.infer<typeof auditRunSchema>;
export type CreateAuditRunRequest = z.input<typeof createAuditRunRequestSchema>;
export type PlanAuditRunDraftRequest = z.infer<typeof planAuditRunDraftRequestSchema>;
export type AuditRunPlanningReceipt = z.infer<typeof auditRunPlanningReceiptSchema>;
export type AuditRunPlanningResult = z.infer<typeof auditRunPlanningResultSchema>;
export type RepositoryEventPlanningResult = z.infer<typeof repositoryEventPlanningResultSchema>;
export type AutomationScheduleState = z.infer<typeof automationScheduleStateSchema>;
export type AutomationScheduleWindow = z.infer<typeof automationScheduleWindowSchema>;
export type RunStepArtifact = z.infer<typeof runStepArtifactSchema>;
export type AuditIssue = z.infer<typeof auditIssueSchema>;
export type CreateAuditIssueRequest = z.input<typeof createAuditIssueRequestSchema>;
export type AuditIssueAction = z.infer<typeof auditIssueActionSchema>;
export type FindingOccurrence = z.infer<typeof findingOccurrenceSchema>;
export type EvolutionSnapshot = z.infer<typeof evolutionSnapshotSchema>;
export type AuditReportV2 = z.infer<typeof auditReportV2Schema>;
export type AuditCapabilities = z.infer<typeof auditCapabilitiesSchema>;
