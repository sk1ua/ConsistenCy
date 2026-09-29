/**
 * DiagnosticsService — H26 observability facade for the workflow runtime.
 *
 * What it reads (public APIs ONLY — never kernel internals, never raw SQL):
 *   - H11 execution-event ledger: `WorkflowRuntimeEventStore.listEvents`
 *     (structural `DiagnosticsEventReader`), the fact source for the trace
 *     correlation view and the event timeline;
 *   - H12 run-row projection: `WorkflowRuntimeHost.getRun` /
 *     `runEventsAvailable` (structural `DiagnosticsRunReader`);
 *   - H15 outbox stats: `CompletionOutboxStore.stats` (structural reader);
 *   - H13 budget ledger: an optional injected reader. The composition root has
 *     no ledger instance to hand over today, so quota is reported honestly as
 *     "unknown" until one is wired — never as zero.
 *
 * Failure containment (H26): every public method is catch-all. A diagnostics
 * failure is recorded in the bounded local failure log (visible via
 * `lastFailures`) and returned as a typed failure — it NEVER throws into the
 * HTTP pipeline and never touches the run pipeline, which this module cannot
 * write to at all.
 *
 * Secret discipline: the bundle passes the shared sanitizers TWICE (per-part
 * and whole-object defense in depth). Sensitive keys are dropped and
 * credential-shaped strings are replaced before serialization, so exported
 * bytes never carry test secrets.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { sanitizeExecutionError, sanitizeStructuredData } from "../security/redact";
import {
  buildRunTraceView,
  type BudgetUsageSnapshot,
  type DiagnosticsEventLike,
  type DiagnosticsRunLike,
  type RunTraceView,
} from "./traceView";
import {
  DIAGNOSTICS_ARTIFACT_FILE_PREFIX,
  DiagnosticsRetentionIndex,
  type RetentionEnforcementSummary,
  type RetentionLimits,
  type RunDeletionSummary,
} from "./retention";

export const DIAGNOSTICS_BUNDLE_KIND = "consistency-diagnostics-bundle";
export const DIAGNOSTICS_BUNDLE_SCHEMA_VERSION = 1;
/** Bounded timeline: a huge ledger must not explode the exported bundle. */
export const DIAGNOSTICS_MAX_TIMELINE_EVENTS = 500;
export const DIAGNOSTICS_MAX_FAILURE_RECORDS = 50;
/** Adoption sweep bound: a directory listing never runs away. */
const DIAGNOSTICS_MAX_ADOPTED_FILES = 1_000;
const BUNDLE_FILE_PATTERN = /^consistency-diagnostics-bundle-[A-Za-z0-9._-]+\.json$/;

/** Filesystem-safe artifact basename component (run ids are opaque strings). */
function safeFileComponent(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned.slice(0, 80) || "unknown";
}

export type DiagnosticsEventReader = { readonly listEvents: (runId: string) => DiagnosticsEventLike[] };
export type DiagnosticsRunReader = {
  readonly getRun: (runId: string) => (DiagnosticsRunLike & Record<string, unknown>) | undefined;
  readonly runEventsAvailable?: () => boolean;
};
export type DiagnosticsOutboxReader = {
  readonly stats: () => { readonly pending: number; readonly retrying: number; readonly delivered: number; readonly failed: number };
};
export type DiagnosticsBudgetReader = {
  readonly runUsage: (runId: string) => BudgetUsageSnapshot | undefined;
};

export interface DiagnosticsFailureRecord {
  readonly at: string;
  readonly operation: string;
  readonly reason: string;
}

export interface DiagnosticsRetentionOptions {
  /** Directory for persisted diagnostic bundles (module-owned artifacts). */
  readonly dir?: string;
  readonly limits: RetentionLimits;
}

export interface DiagnosticsServiceOptions {
  /** Telemetry switch: unset/false ⇒ the feature is silently off and the
   * capability projection honestly reports the disabled state. */
  readonly enabled: boolean;
  readonly retention?: DiagnosticsRetentionOptions;
  readonly now?: () => Date;
  readonly onError?: (failureRecord: DiagnosticsFailureRecord) => void;
}

export type DiagnosticsExportResult =
  | { readonly ok: true; readonly bundle: Record<string, unknown>; readonly bytes: number }
  | { readonly ok: false; readonly code: string; readonly statusCode: number; readonly reason: string };

export type DiagnosticsTraceResult =
  | { readonly ok: true; readonly trace: RunTraceView }
  | { readonly ok: false; readonly code: string; readonly statusCode: number; readonly reason: string };

export type DiagnosticsRetentionResult =
  | { readonly ok: true; readonly summary: RetentionEnforcementSummary }
  | { readonly ok: false; readonly code: string; readonly statusCode: number; readonly reason: string };

export type DiagnosticsRunDeletionResult =
  | { readonly ok: true; readonly summary: RunDeletionSummary }
  | { readonly ok: false; readonly code: string; readonly statusCode: number; readonly reason: string };

export interface DiagnosticsCapabilities {
  readonly enabled: boolean;
  readonly reason?: string;
  readonly eventLedger: boolean;
  readonly completionOutbox: boolean;
  readonly budgetLedger: boolean;
  readonly retention: {
    readonly dir: boolean;
    readonly maxFiles: number;
    readonly maxTotalBytes: number;
    readonly maxAgeMs: number;
  };
}

/** Resolved facts for one run: the H12 run row (may be absent) plus H11
 * ledger events (may be empty). A reader FAILURE is distinguishable from an
 * honest empty result so the export never fakes a 404. */
type RunFacts =
  | { readonly ok: true; readonly runRow: (DiagnosticsRunLike & Record<string, unknown>) | undefined; readonly events: readonly DiagnosticsEventLike[] }
  | { readonly ok: false; readonly code: string; readonly statusCode: number; readonly reason: string };

export class DiagnosticsService {
  readonly #events: DiagnosticsEventReader | null;
  readonly #runs: DiagnosticsRunReader | null;
  readonly #outbox: DiagnosticsOutboxReader | null;
  readonly #budget: DiagnosticsBudgetReader | null;
  readonly #enabled: boolean;
  readonly #retention: DiagnosticsRetentionOptions | undefined;
  readonly #now: () => Date;
  readonly #onError: (failureRecord: DiagnosticsFailureRecord) => void;
  readonly #index = new DiagnosticsRetentionIndex();
  readonly #failures: DiagnosticsFailureRecord[] = [];

  constructor(
    readers: {
      readonly events?: DiagnosticsEventReader | null;
      readonly runs?: DiagnosticsRunReader | null;
      readonly outbox?: DiagnosticsOutboxReader | null;
      readonly budget?: DiagnosticsBudgetReader | null;
    },
    options: DiagnosticsServiceOptions,
  ) {
    this.#events = readers.events ?? null;
    this.#runs = readers.runs ?? null;
    this.#outbox = readers.outbox ?? null;
    this.#budget = readers.budget ?? null;
    this.#enabled = options.enabled;
    this.#retention = options.retention;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => {});
  }

  // ---------------------------------------------------------------------------
  // Guarded reader access — a reader throw is a locally visible diagnostics
  // failure, never a caller-facing exception.
  // ---------------------------------------------------------------------------

  #safeListEvents(runId: string): readonly DiagnosticsEventLike[] | null {
    if (this.#events === null) return null;
    try {
      return this.#events.listEvents(runId);
    } catch (error) {
      this.#recordFailure("listEvents", error);
      return null;
    }
  }

  #safeGetRun(runId: string): (DiagnosticsRunLike & Record<string, unknown>) | undefined | null {
    if (this.#runs === null) return null;
    try {
      return this.#runs.getRun(runId);
    } catch (error) {
      this.#recordFailure("getRun", error);
      return null;
    }
  }

  #recordFailure(operation: string, error: unknown): DiagnosticsFailureRecord {
    const record: DiagnosticsFailureRecord = {
      at: this.#now().toISOString(),
      operation,
      reason: sanitizeExecutionError(error instanceof Error ? error.message : String(error)) || "diagnostics operation failed",
    };
    this.#failures.push(record);
    if (this.#failures.length > DIAGNOSTICS_MAX_FAILURE_RECORDS) {
      this.#failures.splice(0, this.#failures.length - DIAGNOSTICS_MAX_FAILURE_RECORDS);
    }
    try {
      this.#onError(record);
    } catch {
      // Error reporting must never create a second failure.
    }
    return record;
  }

  #resolveRunFacts(runId: string): RunFacts {
    const runRow = this.#safeGetRun(runId);
    const events = this.#safeListEvents(runId);
    if (runRow === null && events === null) {
      return {
        ok: false,
        code: "DIAGNOSTICS_UNAVAILABLE",
        statusCode: 503,
        reason: "neither the run projection nor the execution-event ledger is wired into diagnostics",
      };
    }
    if (runRow === null && (events === null || events.length === 0)) {
      // The run reader failed, so absence cannot be asserted honestly.
      return {
        ok: false,
        code: "DIAGNOSTICS_UNAVAILABLE",
        statusCode: 503,
        reason: "the run projection is unavailable and the ledger holds no facts for this run",
      };
    }
    if (runRow === undefined && (events === null || events.length === 0)) {
      return { ok: false, code: "DIAGNOSTICS_RUN_NOT_FOUND", statusCode: 404, reason: `workflow run not found: ${runId}` };
    }
    return {
      ok: true,
      runRow: runRow ?? undefined,
      events: events ?? [],
    };
  }

  // ---------------------------------------------------------------------------
  // Capability projection — honest on/off facts, no secrets, no paths.
  // ---------------------------------------------------------------------------

  capabilities(): DiagnosticsCapabilities {
    let eventLedger = this.#events !== null;
    if (this.#runs?.runEventsAvailable !== undefined) {
      try {
        eventLedger = this.#runs.runEventsAvailable();
      } catch (error) {
        this.#recordFailure("runEventsAvailable", error);
        eventLedger = this.#events !== null;
      }
    }
    return {
      enabled: this.#enabled,
      ...(this.#enabled ? {} : { reason: "diagnostics telemetry is not configured (CONSISTENCY_DIAGNOSTICS_ENABLED is unset or false)" }),
      eventLedger,
      completionOutbox: this.#outbox !== null,
      budgetLedger: this.#budget !== null,
      retention: {
        dir: this.#retention?.dir !== undefined,
        maxFiles: this.#retention?.limits.maxFiles ?? 0,
        maxTotalBytes: this.#retention?.limits.maxTotalBytes ?? 0,
        maxAgeMs: this.#retention?.limits.maxAgeMs ?? 0,
      },
    };
  }

  /** Bounded local failure log — observability failures stay locally visible. */
  lastFailures(limit = DIAGNOSTICS_MAX_FAILURE_RECORDS): readonly DiagnosticsFailureRecord[] {
    return this.#failures.slice(-Math.max(1, Math.min(limit, DIAGNOSTICS_MAX_FAILURE_RECORDS)));
  }

  // ---------------------------------------------------------------------------
  // Trace correlation view
  // ---------------------------------------------------------------------------

  buildTrace(runId: string): DiagnosticsTraceResult {
    if (!this.#enabled) {
      return {
        ok: false,
        code: "DIAGNOSTICS_DISABLED",
        statusCode: 503,
        reason: "diagnostics telemetry is not configured (CONSISTENCY_DIAGNOSTICS_ENABLED is unset or false)",
      };
    }
    try {
      const facts = this.#resolveRunFacts(runId);
      if (!facts.ok) return facts;
      const budgetUsage = this.#safeBudgetUsage(runId);
      return {
        ok: true,
        trace: buildRunTraceView({
          run: facts.runRow ?? {
            runId,
            status: "unknown",
            createdAt: facts.events[0]?.timestamp ?? this.#now().toISOString(),
          },
          events: facts.events,
          ...(budgetUsage === undefined ? {} : { budgetUsage }),
        }),
      };
    } catch (error) {
      const record = this.#recordFailure("buildTrace", error);
      return { ok: false, code: "DIAGNOSTICS_TRACE_FAILED", statusCode: 500, reason: record.reason };
    }
  }

  #safeBudgetUsage(runId: string): BudgetUsageSnapshot | undefined {
    if (this.#budget === null) return undefined;
    try {
      return this.#budget.runUsage(runId);
    } catch (error) {
      this.#recordFailure("budget.runUsage", error);
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Sanitized diagnostics bundle export
  // ---------------------------------------------------------------------------

  exportRunBundle(runId: string): DiagnosticsExportResult {
    if (!this.#enabled) {
      return {
        ok: false,
        code: "DIAGNOSTICS_DISABLED",
        statusCode: 503,
        reason: "diagnostics telemetry is not configured (CONSISTENCY_DIAGNOSTICS_ENABLED is unset or false)",
      };
    }
    try {
      return this.#exportRunBundle(runId);
    } catch (error) {
      const record = this.#recordFailure("exportRunBundle", error);
      return { ok: false, code: "DIAGNOSTICS_EXPORT_FAILED", statusCode: 500, reason: record.reason };
    }
  }

  #exportRunBundle(runId: string): DiagnosticsExportResult {
    const facts = this.#resolveRunFacts(runId);
    if (!facts.ok) return facts;

    const budgetUsage = this.#safeBudgetUsage(runId);
    const trace = buildRunTraceView({
      run: facts.runRow ?? {
        runId,
        status: "unknown",
        createdAt: facts.events[0]?.timestamp ?? this.#now().toISOString(),
      },
      events: facts.events,
      ...(budgetUsage === undefined ? {} : { budgetUsage }),
    });

    const bundle = sanitizeStructuredData({
      kind: DIAGNOSTICS_BUNDLE_KIND,
      bundleSchemaVersion: DIAGNOSTICS_BUNDLE_SCHEMA_VERSION,
      generatedAt: this.#now().toISOString(),
      run: this.#runSummary(runId, facts.runRow),
      trace,
      timeline: this.#timeline(facts.events),
      failedSteps: trace.steps
        .filter((step) => step.outcome !== "succeeded")
        .map((step) => ({
          stepId: step.stepId,
          outcome: step.outcome,
          outcomeUnknown: step.outcomeUnknown,
          ...(step.lastError === null ? {} : { error: sanitizeExecutionError(step.lastError) }),
          recovery: step.outcome === "unknown"
            ? recoverySuggestion("unknown", step.lastError)
            : recoverySuggestion("failed", step.lastError),
        })),
      runRecovery: trace.failures.runFailed
        ? recoverySuggestion("failed", trace.failures.runError)
        : null,
      recoveryAlignment:
        "H14: steps with unknown outcome and blocked configurations are surfaced with explicit recovery actions; nothing in this bundle replays a run automatically",
      completionReporting: this.#outboxSummary(),
      capabilities: this.capabilities(),
      redaction: {
        applied: true,
        sensitiveKeysRemoved: true,
        credentialStringsReplacedWith: "[REDACTED]",
        note: "the whole bundle passes the shared sanitizers; absolute paths and credential-shaped strings never survive serialization",
      },
    });

    // Defense in depth: one more whole-object pass so nothing a hostile or
    // buggy reader returned can survive unredacted.
    const sanitizedBundle = sanitizeStructuredData(bundle);
    const serialized = JSON.stringify(sanitizedBundle);
    return { ok: true, bundle: sanitizedBundle, bytes: Buffer.byteLength(serialized, "utf8") };
  }

  /** Run summary from the H12 projection — an explicit whitelist of the run
   * row's provenance fields. Hostile or buggy readers cannot smuggle extra
   * keys into the bundle: anything outside the whitelist never leaves this
   * module (credential safety by construction, not by sanitization luck). */
  #runSummary(runId: string, runRow: (DiagnosticsRunLike & Record<string, unknown>) | undefined): Record<string, unknown> {
    if (runRow === undefined) {
      return {
        runId,
        rowAvailable: false,
        status: "unknown",
        reason: "the run row is not available; run facts below come from the execution-event ledger",
      };
    }
    const whitelist = [
      "definitionId", "revisionId", "origin", "repository", "headSha",
      "correlationId", "lifecycleState", "terminalReason", "startedAt", "trigger",
    ] as const;
    const allowed: Record<string, unknown> = {};
    for (const key of whitelist) {
      if (runRow[key] !== undefined) allowed[key] = runRow[key];
    }
    return {
      runId,
      rowAvailable: true,
      status: runRow.status,
      createdAt: runRow.createdAt,
      ...(runRow.finishedAt === undefined ? {} : { finishedAt: runRow.finishedAt }),
      ...(runRow.error === undefined ? {} : { error: sanitizeExecutionError(String(runRow.error)) }),
      ...allowed,
    };
  }

  #timeline(events: ReadonlyArray<DiagnosticsEventLike>): Record<string, unknown> {
    if (this.#events === null) {
      return { available: false, reason: "no execution-event ledger is wired into diagnostics", events: [] };
    }
    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    const bounded = ordered.slice(0, DIAGNOSTICS_MAX_TIMELINE_EVENTS);
    return {
      available: true,
      totalEvents: ordered.length,
      ...(ordered.length > bounded.length ? { truncated: true, note: `timeline is bounded to the first ${DIAGNOSTICS_MAX_TIMELINE_EVENTS} ledger events` } : {}),
      events: bounded.map((event) => ({
        seq: event.seq,
        eventId: event.eventId,
        eventType: event.eventType,
        timestamp: event.timestamp,
        correlationId: event.correlationId,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        ...(event.attemptNumber === undefined ? {} : { attemptNumber: event.attemptNumber }),
        ...(event.error === undefined ? {} : { error: sanitizeExecutionError(event.error) }),
        // Re-sanitized on the way out (read-path defense in depth, mirroring
        // the ledger's own read path).
        payload: sanitizeStructuredData(event.payload ?? {}),
      })),
    };
  }

  #outboxSummary(): Record<string, unknown> {
    if (this.#outbox === null) {
      return { available: false, reason: "no completion outbox is wired into diagnostics" };
    }
    try {
      return { available: true, outbox: this.#outbox.stats() };
    } catch (error) {
      const record = this.#recordFailure("outbox.stats", error);
      return { available: false, reason: record.reason };
    }
  }

  // ---------------------------------------------------------------------------
  // Retention: module-owned artifacts only.
  // ---------------------------------------------------------------------------

  /** Persist the sanitized bundle as a module-owned artifact file. Returns the
   * same result as the export plus the artifact coordinates. */
  persistRunBundle(runId: string, dir?: string): DiagnosticsExportResult & { readonly artifactId?: string; readonly path?: string } {
    const targetDir = dir ?? this.#retention?.dir;
    if (targetDir === undefined) {
      return {
        ok: false,
        code: "DIAGNOSTICS_RETENTION_UNAVAILABLE",
        statusCode: 503,
        reason: "no diagnostics retention directory is configured",
      };
    }
    const exported = this.exportRunBundle(runId);
    if (!exported.ok) return exported;
    try {
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      const resolvedDir = resolve(targetDir);
      const fileName = `${DIAGNOSTICS_ARTIFACT_FILE_PREFIX}bundle-${safeFileComponent(runId)}-${Date.parse(this.#now().toISOString())}.json`;
      const target = join(resolvedDir, fileName);
      writeFileSync(target, JSON.stringify(exported.bundle), "utf8");
      const stats = statSync(target);
      this.#index.register({
        artifactId: fileName,
        kind: "diagnostics-bundle",
        bytes: stats.size,
        createdAt: this.#now().toISOString(),
        runIds: [runId],
        remove: this.#makeFsRemover(resolvedDir),
      });
      return { ...exported, artifactId: fileName, path: target };
    } catch (error) {
      const record = this.#recordFailure("persistRunBundle", error);
      return { ok: false, code: "DIAGNOSTICS_EXPORT_FAILED", statusCode: 500, reason: record.reason };
    }
  }

  /** Guarded unlink: only module-prefixed basenames inside the retention
   * directory are removable — a corrupted index entry cannot widen deletion. */
  #makeFsRemover(dir: string): (artifactId: string) => boolean {
    return (artifactId: string): boolean => {
      try {
        if (!artifactId.startsWith(DIAGNOSTICS_ARTIFACT_FILE_PREFIX)) return false;
        if (artifactId.includes("/") || artifactId.includes("\\") || artifactId.includes("..")) return false;
        if (!isAbsolute(dir)) return false;
        const resolvedDir = resolve(dir);
        const target = resolve(dir, artifactId);
        if (!target.startsWith(resolvedDir + sep)) return false;
        if (!existsSync(target)) return true;
        unlinkSync(target);
        return true;
      } catch {
        return false;
      }
    };
  }

  /** Adopt module-identifiable bundle files that exist on disk but are absent
   * from the in-memory index (e.g. after a restart). Files that do not match
   * the module's strict bundle-file pattern are NEVER adopted — and therefore
   * never cleaned. */
  #adoptDirectoryFiles(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (error) {
      this.#recordFailure("retention.readdir", error);
      return;
    }
    for (const entry of entries.slice(0, DIAGNOSTICS_MAX_ADOPTED_FILES)) {
      if (this.#index.get(entry) !== undefined) continue;
      if (!BUNDLE_FILE_PATTERN.test(entry)) continue;
      try {
        const stats = statSync(join(dir, entry));
        if (!stats.isFile()) continue;
        this.#index.register({
          artifactId: entry,
          kind: "diagnostics-bundle",
          bytes: stats.size,
          createdAt: stats.mtime.toISOString(),
          runIds: [],
          remove: this.#makeFsRemover(resolve(dir)),
        });
      } catch (error) {
        this.#recordFailure("retention.adopt", error);
      }
    }
  }

  /** Enforce size/count/age retention over module-owned artifacts. Foreign
   * files (review history, reports, anything not registered by this module)
   * are never touched. */
  enforceRetention(nowIso?: string): DiagnosticsRetentionResult {
    if (!this.#enabled) {
      return {
        ok: false,
        code: "DIAGNOSTICS_DISABLED",
        statusCode: 503,
        reason: "diagnostics telemetry is not configured (CONSISTENCY_DIAGNOSTICS_ENABLED is unset or false)",
      };
    }
    try {
      const dir = this.#retention?.dir;
      if (dir !== undefined && existsSync(dir)) this.#adoptDirectoryFiles(resolve(dir));
      const summary = this.#index.enforce(nowIso ?? this.#now().toISOString(), {
        maxFiles: this.#retention?.limits.maxFiles ?? 0,
        maxTotalBytes: this.#retention?.limits.maxTotalBytes ?? 0,
        maxAgeMs: this.#retention?.limits.maxAgeMs ?? 0,
      });
      return { ok: true, summary };
    } catch (error) {
      const record = this.#recordFailure("enforceRetention", error);
      return { ok: false, code: "DIAGNOSTICS_RETENTION_FAILED", statusCode: 500, reason: record.reason };
    }
  }

  /**
   * Run-scoped deletion. Shared artifacts referenced by other runs survive —
   * only this run's reference is dropped (refcount semantics in the index).
   */
  deleteRun(runId: string): DiagnosticsRunDeletionResult {
    if (!this.#enabled) {
      return {
        ok: false,
        code: "DIAGNOSTICS_DISABLED",
        statusCode: 503,
        reason: "diagnostics telemetry is not configured (CONSISTENCY_DIAGNOSTICS_ENABLED is unset or false)",
      };
    }
    try {
      return { ok: true, summary: this.#index.deleteRun(runId) };
    } catch (error) {
      const record = this.#recordFailure("deleteRun", error);
      return { ok: false, code: "DIAGNOSTICS_RETENTION_FAILED", statusCode: 500, reason: record.reason };
    }
  }

  /** Test/inspection surface for the retention registry (records only). */
  retentionRecords(): readonly { artifactId: string; kind: string; bytes: number; createdAt: string; runIds: readonly string[] }[] {
    return this.#index.list().map((record) => ({
      artifactId: record.artifactId,
      kind: record.kind,
      bytes: record.bytes,
      createdAt: record.createdAt,
      runIds: record.runIds,
    }));
  }
}

// ---------------------------------------------------------------------------
// H14-aligned deterministic recovery classification
// ---------------------------------------------------------------------------

export type RecoveryAction = "inspect-then-resume" | "resume-after-cancel" | "fix-configuration" | "retry-after-fix";

export interface RecoverySuggestion {
  readonly action: RecoveryAction;
  readonly reason: string;
}

/** Deterministic, ledger-fact-based classification. An unknown-outcome step
 * never gets a replay suggestion (H14): a tool call may have been issued with
 * no result, so only explicit inspect/resume decisions are safe. */
export function recoverySuggestion(outcome: "failed" | "unknown", rawError: string | null): RecoverySuggestion {
  const error = rawError === null ? "" : rawError;
  if (outcome === "unknown") {
    return {
      action: "inspect-then-resume",
      reason:
        "the step started but produced no terminal fact, so its outcome is unknown; do not blindly replay — inspect the checkpoint and choose the explicit resume or retry action",
    };
  }
  if (error.includes("run-cancelled") || error.includes("cancel")) {
    return {
      action: "resume-after-cancel",
      reason: "the run was cancelled with a single causal cancel id; use the explicit continue or retry action instead of replaying the run",
    };
  }
  if (
    error.includes("no executor service registered")
    || error.includes("capability")
    || error.includes("not configured")
    || error.includes("unavailable")
    || error.includes("admission-denied")
  ) {
    return {
      action: "fix-configuration",
      reason: "the step failed for an environment or configuration reason; fix the configuration or capability setup before retrying",
    };
  }
  return {
    action: "retry-after-fix",
    reason: "the step failed with a sanitized error; fix the cause, then use the explicit rerun action",
  };
}
