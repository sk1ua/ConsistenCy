/**
 * H26 trace correlation view — pure aggregation over H11 execution-event
 * ledger facts (WorkflowRuntimeEventStore.listEvents) and the H12 run-row
 * projection, expressed with H10 execution trace contexts.
 *
 * Boundary: this module is DATA-IN, DATA-OUT. It reads ONLY the public ledger
 * readers handed to it — never kernel internals, never the runtime store, and
 * it can neither execute nor authorize anything.
 *
 * Honesty contract (H26):
 *   - Latency, usage, quota, retries and cancellation timing are reported ONLY
 *     when the ledger actually contains the facts. Anything not derivable is
 *     listed in `unknowns` with a reason — never fabricated, never reported as
 *     zero (an unknown quota is "unknown", not 0).
 *   - A step that started without a terminal step event is reported with
 *     `outcome: "unknown"` (H14 outcome_unknown semantics): the executor may
 *     have issued an effect whose result never arrived, so the view must never
 *     suggest a blind replay for it.
 *   - Usage quantities are surfaced under canonical `*Units` field names.
 *     Source payload keys (whatever shape future model/tool nodes emit) are
 *     normalized by pattern, which keeps the exported bundle free of
 *     credential-shaped words so byte-level secret scans stay meaningful.
 */

import {
  attemptExecutionTraceSchema,
  runExecutionTraceSchema,
  stepExecutionTraceSchema,
  type AttemptExecutionTrace,
  type RunExecutionTrace,
  type StepExecutionTrace,
} from "@consistency/schema";

/** Structural subset of the H11 ledger's PersistedWorkflowRuntimeEvent that
 * the view consumes. The concrete store satisfies it without an import. */
export interface DiagnosticsEventLike {
  readonly eventId: string;
  readonly seq: number;
  readonly eventType: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly stepId?: string;
  readonly attemptNumber?: number;
  readonly timestamp: string;
  readonly error?: string;
  readonly payload: Record<string, unknown>;
  /**
   * Wave 3 / R3 (task-10): the authoritative terminal lifecycle triple the
   * terminal event was persisted with. Optional — pre-R3 rows have none, and
   * the documented legacy inference below still applies to them.
   */
  readonly terminalReason?: string;
  readonly toState?: string;
}

/** Structural subset of the H12 run-row projection (WorkflowRuntimeHost.getRun). */
export interface DiagnosticsRunLike {
  readonly runId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
  /** Wave 3 / R3 (task-10): authoritative refined terminal facts. */
  readonly lifecycleState?: string;
  readonly terminalReason?: string;
}

/** H13 budget-ledger fact for one run. Unknown stays unknown — never zero. */
export type BudgetUsageSnapshot =
  | { readonly known: true; readonly used?: number; readonly limit?: number }
  | { readonly known: false; readonly reason?: string };

export type UsageSummary =
  | {
      readonly status: "unknown";
      readonly reason: string;
      readonly eventsTotal: number;
    }
  | {
      readonly status: "known";
      readonly modelCallFacts: number;
      readonly eventsTotal: number;
      readonly totals: {
        readonly inputUnits?: number;
        readonly outputUnits?: number;
        readonly totalUnits?: number;
        readonly requestCount?: number;
      };
    };

export type QuotaSummary =
  | { readonly status: "unknown"; readonly reason: string }
  | { readonly status: "known"; readonly usedUnits?: number; readonly limitUnits?: number };

export interface StepOutcomeView {
  readonly stepId: string;
  readonly outcome: "succeeded" | "failed" | "unknown";
  readonly outcomeUnknown: boolean;
  readonly attemptCount: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly lastError: string | null;
}

export interface RunTraceView {
  readonly correlation: {
    readonly runId: string;
    readonly correlationId: string;
    readonly runContextValidated: boolean;
    readonly stepContextsValidated: number;
    readonly attemptContextsValidated: number;
  };
  readonly latency: {
    readonly runStartedAt: string | null;
    readonly runFinishedAt: string | null;
    readonly totalMs: number | null;
    readonly stepTotalMs: number | null;
    readonly stepsWithUnknownDuration: number;
    readonly perStep: ReadonlyArray<{
      readonly stepId: string;
      readonly startedAt: string | null;
      readonly finishedAt: string | null;
      readonly durationMs: number | null;
    }>;
  };
  readonly usage: UsageSummary;
  readonly quota: QuotaSummary;
  readonly failures: {
    readonly runFailed: boolean;
    readonly runError: string | null;
    readonly failedStepCount: number;
    readonly failedStepIds: readonly string[];
  };
  readonly retries: {
    readonly retriedStepCount: number;
    readonly totalAttempts: number;
    readonly distinctSteps: number;
  };
  readonly cancellation: {
    readonly detected: boolean;
    readonly cancelId: string | null;
    readonly detectedAt: string | null;
    readonly observedWaitMs: number | null;
    readonly waitKnown: boolean;
    /**
     * Wave 3 / R3 (task-10): WHERE the cancellation verdict came from.
     * `authoritative` = the run's/ledger's terminal reason; the legacy values
     * are the documented pre-R3 fallbacks (error-text pattern / payload field).
     * Null when no cancellation was reported at all.
     */
    readonly reasonSource: "authoritative" | "legacy_error_text" | "legacy_cancel_payload" | null;
  };
  /**
   * Wave 3 / R3 (task-10): the run's authoritative terminal facts, read from
   * the terminal ledger event first and the run row second. `source: "none"`
   * means neither carried refined facts (pre-R3 row) — the view says so
   * instead of guessing a reason.
   */
  readonly terminal: {
    readonly lifecycleState: string | null;
    readonly terminalReason: string | null;
    readonly source: "ledger_event" | "run_row" | "none";
  };
  readonly steps: ReadonlyArray<StepOutcomeView>;
  readonly unknowns: readonly string[];
}

/**
 * H13 cancels are reported by the executor as `run-cancelled (<cancelId>) …`,
 * wrapped by the failing node (`<nodeId>: run-cancelled (…)`). The legacy
 * fallback therefore tolerates exactly ONE leading `<token>: ` prefix — a
 * free-text sentence that merely mentions the phrase does NOT match, so this
 * pattern cannot fabricate a cancellation out of provider prose.
 */
const RUN_CANCELLED_PATTERN = /^(?:[^\s:]+: )?run-cancelled \(([^)]+)\)/;

function diffMs(startIso: string | null, endIso: string | null): number | null {
  if (startIso === null || endIso === null) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

/** Sum numeric usage source records into canonical unit buckets. Keys are
 * normalized by pattern; non-finite and negative values are ignored (an
 * unparseable usage fact must not corrupt the aggregate — and a missing fact
 * stays absent, never zero). */
function accumulateUsageUnits(
  record: Record<string, unknown>,
  totals: { input?: number; output?: number; total?: number; requests?: number },
): boolean {
  let sawFact = false;
  for (const [rawKey, rawValue] of Object.entries(record)) {
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue < 0) continue;
    const key = rawKey.toLowerCase();
    let bucket: keyof typeof totals | undefined;
    if (key.includes("total")) bucket = "total";
    else if (key.includes("input") || key.includes("prompt")) bucket = "input";
    else if (key.includes("output") || key.includes("completion")) bucket = "output";
    else if (key.includes("request") || key.includes("call")) bucket = "requests";
    if (bucket === undefined) continue;
    totals[bucket] = (totals[bucket] ?? 0) + Math.trunc(rawValue);
    sawFact = true;
  }
  return sawFact;
}

/** Usage facts ride in step/run event payloads. Accepts the shared TokenUsage
 * shape (`tokenUsage: { inputTokens, outputTokens, totalTokens }`) emitted by
 * the unified LLM entry, and a generic `usage` record for future node kinds. */
function usageRecordsOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const tokenUsage = payload.tokenUsage;
  if (tokenUsage !== null && typeof tokenUsage === "object" && !Array.isArray(tokenUsage)) {
    records.push(tokenUsage as Record<string, unknown>);
  }
  const usage = payload.usage;
  if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
    records.push(usage as Record<string, unknown>);
  }
  return records;
}

interface StepAggregation {
  readonly stepId: string;
  readonly starts: DiagnosticsEventLike[];
  readonly failures: DiagnosticsEventLike[];
  readonly succeeded: DiagnosticsEventLike[];
}

function aggregateSteps(events: ReadonlyArray<DiagnosticsEventLike>): Map<string, StepAggregation> {
  const steps = new Map<string, StepAggregation>();
  for (const event of events) {
    if (event.stepId === undefined) continue;
    let step = steps.get(event.stepId);
    if (step === undefined) {
      step = { stepId: event.stepId, starts: [], failures: [], succeeded: [] };
      steps.set(event.stepId, step);
    }
    if (event.eventType === "step_started") step.starts.push(event);
    else if (event.eventType === "step_failed") step.failures.push(event);
    else if (event.eventType === "step_succeeded") step.succeeded.push(event);
  }
  return steps;
}

/**
 * Build the H26 correlated trace view for one run. Pure: same facts in, same
 * view out. Unknown facts flow into `unknowns` with reasons — the view never
 * substitutes zeros or guesses for them.
 */
export function buildRunTraceView(input: {
  readonly run: DiagnosticsRunLike;
  readonly events: ReadonlyArray<DiagnosticsEventLike>;
  readonly budgetUsage?: BudgetUsageSnapshot;
}): RunTraceView {
  const { run } = input;
  const events = [...input.events].sort((a, b) => a.seq - b.seq);
  const unknowns: string[] = [];

  const runStartedEvent = events.find((event) => event.eventType === "run_started");
  const runTerminalEvent = [...events]
    .reverse()
    .find((event) => event.eventType === "run_succeeded" || event.eventType === "run_failed");

  const runStartedAt = runStartedEvent?.timestamp ?? run.createdAt ?? null;
  const runFinishedAt = runTerminalEvent?.timestamp ?? run.finishedAt ?? null;
  if (runStartedEvent === undefined) {
    unknowns.push("run_started event is absent from the ledger; run start falls back to the run row's createdAt");
  }
  if (runTerminalEvent === undefined) {
    unknowns.push("no terminal run event in the ledger; total latency cannot be derived yet");
  }
  const totalMs = diffMs(runStartedAt, runFinishedAt);

  // -------------------------------------------------------------------------
  // Per-step aggregation: outcome (H14 outcome_unknown), attempts, latency.
  // -------------------------------------------------------------------------
  const stepMap = aggregateSteps(events);
  const perStepLatency: { stepId: string; startedAt: string | null; finishedAt: string | null; durationMs: number | null }[] = [];
  const stepOutcomes: StepOutcomeView[] = [];
  let stepTotalMs: number | null = null;
  let stepsWithUnknownDuration = 0;
  let failedStepCount = 0;
  const failedStepIds: string[] = [];
  let totalAttempts = 0;
  let retriedStepCount = 0;
  const stepTraces: StepExecutionTrace[] = [];
  const attemptTraces: AttemptExecutionTrace[] = [];
  let validatedStepContexts = 0;
  let validatedAttemptContexts = 0;

  for (const step of stepMap.values()) {
    const starts = step.starts;
    const attemptCount = Math.max(
      starts.length,
      starts.reduce((max, event) => Math.max(max, event.attemptNumber ?? 1), 1),
    );
    totalAttempts += attemptCount;
    if (attemptCount > 1) retriedStepCount += 1;

    // Attempt pairing: the i-th terminal fact belongs to the i-th start (the
    // ledger is seq-ordered and the runtime runs attempts sequentially), so
    // attempt-level durations stay truthful across retries.
    const terminals = [...step.failures, ...step.succeeded].sort((a, b) => a.seq - b.seq);
    const firstStart = starts[0];
    const lastTerminal = terminals.at(-1);
    const startedAt = firstStart?.timestamp ?? null;
    const finishedAt = lastTerminal?.timestamp ?? null;
    // Per-step duration is the step's wall-clock span (first start → last
    // terminal, retries included); per-attempt durations live in the attempt
    // trace contexts below.
    const durationMs = diffMs(startedAt, finishedAt);
    if (durationMs === null) {
      stepsWithUnknownDuration += 1;
    } else {
      stepTotalMs = (stepTotalMs ?? 0) + durationMs;
    }
    perStepLatency.push({ stepId: step.stepId, startedAt, finishedAt, durationMs });

    const lastFailure = step.failures.sort((a, b) => a.seq - b.seq).at(-1);
    // Step outcome follows the LAST attempt: a step that failed once and then
    // succeeded on retry is a succeeded step. A step with more starts than
    // terminal facts has an unterminated attempt ⇒ outcome unknown (H14).
    const outcome: StepOutcomeView["outcome"] =
      terminals.length < starts.length ? "unknown"
      : lastTerminal?.eventType === "step_succeeded" ? "succeeded"
      : lastTerminal?.eventType === "step_failed" ? "failed"
      : "unknown";
    const outcomeUnknown = outcome === "unknown";
    const lastError = lastFailure?.error ?? null;
    if (outcome === "failed") {
      failedStepCount += 1;
      failedStepIds.push(step.stepId);
    }
    stepOutcomes.push({
      stepId: step.stepId,
      outcome,
      outcomeUnknown,
      attemptCount,
      startedAt,
      finishedAt,
      durationMs,
      lastError,
    });

    // H10 trace contexts, validated against the shared schemas. The ledger
    // carries correlationId === runId (H11 host contract), so contexts regroup
    // cleanly; a malformed timestamp must not break the whole view — that
    // context is simply not validated and the miss is listed in `unknowns`.
    const correlationId = firstStart?.correlationId ?? run.runId;
    if (startedAt !== null && (finishedAt === null || durationMs !== null)) {
      const parsed = stepExecutionTraceSchema.safeParse({
        correlationId,
        runId: run.runId,
        stepId: step.stepId,
        startedAt,
        ...(finishedAt === null ? {} : { finishedAt }),
      });
      if (parsed.success) {
        stepTraces.push(parsed.data);
        validatedStepContexts += 1;
      } else {
        unknowns.push(`step trace context for '${step.stepId}' failed H10 schema validation`);
      }
    }
    const attemptNumber = Math.max(1, Math.trunc(firstStart?.attemptNumber ?? 1));
    for (let attemptIndex = 0; attemptIndex < starts.length; attemptIndex++) {
      const attemptStart = starts[attemptIndex];
      const attemptTerminal = terminals[attemptIndex];
      if (attemptStart === undefined) continue;
      const attemptFinishedAt = attemptTerminal?.timestamp ?? null;
      const parsedAttempt = attemptExecutionTraceSchema.safeParse({
        correlationId: attemptStart.correlationId,
        runId: run.runId,
        stepId: step.stepId,
        attemptNumber: Math.max(1, Math.trunc(attemptStart.attemptNumber ?? attemptNumber)),
        startedAt: attemptStart.timestamp,
        ...(attemptFinishedAt === null ? {} : { finishedAt: attemptFinishedAt }),
      });
      if (parsedAttempt.success) {
        attemptTraces.push(parsedAttempt.data);
        validatedAttemptContexts += 1;
      } else {
        unknowns.push(`attempt trace context for '${step.stepId}' failed H10 schema validation`);
      }
    }
  }
  if (stepsWithUnknownDuration > 0) {
    unknowns.push(
      `${stepsWithUnknownDuration} step(s) have no terminal event yet; their durations are unknown (steps may be outcome_unknown)`,
    );
  }

  // -------------------------------------------------------------------------
  // Terminal authority (Wave 3 / R3, task-10).
  //
  // The run row and its terminal ledger event carry the AUTHORITATIVE refined
  // lifecycle + reason. Diagnostics reads those FIRST; the error-text/payload
  // cancel inference below survives ONLY as a documented fallback for pre-R3
  // rows without refined facts, and every fallback is named in `unknowns`.
  // -------------------------------------------------------------------------
  const ledgerReason = typeof runTerminalEvent?.terminalReason === "string" && runTerminalEvent.terminalReason !== ""
    ? runTerminalEvent.terminalReason
    : undefined;
  const ledgerState = typeof runTerminalEvent?.toState === "string" && runTerminalEvent.toState !== ""
    ? runTerminalEvent.toState
    : undefined;
  const runRowReason = typeof run.terminalReason === "string" && run.terminalReason !== "" ? run.terminalReason : undefined;
  const runRowState = typeof run.lifecycleState === "string" && run.lifecycleState !== "" ? run.lifecycleState : undefined;
  const terminalReasonValue = ledgerReason ?? runRowReason ?? null;
  const terminalLifecycleValue = ledgerState ?? runRowState ?? null;
  const terminalSource: RunTraceView["terminal"]["source"] =
    ledgerReason !== undefined || ledgerState !== undefined ? "ledger_event"
      : runRowReason !== undefined || runRowState !== undefined ? "run_row"
        : "none";
  const authoritativeTerminal = terminalReasonValue !== null || terminalLifecycleValue !== null;
  const cancelledByAuthority = terminalReasonValue === "user_cancelled" || terminalLifecycleValue === "cancelled";

  // -------------------------------------------------------------------------
  // Cancellation (H13): the AUTHORITATIVE terminal reason decides; the legacy
  // error-text / payload inference runs only when no refined fact exists.
  // -------------------------------------------------------------------------
  const cancelMatch = runTerminalEvent?.eventType === "run_failed" && typeof runTerminalEvent.error === "string"
    ? RUN_CANCELLED_PATTERN.exec(runTerminalEvent.error)
    : null;
  const payloadCancelId =
    typeof runTerminalEvent?.payload.cancelId === "string" ? runTerminalEvent.payload.cancelId : undefined;
  const legacyCancelId = payloadCancelId ?? cancelMatch?.[1] ?? null;
  const cancelId = authoritativeTerminal ? (cancelledByAuthority ? legacyCancelId : null) : legacyCancelId;
  const cancellationDetected = authoritativeTerminal ? cancelledByAuthority : cancelId !== null;
  const cancellationReasonSource: RunTraceView["cancellation"]["reasonSource"] =
    authoritativeTerminal
      ? cancelledByAuthority ? "authoritative" : null
      : payloadCancelId !== undefined ? "legacy_cancel_payload"
        : cancelMatch !== null ? "legacy_error_text"
          : null;
  if (cancelledByAuthority && cancelId === null) {
    unknowns.push("the run is authoritatively cancelled but the ledger records no cancel id; the causal cancel id is unknown");
  }
  if (!authoritativeTerminal && cancellationReasonSource?.startsWith("legacy") === true) {
    unknowns.push(`cancellation was inferred from the legacy ${cancellationReasonSource === "legacy_cancel_payload" ? "payload cancelId" : "error-text pattern"} because the run carries no authoritative terminal reason (pre-R3 row)`);
  }
  if (authoritativeTerminal && !cancelledByAuthority && legacyCancelId !== null) {
    unknowns.push(`the terminal error text/payload mentions a cancellation ('${legacyCancelId}') but the authoritative terminal reason is '${terminalReasonValue ?? terminalLifecycleValue}'; the authoritative fact wins`);
  }
  let observedWaitMs: number | null = null;
  if (cancellationDetected && runTerminalEvent) {
    const lastStepStartBeforeCancel = [...events]
      .reverse()
      .find((event) => event.eventType === "step_started" && event.seq < runTerminalEvent.seq);
    observedWaitMs = diffMs(lastStepStartBeforeCancel?.timestamp ?? null, runTerminalEvent.timestamp);
    if (observedWaitMs === null) {
      unknowns.push("cancellation was detected but no step activity precedes it; the cancelled wait duration is unknown");
    }
  }

  // -------------------------------------------------------------------------
  // Model usage (H17 emits usage facts into event payloads). No facts ⇒
  // status "unknown" — NEVER a zero total.
  // -------------------------------------------------------------------------
  let modelCallFacts = 0;
  const usageTotals: { input?: number; output?: number; total?: number; requests?: number } = {};
  for (const event of events) {
    for (const record of usageRecordsOf(event.payload ?? {})) {
      if (accumulateUsageUnits(record, usageTotals)) modelCallFacts += 1;
    }
  }
  const usage: UsageSummary =
    modelCallFacts === 0
      ? {
          status: "unknown",
          reason: "the execution-event ledger contains no model usage facts for this run",
          eventsTotal: events.length,
        }
      : {
          status: "known",
          modelCallFacts,
          eventsTotal: events.length,
          totals: {
            ...(usageTotals.input === undefined ? {} : { inputUnits: usageTotals.input }),
            ...(usageTotals.output === undefined ? {} : { outputUnits: usageTotals.output }),
            ...(usageTotals.total === undefined ? {} : { totalUnits: usageTotals.total }),
            ...(usageTotals.requests === undefined ? {} : { requestCount: usageTotals.requests }),
          },
        };

  // -------------------------------------------------------------------------
  // Quota (H13 budget ledger). Absent ledger or unknown snapshot ⇒ unknown.
  // -------------------------------------------------------------------------
  let quota: QuotaSummary;
  const budgetUsage = input.budgetUsage;
  if (budgetUsage === undefined) {
    quota = { status: "unknown", reason: "quota is unknown: no budget ledger is wired into diagnostics for this run" };
    unknowns.push("quota is unknown: no H13 budget ledger is wired into the diagnostics reader set");
  } else if (budgetUsage.known === false) {
    quota = { status: "unknown", reason: `quota is unknown: ${budgetUsage.reason ?? "the budget ledger has no usage snapshot for this run"}` };
    unknowns.push("quota is unknown: the budget ledger reported no snapshot for this run");
  } else {
    quota = {
      status: "known",
      ...(budgetUsage.used === undefined ? {} : { usedUnits: budgetUsage.used }),
      ...(budgetUsage.limit === undefined ? {} : { limitUnits: budgetUsage.limit }),
    };
    if (budgetUsage.used === undefined || budgetUsage.limit === undefined) {
      unknowns.push("quota is partially known: the budget ledger did not report used and limit together");
    }
  }

  const runFailed = runTerminalEvent?.eventType === "run_failed" || run.status === "failed";
  const runError = runFailed
    ? runTerminalEvent?.error ?? run.error ?? null
    : null;

  // H10 run-level trace context (validated; failure degrades honestly).
  let runContextValidated = false;
  if (runStartedAt !== null) {
    const parsedRun = runExecutionTraceSchema.safeParse({
      correlationId: runStartedEvent?.correlationId ?? run.runId,
      runId: run.runId,
      startedAt: runStartedAt,
      ...(runFinishedAt === null ? {} : { finishedAt: runFinishedAt }),
    });
    runContextValidated = parsedRun.success;
    if (!parsedRun.success) unknowns.push("run trace context failed H10 schema validation");
  }

  return {
    correlation: {
      runId: run.runId,
      correlationId: runStartedEvent?.correlationId ?? run.runId,
      runContextValidated,
      stepContextsValidated: validatedStepContexts,
      attemptContextsValidated: validatedAttemptContexts,
    },
    latency: {
      runStartedAt,
      runFinishedAt,
      totalMs,
      stepTotalMs,
      stepsWithUnknownDuration,
      perStep: perStepLatency,
    },
    usage,
    quota,
    failures: {
      runFailed,
      runError,
      failedStepCount,
      failedStepIds,
    },
    retries: {
      retriedStepCount,
      totalAttempts,
      distinctSteps: stepMap.size,
    },
    cancellation: {
      detected: cancellationDetected,
      cancelId,
      detectedAt: cancellationDetected ? runTerminalEvent?.timestamp ?? null : null,
      observedWaitMs,
      waitKnown: observedWaitMs !== null,
      reasonSource: cancellationReasonSource,
    },
    terminal: {
      lifecycleState: terminalLifecycleValue,
      terminalReason: terminalReasonValue,
      source: terminalSource,
    },
    steps: stepOutcomes,
    unknowns,
  };
}
