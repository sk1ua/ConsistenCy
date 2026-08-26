/**
 * Workflow trigger planning + execution (CKPT5).
 *
 * Slice responsibility: turn PERSISTED RepositoryEvents into durable,
 * deduplicated trigger plans for enabled `on_change` workflow bindings, and
 * (see WorkflowTriggerExecutor) execute claimed plans through the EXISTING
 * binding-gated canonical path — never a second execution world.
 *
 * Authority model (unchanged from CKPT3):
 *   - A trigger mode on a binding is DATA/intent. It never widens any
 *     capability: execution resolves the latest validated revision and the
 *     Kernel authorizes every protected syscall per-call.
 *   - The planner captures intent only (event × binding); ALL execution
 *     gates (binding exists / enabled / definition exists / validated
 *     revision / pinnable snapshot) are enforced by WorkflowRuntimeHost at
 *     execution time — there is deliberately no second judgment logic here.
 */

import { createHash } from "node:crypto";
import type { RepositoryEvent } from "@consistency/schema";
import { sanitizePublicError } from "../security/redact";
import { WorkflowRuntimeStoreError, type WorkflowRuntimeStore } from "./store";

const PLAN_KEY_DOMAIN = "consistency:workflow-trigger-plan:v1";

/** Stable plan identity for one (repository, definition, repository event). */
export function workflowTriggerPlanDedupeKey(
  event: Pick<RepositoryEvent, "repositoryId" | "dedupeKey">,
  definitionId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([PLAN_KEY_DOMAIN, event.repositoryId, definitionId, event.dedupeKey]))
    .digest("hex");
}

export type WorkflowTriggerPlanOutcome = {
  definitionId: string;
  planId: string;
  created: boolean;
};

export type WorkflowTriggerPlannerStore = Pick<
  WorkflowRuntimeStore,
  "listBindings" | "insertTriggerPlan"
>;

export class WorkflowTriggerPlanner {
  constructor(
    private readonly dependencies: {
      store: WorkflowTriggerPlannerStore;
    },
  ) {}

  /**
   * Idempotently plan one trigger plan per enabled on_change binding of the
   * event's repository. Manual/disabled bindings are simply not consumers of
   * the event; bindings created or flipped to on_change AFTER the event do
   * not retroactively plan (no retroactivity).
   */
  planRepositoryEvent(event: Pick<RepositoryEvent, "id" | "repositoryId" | "dedupeKey">): WorkflowTriggerPlanOutcome[] {
    const outcomes: WorkflowTriggerPlanOutcome[] = [];
    const bindings = this.dependencies.store.listBindings(event.repositoryId);
    for (const binding of bindings) {
      if (!binding.enabled || binding.triggerMode !== "on_change") continue;
      const { created, plan } = this.dependencies.store.insertTriggerPlan({
        repositoryId: event.repositoryId,
        definitionId: binding.definitionId,
        dedupeKey: workflowTriggerPlanDedupeKey(event, binding.definitionId),
        sourceEventId: event.id,
      });
      outcomes.push({ definitionId: binding.definitionId, planId: plan.id, created });
    }
    return outcomes;
  }
}

/** Sanitized failure message for plan/executor error surfacing (no paths/secrets). */
export function describeTriggerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizePublicError(message);
}

// ---------------------------------------------------------------------------
// Executor — drains pending plans through the canonical binding-gated path.
// ---------------------------------------------------------------------------

export type WorkflowTriggerExecutorStatus = {
  running: boolean;
  lastPollAt?: string;
  /** Plan currently being drained (single-flight; absent when idle). */
  executingPlanId?: string;
  createdRuns: number;
  skippedPlans: number;
  failedPlans: number;
};

export type WorkflowTriggerExecutorTimer = {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(timer: unknown): void;
};

export type WorkflowTriggerExecutorStore = Pick<
  WorkflowRuntimeStore,
  "listPendingTriggerPlans" | "claimTriggerPlan" | "completeTriggerPlan"
>;

export type WorkflowTriggerExecuteFn = (input: {
  repositoryId: string;
  definitionId: string;
  trigger: { source: "repository_change"; eventId: string };
}) => Promise<{ runId: string }>;

const DEFAULT_TRIGGER_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TRIGGER_BATCH = 5;

function unrefTimer(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
  }
}

/**
 * Single-flight background drain of pending trigger plans.
 *
 * Semantics:
 *   - One attempt per plan (no retry storm): a claimed plan reaches a terminal
 *     status exactly once; crash-mid-claim is recovered honestly at startup by
 *     the store (`recoverInterruptedTriggerPlans`).
 *   - `succeeded` means the canonical RUN WAS CREATED (runId linked) — the
 *     run's own status tracks execution outcome, never the plan.
 *   - `skipped` means the consuming binding no longer exists / is disabled at
 *     execution time (the intent went away — not an execution failure).
 *   - `failed` carries a sanitized reason (snapshot unavailable, definition
 *     not executable, store failure, ...).
 *
 * The executor grants nothing: every protected syscall inside the run is
 * authorized per-call by the Kernel, exactly like a manual trigger.
 */
export class WorkflowTriggerExecutor {
  #running = false;
  #inFlight = false;
  #timer?: unknown;
  #lastPollAt?: string;
  #executingPlanId?: string;
  #createdRuns = 0;
  #skippedPlans = 0;
  #failedPlans = 0;

  constructor(
    private readonly dependencies: {
      store: WorkflowTriggerExecutorStore;
      trigger: WorkflowTriggerExecuteFn;
      pollIntervalMs?: number;
      batchSize?: number;
      timer?: WorkflowTriggerExecutorTimer;
      now?: () => Date;
      onError?: (failure: { planId: string; error: unknown }) => void;
    },
  ) {}

  get status(): WorkflowTriggerExecutorStatus {
    return {
      running: this.#running,
      ...(this.#lastPollAt === undefined ? {} : { lastPollAt: this.#lastPollAt }),
      ...(this.#executingPlanId === undefined ? {} : { executingPlanId: this.#executingPlanId }),
      createdRuns: this.#createdRuns,
      skippedPlans: this.#skippedPlans,
      failedPlans: this.#failedPlans,
    };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const timer = this.dependencies.timer ?? {
      setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
      clearInterval: (handle: unknown) => clearInterval(handle as NodeJS.Timeout),
    };
    const intervalMs = this.dependencies.pollIntervalMs ?? DEFAULT_TRIGGER_POLL_INTERVAL_MS;
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
        clearInterval: (handle: unknown) => clearInterval(handle as NodeJS.Timeout),
      };
      timer.clearInterval(this.#timer);
    }
    this.#timer = undefined;
    this.#running = false;
  }

  /** One drain pass; overlapping ticks are ignored (single-flight). */
  async tick(): Promise<void> {
    if (this.#inFlight) return;
    this.#inFlight = true;
    try {
      await this.#drain();
    } finally {
      this.#inFlight = false;
      this.#lastPollAt = (this.dependencies.now?.() ?? new Date()).toISOString();
    }
  }

  async #drain(): Promise<void> {
    const batchSize = this.dependencies.batchSize ?? DEFAULT_TRIGGER_BATCH;
    for (const candidate of this.dependencies.store.listPendingTriggerPlans(batchSize)) {
      const plan = this.dependencies.store.claimTriggerPlan(candidate.id);
      if (plan === undefined) continue; // someone else claimed it (fenced)
      this.#executingPlanId = plan.id;
      try {
        await this.#execute(plan);
      } finally {
        this.#executingPlanId = undefined;
      }
    }
  }

  async #execute(plan: { id: string; repositoryId: string; definitionId: string; sourceEventId: string }): Promise<void> {
    try {
      const created = await this.dependencies.trigger({
        repositoryId: plan.repositoryId,
        definitionId: plan.definitionId,
        trigger: { source: "repository_change", eventId: plan.sourceEventId },
      });
      this.dependencies.store.completeTriggerPlan({ id: plan.id, status: "succeeded", runId: created.runId });
      this.#createdRuns += 1;
    } catch (error) {
      // Binding gates: the consuming intent went away → skipped, not failed.
      const skipped = error instanceof WorkflowRuntimeStoreError
        && (error.code === "WORKFLOW_BINDING_NOT_FOUND" || error.code === "WORKFLOW_BINDING_DISABLED");
      if (skipped) {
        this.dependencies.store.completeTriggerPlan({ id: plan.id, status: "skipped", error: describeTriggerError(error) });
        this.#skippedPlans += 1;
      } else {
        this.dependencies.store.completeTriggerPlan({ id: plan.id, status: "failed", error: describeTriggerError(error) });
        this.#failedPlans += 1;
        this.dependencies.onError?.({ planId: plan.id, error });
      }
    }
  }
}
