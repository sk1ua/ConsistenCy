/**
 * Audit run executor — the execution half of the incremental audit bridge
 * (CKPT5 executor slice; mirrors workflow-runtime/triggers.ts discipline).
 *
 * Slice responsibility: drain durable `created` audit-run drafts whose
 * automation carries a `runtimeDefinitionId` mapping, launching each one
 * through WorkflowRuntimeHost.launchDefinitionRun — the SAME canonical
 * validated-revision → pinned-snapshot path a manual binding trigger uses.
 * There is deliberately no second execution world and no legacy WorkflowSpec
 * execution here (the engine-legacy surface stays frozen).
 *
 * Semantics (aligned with the CKPT5 trigger executor precedent):
 *   - Fenced claim: markRunQueued's created→queued state guard IS the claim;
 *     a transition conflict means another worker already owns the run.
 *   - One attempt per run: no retry loop; a failed attempt is terminal with
 *     a sanitized reason persisted in execution_error.
 *   - Honest failures, never silent skips: unlike trigger plans (whose intent
 *     can go away), an audit run that cannot execute — non-local repository,
 *     unmapped/deleted definition, snapshot unavailable — is marked FAILED
 *     with that exact reason. Drafts stay durable either way.
 *   - Restart honesty: legacy queued/running runs left by a previous process
 *     are reconciled at startup (mirrored when their linked workflow run has
 *     reached a terminal state; failed honestly otherwise).
 *   - Terminal mirroring: once launched, the audit run tracks its linked
 *     workflow_runtime_run and mirrors succeeded/failed — the workflow run's
 *     own outcome is the single source of truth.
 *
 * The executor grants nothing: every protected syscall inside the launched
 * run is authorized per-call by the Kernel, exactly like a manual trigger.
 */

import type { AuditRun } from "@consistency/schema";
import { sanitizeExecutionError } from "../security/redact";
import { AuditDomainError } from "./store";

/** Honest reasons surfaced through planning results / capability payloads. */
export const AUDIT_EXECUTION_DISABLED_REASON =
  "Audit execution is disabled in this deployment (CONSISTENCY_AUDIT_EXECUTION_ENABLED=false)" as const;

export const AUDIT_EXECUTION_AUTOMATION_NOT_MAPPED_REASON =
  "Automation has no workflow runtime definition mapping" as const;

export const AUDIT_EXECUTION_LOCAL_REPOSITORY_REQUIRED_REASON =
  "Audit execution is limited to locally monitored repositories" as const;

export type AuditExecutionLaunchInput = {
  repositoryId: string;
  definitionId: string;
  /** Observability provenance only; never an authorization widening. */
  trigger?: { source: "manual" | "repository_change"; eventId?: string };
};

export type AuditExecutionLaunchFn = (
  input: AuditExecutionLaunchInput
) => Promise<{ runId: string }>;

/** Narrowed view of the linked workflow-runtime run used for mirroring. */
export type WorkflowRuntimeRunStatusView = {
  status: "running" | "succeeded" | "failed";
  error?: string;
};

export type AuditRunExecutorStatus = {
  running: boolean;
  lastPollAt?: string;
  /** Run currently being drained (single-flight; absent when idle). */
  executingRunId?: string;
  launchedRuns: number;
  mirroredSucceededRuns: number;
  failedRuns: number;
  reconciledRuns: number;
  lastError?: string;
};

export type AuditRunExecutorTimer = {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(timer: unknown): void;
};

const DEFAULT_AUDIT_EXECUTION_POLL_INTERVAL_MS = 5_000;
const DEFAULT_AUDIT_EXECUTION_BATCH = 5;
const RESTART_INTERRUPTED_PREFIX = "audit run interrupted by API restart";
const LINK_CONFLICT_NOTE = "audit run left the executor lifecycle before its launched workflow run could be linked";

function unrefTimer(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
  }
}

/** Transition conflicts are the fence: someone else owns the run now. */
function isTransitionConflict(error: unknown): boolean {
  return error instanceof AuditDomainError && (
    error.code === "AUDIT_RUN_INVALID_TRANSITION"
    || error.code === "AUDIT_RUN_RUNTIME_LINK_CONFLICT"
  );
}

/** Sanitized failure text persisted into audit_runs.execution_error. */
function describeExecutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeExecutionError(message);
}

/**
 * Single-flight background drain of executable audit-run drafts plus terminal
 * mirroring of already-launched runs. One instance per process; overlapping
 * ticks are ignored, and nothing inside a tick may take the process down.
 */
export class AuditRunExecutor {
  #running = false;
  #inFlight = false;
  #timer?: unknown;
  #lastPollAt?: string;
  #executingRunId?: string;
  #launchedRuns = 0;
  #mirroredSucceededRuns = 0;
  #failedRuns = 0;
  #reconciledRuns = 0;
  #lastError?: string;

  constructor(
    private readonly dependencies: {
      store: {
        listExecutableRuns(limit?: number): AuditRun[];
        listLinkedRunningRuns(limit?: number): AuditRun[];
        listAuditRuns(repositoryId?: string): AuditRun[];
        listRecoverableAuditRuns(limit?: number): AuditRun[];
        getAuditRun(runId: string): AuditRun | undefined;
        getAutomation(id: string): { runtimeDefinitionId?: string } | undefined;
        getRepository(id: string): { source: string } | undefined;
        markRunQueued(runId: string): AuditRun;
        markRunRunning(
          runId: string,
          options?: { workflowRuntimeRunId?: string }
        ): AuditRun;
        markRunTerminal(
          runId: string,
          status: "succeeded" | "failed",
          options?: { executionError?: string }
        ): AuditRun;
        markRunFailedFromQueued(runId: string, options?: { executionError?: string }): AuditRun;
      };
      launch: AuditExecutionLaunchFn;
      getWorkflowRuntimeRun(runId: string): WorkflowRuntimeRunStatusView | undefined;
      pollIntervalMs?: number;
      batchSize?: number;
      timer?: AuditRunExecutorTimer;
      now?: () => Date;
      onError?: (failure: { runId?: string; phase: "tick" | "launch" | "mirror" | "reconcile"; error: unknown }) => void;
    },
  ) {}

  get status(): AuditRunExecutorStatus {
    return {
      running: this.#running,
      ...(this.#lastPollAt === undefined ? {} : { lastPollAt: this.#lastPollAt }),
      ...(this.#executingRunId === undefined ? {} : { executingRunId: this.#executingRunId }),
      launchedRuns: this.#launchedRuns,
      mirroredSucceededRuns: this.#mirroredSucceededRuns,
      failedRuns: this.#failedRuns,
      reconciledRuns: this.#reconciledRuns,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError })
    };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const timer = this.dependencies.timer ?? {
      setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
      clearInterval: (handle: unknown) => clearInterval(handle as NodeJS.Timeout)
    };
    const intervalMs =
      this.dependencies.pollIntervalMs ?? DEFAULT_AUDIT_EXECUTION_POLL_INTERVAL_MS;
    this.#timer = timer.setInterval(() => {
      void this.tick();
    }, intervalMs);
    unrefTimer(this.#timer);
  }

  stop(): void {
    if (this.#timer !== undefined) {
      const timer = this.dependencies.timer ?? {
        setInterval: () => {
          throw new Error("unreachable");
        },
        clearInterval: (handle: unknown) => clearInterval(handle as NodeJS.Timeout)
      };
      timer.clearInterval(this.#timer);
    }
    this.#timer = undefined;
    this.#running = false;
  }

  /**
   * Startup honesty sweep (invoke once before start(), AFTER the workflow
   * runtime host recovered ITS interrupted runs). Legacy queued/running runs
   * from a previous process cannot continue in this one:
   *   - no link                → failed("…interrupted…before it could execute");
   *   - link unresolvable      → failed("…linked workflow run could not be resolved");
   *   - link terminal          → mirror that exact outcome;
   *   - link still `running`   → defensive no-op (the workflow host marks such
   *     rows failed first during its own recovery; see server wiring order).
   * Runs the kill switch disarms never reach this method (callers gate it).
   */
  reconcileInterruptedRuns(): number {
    let reconciled = 0;
    for (const run of this.dependencies.store.listRecoverableAuditRuns()) {
      if (run.status !== "queued" && run.status !== "running") continue;
      if (run.workflowRuntimeRunId === undefined) {
        this.#settleFailed(run, `${RESTART_INTERRUPTED_PREFIX} before it could execute`, "reconcile");
        reconciled += 1;
        continue;
      }
      const linked = this.dependencies.getWorkflowRuntimeRun(run.workflowRuntimeRunId);
      if (linked === undefined) {
        this.#settleFailed(
          run,
          `${RESTART_INTERRUPTED_PREFIX}: linked workflow runtime run '${run.workflowRuntimeRunId}' could not be resolved`,
          "reconcile"
        );
        reconciled += 1;
        continue;
      }
      if (linked.status === "running") continue;
      this.#mirrorOutcome(run, linked.status, linked.error, "reconcile");
      reconciled += 1;
    }
    this.#reconciledRuns += reconciled;
    return reconciled;
  }

  /** One drain + mirror pass; overlapping ticks are ignored (single-flight). */
  async tick(): Promise<void> {
    if (this.#inFlight) return;
    this.#inFlight = true;
    try {
      // Recover queued/running rows left by a failed link write or process
      // restart before claiming new drafts; queued orphans cannot remain
      // invisible to the executor forever.
      this.reconcileInterruptedRuns();
      await this.#drainClaims();
      await this.#mirrorInFlight();
    } catch (error) {
      // The loop must never throw into the process: record sanitized, notify.
      this.#recordFailure({ phase: "tick", error });
    } finally {
      this.#inFlight = false;
      this.#lastPollAt = (this.dependencies.now?.() ?? new Date()).toISOString();
    }
  }

  async #drainClaims(): Promise<void> {
    const batchSize = this.dependencies.batchSize ?? DEFAULT_AUDIT_EXECUTION_BATCH;
    for (const candidate of this.dependencies.store.listExecutableRuns(batchSize)) {
      let claimed: AuditRun;
      try {
        claimed = this.dependencies.store.markRunQueued(candidate.id);
      } catch (error) {
        if (isTransitionConflict(error)) continue; // fenced: someone else claimed it
        throw error;
      }
      this.#executingRunId = claimed.id;
      try {
        await this.#launchClaimed(claimed);
      } finally {
        this.#executingRunId = undefined;
      }
    }
  }

  /**
   * One attempt per claimed run — precondition violations and launch errors
   * alike end in a terminal `failed` with a sanitized, specific reason.
   */
  async #launchClaimed(run: AuditRun): Promise<void> {
    try {
      const automation = run.automationId === undefined
        ? undefined
        : this.dependencies.store.getAutomation(run.automationId);
      const definitionId = automation?.runtimeDefinitionId;
      if (definitionId === undefined) {
        this.#settleFailed(
          run,
          automation === undefined
            ? `audit run references missing automation '${run.automationId}'`
            : AUDIT_EXECUTION_AUTOMATION_NOT_MAPPED_REASON,
          "launch"
        );
        return;
      }

      const repository = this.dependencies.store.getRepository(run.repositoryId);
      if (repository === undefined || repository.source !== "local_git") {
        // Non-local repositories are permanently excluded — never silently skipped.
        this.#settleFailed(run, AUDIT_EXECUTION_LOCAL_REPOSITORY_REQUIRED_REASON, "launch");
        return;
      }

      // Provenance only: manual/schedule drafts stay "manual", repository-event
      // drafts carry their durable event identity into the canonical path.
      const trigger = run.source === "repository_event"
        ? {
            source: "repository_change" as const,
            ...(run.sourceEventId === undefined ? {} : { eventId: run.sourceEventId })
          }
        : { source: "manual" as const };

      const created = await this.dependencies.launch({
        repositoryId: run.repositoryId,
        definitionId,
        trigger
      });

      // Leave the queue WITH the immutable link atomically so the mirror pass
      // (here or after a restart) tracks the canonical outcome truthfully.
      this.dependencies.store.markRunRunning(run.id, { workflowRuntimeRunId: created.runId });
      this.#launchedRuns += 1;
    } catch (error) {
      if (isTransitionConflict(error)) {
        // Rare race: a launch produced a workflow run while a concurrent
        // cancel moved the audit run out of the lifecycle first. Record it.
        this.#recordFailure({
          runId: run.id,
          phase: "launch",
          error: new Error(`${LINK_CONFLICT_NOTE}: ${describeExecutionError(error)}`)
        });
        return;
      }
      // Re-read after launch/link failures: the original claim may have been
      // concurrently cancelled or partially recovered and is not authoritative.
      const latest = this.dependencies.store.getAuditRun(run.id) ?? run;
      // One attempt only: persist the honest terminal reason and stop.
      this.#settleFailed(latest, describeExecutionError(error), "launch");
    }
  }

  async #mirrorInFlight(): Promise<void> {
    for (const run of this.dependencies.store.listLinkedRunningRuns()) {
      if (this.#executingRunId === run.id) continue; // still being drained this tick
      const link = run.workflowRuntimeRunId;
      if (link === undefined) continue;
      const linked = this.dependencies.getWorkflowRuntimeRun(link);
      if (linked === undefined || linked.status === "running") continue;
      this.#mirrorOutcome(run, linked.status, linked.error, "mirror");
    }
  }

  #mirrorOutcome(
    run: AuditRun,
    status: WorkflowRuntimeRunStatusView["status"],
    linkedError: string | undefined,
    phase: "mirror" | "reconcile"
  ): void {
    if (status === "succeeded") {
      try {
        if (!this.#ensureRunning(run)) return;
        this.dependencies.store.markRunTerminal(run.id, "succeeded");
        this.#mirroredSucceededRuns += 1;
      } catch (error) {
        if (!isTransitionConflict(error)) {
          this.#recordFailure({ runId: run.id, phase, error });
        }
      }
      return;
    }
    this.#settleFailed(
      run,
      linkedError?.trim()
        ? sanitizeExecutionError(`workflow runtime run '${run.workflowRuntimeRunId}' failed: ${linkedError}`)
        : `workflow runtime run '${run.workflowRuntimeRunId}' failed without a reported reason`,
      phase,
      { preserveLink: true }
    );
  }

  /**
   * Legacy queued runs join `running` first (lifecycle invariant: terminals
   * accept only from running) while preserving their immutable link — a
   * settled restart case keeps the workflow-run provenance it already had.
   */
  #ensureRunning(run: AuditRun): boolean {
    if (run.status === "running") return true;
    if (run.status !== "queued") return false;
    this.dependencies.store.markRunRunning(run.id, {
      ...(run.workflowRuntimeRunId === undefined ? {} : { workflowRuntimeRunId: run.workflowRuntimeRunId })
    });
    return true;
  }

  /** Terminal-honest settling: leave the queue, then fail with the reason. */
  #settleFailed(
    run: AuditRun,
    reason: string,
    phase: "launch" | "mirror" | "reconcile",
    options: { preserveLink?: boolean } = {}
  ): void {
    try {
      if (run.status === "queued" && !options.preserveLink) {
        // Controlled recovery transition avoids a second markRunRunning call
        // after link persistence failed and leaves the row permanently queued.
        this.dependencies.store.markRunFailedFromQueued(run.id, { executionError: reason });
      } else {
        if (!this.#ensureRunning(run)) {
          // Not claimable into running anymore (cancelled / owned elsewhere).
          return;
        }
        this.dependencies.store.markRunTerminal(run.id, "failed", { executionError: reason });
      }
      this.#failedRuns += 1;
      // Honest failures are visible, never silent — surface them sanitized.
      this.#recordFailure({ runId: run.id, phase, error: new Error(reason) });
    } catch (error) {
      if (isTransitionConflict(error)) {
        // A concurrent cancel owns the lifecycle now; its events stay honest.
        return;
      }
      this.#recordFailure({ runId: run.id, phase, error });
    }
  }

  #recordFailure(failure: { runId?: string; phase: "tick" | "launch" | "mirror" | "reconcile"; error: unknown }): void {
    this.#lastError = failure.error instanceof Error ? failure.error.message : String(failure.error);
    this.dependencies.onError?.(failure);
  }
}
