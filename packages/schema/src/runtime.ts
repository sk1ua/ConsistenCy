import { z } from "zod";

export const securityGuaranteesSchema = z.object({
  processMemoryIsolation: z.enum(["enforced", "not-enforced"]),
  parentEnvSecretIsolation: z.enum(["enforced", "not-enforced"]),
  kernelRpcAuthorization: z.enum(["enforced", "not-enforced"]),
  filesystemOsContainment: z.enum(["enforced", "not-enforced", "partial"]),
  networkOsContainment: z.enum(["enforced", "not-enforced", "partial"]),
  subprocessOsContainment: z.enum(["enforced", "not-enforced", "partial"]),
});
export type SecurityGuarantees = z.infer<typeof securityGuaranteesSchema>;

/**
 * Honest floor for runs with no enforcement evidence: nothing is claimed as
 * enforced until the snapshot builder DERIVES guarantees from the run's real
 * execution domains and sandbox sessions (audit P1-08). In-process agents
 * share host memory, environment, and direct (non-RPC) syscalls, so the
 * isolation flags are "not-enforced" until a sandboxed execution domain
 * proves otherwise.
 */
export const DEFAULT_SECURITY_GUARANTEES: SecurityGuarantees = Object.freeze({
  processMemoryIsolation: "not-enforced",
  parentEnvSecretIsolation: "not-enforced",
  kernelRpcAuthorization: "not-enforced",
  filesystemOsContainment: "not-enforced",
  networkOsContainment: "not-enforced",
  subprocessOsContainment: "not-enforced",
});

export const capabilityScopeSnapshotSchema = z.object({
  sha: z.string().optional(),
  paths: z.array(z.string()).optional(),
});
export type CapabilityScopeSnapshot = z.infer<typeof capabilityScopeSnapshotSchema>;

export const capabilityDescriptorSnapshotSchema = z.object({
  action: z.string(),
  resourceKind: z.string(),
  resourceId: z.string().optional(),
  handleFingerprint: z.string(),
  revoked: z.boolean().optional(),
  scope: capabilityScopeSnapshotSchema.optional(),
  expiresAt: z.number().optional(),
});
export type CapabilityDescriptorSnapshot = z.infer<typeof capabilityDescriptorSnapshotSchema>;

export const contextPageMetadataSnapshotSchema = z.object({
  pageId: z.string(),
  kind: z.string(),
  residency: z.string(),
  estimatedTokens: z.number(),
  contentHash: z.string(),
  sourceRef: z.string().optional(),
});
export type ContextPageMetadataSnapshot = z.infer<typeof contextPageMetadataSnapshotSchema>;

export const contextVMRuntimeSnapshotSchema = z.object({
  baseContextImageId: z.string().optional(),
  workingSetTokens: z.number(),
  workingSetPageCount: z.number(),
  pageCountsByKind: z.record(z.string(), z.number()),
  pageCountsByResidency: z.record(z.string(), z.number()),
  pages: z.array(contextPageMetadataSnapshotSchema),
});
export type ContextVMRuntimeSnapshot = z.infer<typeof contextVMRuntimeSnapshotSchema>;

export const sandboxSessionRuntimeSnapshotSchema = z.object({
  sessionId: z.string(),
  state: z.string(),
  pid: z.number().optional(),
  pluginId: z.string(),
  pluginVersion: z.string(),
  executionDomain: z.literal("child-process"),
  terminationReason: z.string().optional(),
  protocolVersion: z.number(),
  errorCode: z.string().optional(),
  diagnostics: z.string().optional(),
});
export type SandboxSessionRuntimeSnapshot = z.infer<typeof sandboxSessionRuntimeSnapshotSchema>;

export const pendingOperationSnapshotSchema = z.object({
  kind: z.enum(["llm", "tool", "io", "agent", "human"]),
  description: z.string(),
  startedAt: z.number(),
});
export type PendingOperationSnapshot = z.infer<typeof pendingOperationSnapshotSchema>;

export const agentBudgetSnapshotSchema = z.object({
  tokenBudget: z.number().optional(),
  costBudgetUsdMicros: z.string().optional(),
  wallTimeBudgetMs: z.number().optional(),
});
export type AgentBudgetSnapshot = z.infer<typeof agentBudgetSnapshotSchema>;

export const agentRuntimeSnapshotSchema = z.object({
  agentId: z.string(),
  label: z.string(),
  state: z.string(),
  priority: z.number(),
  parent: z.string().optional(),
  children: z.array(z.string()),
  logicalRing: z.number(),
  executionDomain: z.enum(["in-process", "worker-thread", "child-process"]),
  pendingOperation: pendingOperationSnapshotSchema.optional(),
  deadline: z.number().optional(),
  createdAt: z.number(),
  contextImageId: z.string().optional(),
  capabilities: z.array(capabilityDescriptorSnapshotSchema),
  budgets: agentBudgetSnapshotSchema.optional(),
  sandbox: sandboxSessionRuntimeSnapshotSchema.optional(),
});
export type AgentRuntimeSnapshot = z.infer<typeof agentRuntimeSnapshotSchema>;

export const runAgentCountsSchema = z.object({
  total: z.number(),
  running: z.number(),
  waiting: z.number(),
  terminal: z.number(),
});
export type RunAgentCounts = z.infer<typeof runAgentCountsSchema>;

const nonEmpty = z.string().trim().min(1);

/**
 * Structured Execution Lifecycle States.
 *
 * Reconciles heterogeneous run/job/step statuses across Kernel, Cordis Harness,
 * and Review/Audit pipelines into a single canonical state machine.
 */
export const executionLifecycleStateSchema = z.enum([
  "queued",
  "running",
  "awaiting_input",
  "succeeded",
  "failed",
  "cancelled",
  "degraded",
]);
export type ExecutionLifecycleState = z.infer<typeof executionLifecycleStateSchema>;

/**
 * Standard Terminal Reason enumeration.
 * Explicitly records why an execution concluded when reaching a terminal state.
 */
export const terminalReasonSchema = z.enum([
  "completed",
  "user_cancelled",
  "timeout",
  "quota_exceeded",
  "fatal_error",
  "degraded_coverage",
  /**
   * The executing process died (API restart / crash) before the run reached a
   * terminal state. NEVER the same fact as `fatal_error`: nothing failed, the
   * run was cut off, and its durable facts are recovered explicitly.
   */
  "interrupted",
  /**
   * The run's reusable result could not be durably recorded (e.g. a completed
   * paid step whose checkpoint write failed). The run degrades with this
   * reason instead of claiming it can safely continue.
   */
  "result_unavailable",
]);
export type TerminalReason = z.infer<typeof terminalReasonSchema>;

export const runRuntimeSnapshotSchema = z.object({
  runId: z.string(),
  workloadKind: z.string(),
  jobId: z.string().optional(),
  state: z.string(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  deadline: z.number().optional(),
  agentCounts: runAgentCountsSchema,
  concurrency: z.number(),
  telemetryStatus: z.enum(["live", "completed", "unavailable"]),
  securityGuarantees: securityGuaranteesSchema,
  agents: z.array(agentRuntimeSnapshotSchema),
  context: contextVMRuntimeSnapshotSchema.optional(),
  correlationId: z.string().optional(),
  lifecycleState: executionLifecycleStateSchema.optional(),
  terminalReason: terminalReasonSchema.optional(),
});
export type RunRuntimeSnapshot = z.infer<typeof runRuntimeSnapshotSchema>;

export const runtimeRunSummarySchema = z.object({
  runId: z.string(),
  workloadKind: z.string(),
  jobId: z.string().optional(),
  state: z.string(),
  createdAt: z.string(),
  telemetryStatus: z.enum(["live", "completed", "unavailable"]),
  agentCounts: runAgentCountsSchema,
  correlationId: z.string().optional(),
  lifecycleState: executionLifecycleStateSchema.optional(),
  terminalReason: terminalReasonSchema.optional(),
});
export type RuntimeRunSummary = z.infer<typeof runtimeRunSummarySchema>;

export const runtimeRunsResponseSchema = z.object({
  runs: z.array(runtimeRunSummarySchema),
});
export type RuntimeRunsResponse = z.infer<typeof runtimeRunsResponseSchema>;

// ---------------------------------------------------------------------------
// Unified Execution Lifecycle Protocol & Persisted Provenance Contract
// ---------------------------------------------------------------------------

export const EXECUTION_LIFECYCLE_STATES: readonly ExecutionLifecycleState[] = Object.freeze([
  "queued",
  "running",
  "awaiting_input",
  "succeeded",
  "failed",
  "cancelled",
  "degraded",
]);

export const TERMINAL_EXECUTION_LIFECYCLE_STATES: readonly ExecutionLifecycleState[] = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
  "degraded",
]);

export function isTerminalExecutionLifecycleState(state: ExecutionLifecycleState): boolean {
  return (TERMINAL_EXECUTION_LIFECYCLE_STATES as readonly string[]).includes(state);
}

export const TERMINAL_REASONS: readonly TerminalReason[] = Object.freeze([
  "completed",
  "user_cancelled",
  "timeout",
  "quota_exceeded",
  "fatal_error",
  "degraded_coverage",
  "interrupted",
  "result_unavailable",
]);

/**
 * Terminal reasons the pre-0028 SQLite CHECK constraint on
 * `workflow_runtime_runs.terminal_reason` already accepts. Reasons outside this
 * list are persisted in the companion `terminal_detail` column (migration
 * 0028) and the read path is `terminal_detail ?? terminal_reason` — the column
 * is never forced to a false legacy value.
 */
export const LEGACY_TERMINAL_REASONS: readonly TerminalReason[] = Object.freeze([
  "completed",
  "user_cancelled",
  "timeout",
  "quota_exceeded",
  "fatal_error",
  "degraded_coverage",
]);

export function isLegacyTerminalReason(reason: TerminalReason): boolean {
  return (LEGACY_TERMINAL_REASONS as readonly string[]).includes(reason);
}

export function isTerminalReason(reason: string): reason is TerminalReason {
  return (TERMINAL_REASONS as readonly string[]).includes(reason);
}

/**
 * Deterministic default terminal reason for each terminal lifecycle state.
 */
export function defaultTerminalReasonForState(
  state: ExecutionLifecycleState,
): TerminalReason | undefined {
  switch (state) {
    case "succeeded":
      return "completed";
    case "cancelled":
      return "user_cancelled";
    case "failed":
      return "fatal_error";
    case "degraded":
      return "degraded_coverage";
    default:
      return undefined;
  }
}

/** Coarse run status vocabulary (mirrors the persisted run `status` column). */
export type RunTerminalStatus = "succeeded" | "failed";

/**
 * Authoritative projection of a terminal (lifecycleState, terminalReason) pair
 * onto everything that must agree about it:
 *   - the coarse `status` column of the run row,
 *   - the refined `lifecycle_state` / `terminal_reason` it is stored beside,
 *   - the run-level ledger event type (`run_succeeded` / `run_failed`).
 *
 * THIS is the single mapping: the host writes the run row and the event from it
 * in ONE transaction, the API run DTO / event page read the persisted values
 * back through it, and the timeline projection renders the same object. There
 * is deliberately no second switch anywhere — a divergence between the run row
 * and the event is impossible by construction.
 */
export interface RunTerminalProjection {
  readonly status: RunTerminalStatus;
  readonly lifecycleState: ExecutionLifecycleState;
  readonly terminalReason: TerminalReason;
  readonly eventType: "run_succeeded" | "run_failed";
}

export function projectRunTerminal(input: {
  readonly lifecycleState: ExecutionLifecycleState;
  readonly terminalReason?: TerminalReason;
}): RunTerminalProjection {
  const reason = input.terminalReason ?? defaultTerminalReasonForState(input.lifecycleState);
  switch (input.lifecycleState) {
    case "succeeded":
      if (reason !== undefined && reason !== "completed") {
        throw new Error(`terminal reason '${reason}' contradicts lifecycle state 'succeeded'`);
      }
      return { status: "succeeded", lifecycleState: "succeeded", terminalReason: "completed", eventType: "run_succeeded" };
    case "failed":
      return { status: "failed", lifecycleState: "failed", terminalReason: reason ?? "fatal_error", eventType: "run_failed" };
    case "cancelled":
      return { status: "failed", lifecycleState: "cancelled", terminalReason: reason ?? "user_cancelled", eventType: "run_failed" };
    case "degraded":
      return { status: "failed", lifecycleState: "degraded", terminalReason: reason ?? "degraded_coverage", eventType: "run_failed" };
    default:
      throw new Error(
        `lifecycle state '${input.lifecycleState}' is not terminal; a run-terminal projection requires a terminal state`,
      );
  }
}

/**
 * Canonical state transition matrix for ExecutionLifecycleState.
 * Terminal states (succeeded, failed, cancelled, degraded) cannot be transitioned out of.
 */
export const EXECUTION_LIFECYCLE_TRANSITIONS: Readonly<
  Record<ExecutionLifecycleState, readonly ExecutionLifecycleState[]>
> = Object.freeze({
  queued: ["running", "cancelled"],
  running: ["awaiting_input", "succeeded", "failed", "cancelled", "degraded"],
  awaiting_input: ["running", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  degraded: [],
});

export function canTransitionExecutionLifecycle(
  from: ExecutionLifecycleState,
  to: ExecutionLifecycleState,
): boolean {
  return EXECUTION_LIFECYCLE_TRANSITIONS[from].includes(to);
}

/**
 * Normalizes any legacy or external status string into canonical ExecutionLifecycleState.
 */
export function toExecutionLifecycleState(rawStatus: string): ExecutionLifecycleState {
  const normalized = rawStatus.toLowerCase().trim();
  switch (normalized) {
    case "queued":
    case "created":
    case "pending":
      return "queued";
    case "running":
    case "active":
    case "publishing":
      return "running";
    case "awaiting_input":
    case "awaiting_publish":
    case "suspended":
      return "awaiting_input";
    case "succeeded":
    case "published":
    case "pass":
      return "succeeded";
    case "failed":
    case "publish_failed":
    case "fail":
    case "error":
    case "errored":
      return "failed";
    case "cancelled":
    case "skipped":
      return "cancelled";
    case "degraded":
    case "timed_out":
    case "warn":
      return "degraded";
    default:
      throw new Error(`Cannot map unknown status '${rawStatus}' to ExecutionLifecycleState`);
  }
}

/**
 * Safely parse or map a status string into ExecutionLifecycleState, returning undefined on unrecognized input.
 */
export function tryToExecutionLifecycleState(rawStatus: string): ExecutionLifecycleState | undefined {
  try {
    return toExecutionLifecycleState(rawStatus);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Run, Step, and Attempt Provenance Trace Contracts
// ---------------------------------------------------------------------------

/**
 * Unified execution trace context for distributed provenance across runs, steps, and attempts.
 */
export const executionTraceContextSchema = z.object({
  correlationId: nonEmpty,
  runId: nonEmpty,
  stepId: nonEmpty.optional(),
  attemptNumber: z.number().int().positive().optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
}).strict().superRefine((ctx, issues) => {
  if (ctx.finishedAt !== undefined && ctx.finishedAt < ctx.startedAt) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: "finishedAt must not be earlier than startedAt",
      path: ["finishedAt"],
    });
  }
});
export type ExecutionTraceContext = z.infer<typeof executionTraceContextSchema>;

/**
 * Run-level provenance trace interface.
 */
export const runExecutionTraceSchema = z.object({
  correlationId: nonEmpty,
  runId: nonEmpty,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
}).strict().superRefine((ctx, issues) => {
  if (ctx.finishedAt !== undefined && ctx.finishedAt < ctx.startedAt) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: "finishedAt must not be earlier than startedAt",
      path: ["finishedAt"],
    });
  }
});
export type RunExecutionTrace = z.infer<typeof runExecutionTraceSchema>;

/**
 * Step-level provenance trace interface.
 */
export const stepExecutionTraceSchema = z.object({
  correlationId: nonEmpty,
  runId: nonEmpty,
  stepId: nonEmpty,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
}).strict().superRefine((ctx, issues) => {
  if (ctx.finishedAt !== undefined && ctx.finishedAt < ctx.startedAt) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: "finishedAt must not be earlier than startedAt",
      path: ["finishedAt"],
    });
  }
});
export type StepExecutionTrace = z.infer<typeof stepExecutionTraceSchema>;

/**
 * Attempt-level provenance trace interface.
 */
export const attemptExecutionTraceSchema = z.object({
  correlationId: nonEmpty,
  runId: nonEmpty,
  stepId: nonEmpty,
  attemptNumber: z.number().int().positive(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
}).strict().superRefine((ctx, issues) => {
  if (ctx.finishedAt !== undefined && ctx.finishedAt < ctx.startedAt) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: "finishedAt must not be earlier than startedAt",
      path: ["finishedAt"],
    });
  }
});
export type AttemptExecutionTrace = z.infer<typeof attemptExecutionTraceSchema>;

/**
 * Full Run-level execution record with lifecycle state, terminal reason, and provenance trace.
 */
export const executionRunRecordSchema = z.object({
  correlationId: nonEmpty,
  runId: nonEmpty,
  lifecycleState: executionLifecycleStateSchema,
  terminalReason: terminalReasonSchema.optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
}).strict().superRefine((rec, issues) => {
  if (rec.finishedAt !== undefined && rec.finishedAt < rec.startedAt) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: "finishedAt must not be earlier than startedAt",
      path: ["finishedAt"],
    });
  }
});
export type ExecutionRunRecord = z.infer<typeof executionRunRecordSchema>;

/**
 * Full Step-level execution record with lifecycle state, terminal reason, and provenance trace.
 */
export const executionStepRecordSchema = z.object({
  correlationId: nonEmpty,
  runId: nonEmpty,
  stepId: nonEmpty,
  lifecycleState: executionLifecycleStateSchema,
  terminalReason: terminalReasonSchema.optional(),
  attemptNumber: z.number().int().positive().default(1),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
}).strict().superRefine((rec, issues) => {
  if (rec.finishedAt !== undefined && rec.finishedAt < rec.startedAt) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: "finishedAt must not be earlier than startedAt",
      path: ["finishedAt"],
    });
  }
});
export type ExecutionStepRecord = z.infer<typeof executionStepRecordSchema>;

/**
 * Full Attempt-level execution record with lifecycle state, terminal reason, and provenance trace.
 */
export const executionAttemptRecordSchema = z.object({
  correlationId: nonEmpty,
  runId: nonEmpty,
  stepId: nonEmpty,
  attemptNumber: z.number().int().positive(),
  lifecycleState: executionLifecycleStateSchema,
  terminalReason: terminalReasonSchema.optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
}).strict().superRefine((rec, issues) => {
  if (rec.finishedAt !== undefined && rec.finishedAt < rec.startedAt) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: "finishedAt must not be earlier than startedAt",
      path: ["finishedAt"],
    });
  }
});
export type ExecutionAttemptRecord = z.infer<typeof executionAttemptRecordSchema>;

/**
 * Unified persisted execution lifecycle event schema for event-sourcing and audit trail.
 */
export const executionLifecycleEventSchema = z.object({
  eventId: nonEmpty,
  correlationId: nonEmpty,
  runId: nonEmpty,
  stepId: nonEmpty.optional(),
  attemptNumber: z.number().int().positive().optional(),
  fromState: executionLifecycleStateSchema.optional(),
  toState: executionLifecycleStateSchema,
  terminalReason: terminalReasonSchema.optional(),
  timestamp: z.string().datetime(),
  error: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
}).strict();
export type ExecutionLifecycleEvent = z.infer<typeof executionLifecycleEventSchema>;

/**
 * Build a StepExecutionTrace from a RunExecutionTrace and a stepId.
 */
export function createStepTrace(
  runTrace: Pick<RunExecutionTrace, "correlationId" | "runId">,
  stepId: string,
  startedAt?: string,
): StepExecutionTrace {
  return {
    correlationId: runTrace.correlationId,
    runId: runTrace.runId,
    stepId,
    startedAt: startedAt ?? new Date().toISOString(),
  };
}

/**
 * Build an AttemptExecutionTrace from a StepExecutionTrace and an attemptNumber.
 */
export function createAttemptTrace(
  stepTrace: Pick<StepExecutionTrace, "correlationId" | "runId" | "stepId">,
  attemptNumber: number,
  startedAt?: string,
): AttemptExecutionTrace {
  return {
    correlationId: stepTrace.correlationId,
    runId: stepTrace.runId,
    stepId: stepTrace.stepId,
    attemptNumber,
    startedAt: startedAt ?? new Date().toISOString(),
  };
}
