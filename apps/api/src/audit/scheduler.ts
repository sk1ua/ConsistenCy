import { createHash } from "node:crypto";
import {
  automationScheduleStateSchema,
  automationScheduleWindowSchema,
  cronScheduleSpecSchema,
  type Automation,
  type AutomationScheduleState,
  type AutomationScheduleWindow
} from "@consistency/schema";
import { sanitizePublicError } from "../security/redact";
import { nextCronOccurrence } from "./cron";
import type { AuditRunPlanner } from "./planner";
import type { AuditDomainStore } from "./store";

type AutomationSchedulerStore = Pick<
  AuditDomainStore,
  | "completeAutomationScheduleWindow"
  | "ensureAutomationScheduleState"
  | "getAutomationScheduleState"
  | "listAutomations"
>;

export type AutomationSchedulerTimer = {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(timer: unknown): void;
};

export type AutomationSchedulerDependencies = {
  now?: () => Date;
  timer?: AutomationSchedulerTimer;
  pollIntervalMs?: number;
  windowGraceMs?: number;
  onError?: (failure: { automationId: string; error: unknown }) => void;
};

export type AutomationSchedulerTickResult = {
  automationId: string;
  outcome: "initialized" | "waiting" | "created" | "coalesced" | "skipped" | "invalid" | "stale" | "error";
  scheduledFor?: string;
  auditRunId?: string;
};

const defaultTimer: AutomationSchedulerTimer = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: timer => clearInterval(timer as NodeJS.Timeout)
};

function unrefTimer(timer: unknown): void {
  if (typeof timer !== "object" || timer === null || !("unref" in timer)) return;
  const unref = (timer as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);
}

function windowId(automationId: string, scheduledFor: string): string {
  return `schedule_window_${createHash("sha256")
    .update(JSON.stringify([automationId, scheduledFor]))
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * Minute-window scheduler that only asks AuditRunPlanner for durable drafts.
 * It never queues or executes a workflow and missed windows are never replayed.
 */
export class AutomationScheduler {
  private readonly now: () => Date;
  private readonly timer: AutomationSchedulerTimer;
  private readonly pollIntervalMs: number;
  private readonly windowGraceMs: number;
  private interval: unknown;
  private running = false;

  constructor(
    private readonly store: AutomationSchedulerStore,
    private readonly planner: Pick<AuditRunPlanner, "planScheduleRun">,
    private readonly dependencies: AutomationSchedulerDependencies = {}
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.timer = dependencies.timer ?? defaultTimer;
    this.pollIntervalMs = dependencies.pollIntervalMs ?? 15_000;
    this.windowGraceMs = dependencies.windowGraceMs ?? 60_000;
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new RangeError("pollIntervalMs must be a positive integer");
    }
    if (!Number.isInteger(this.windowGraceMs) || this.windowGraceMs <= 0) {
      throw new RangeError("windowGraceMs must be a positive integer");
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The public capability is truthful only while the lifecycle is active. */
  get available(): boolean {
    return this.running;
  }

  start(): AutomationSchedulerTickResult[] {
    if (this.running) return [];
    this.running = true;
    try {
      const results = this.tick();
      this.interval = this.timer.setInterval(() => {
        try {
          this.tick();
        } catch (error) {
          this.reportError("automation_scheduler", error);
        }
      }, this.pollIntervalMs);
      unrefTimer(this.interval);
      return results;
    } catch (error) {
      this.running = false;
      this.interval = undefined;
      throw error;
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.interval !== undefined) this.timer.clearInterval(this.interval);
    this.interval = undefined;
  }

  tick(): AutomationSchedulerTickResult[] {
    if (!this.running) return [];
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new TypeError("Scheduler clock returned an invalid Date");
    return this.store.listAutomations()
      .filter(automation => automation.enabled && automation.trigger.type === "schedule")
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(automation => this.evaluateAutomation(automation, now));
  }

  private evaluateAutomation(automation: Automation, now: Date): AutomationSchedulerTickResult {
    let spec: ReturnType<typeof cronScheduleSpecSchema.parse>;
    try {
      spec = cronScheduleSpecSchema.parse(automation.trigger);
    } catch (error) {
      const message = sanitizePublicError(error instanceof Error ? error.message : "Invalid schedule configuration")
        .slice(0, 2_000);
      try {
        this.store.ensureAutomationScheduleState(automationScheduleStateSchema.parse({
          automationId: automation.id,
          cron: automation.trigger.type === "schedule" ? automation.trigger.cron : "invalid",
          timezone: automation.trigger.type === "schedule" ? automation.trigger.timezone : "invalid",
          status: "invalid",
          error: message,
          updatedAt: now.toISOString()
        }));
        this.reportError(automation.id, error);
        return { automationId: automation.id, outcome: "invalid" };
      } catch (persistenceError) {
        this.reportError(automation.id, persistenceError);
        return { automationId: automation.id, outcome: "error" };
      }
    }

    try {
      let state = this.store.getAutomationScheduleState(automation.id);
      if (
        state === undefined
        || state.cron !== spec.cron
        || state.timezone !== spec.timezone
        || state.status !== "scheduled"
      ) {
        state = this.store.ensureAutomationScheduleState(automationScheduleStateSchema.parse({
          automationId: automation.id,
          cron: spec.cron,
          timezone: spec.timezone,
          status: "scheduled",
          nextScheduledAt: nextCronOccurrence(spec.cron, spec.timezone, now).toISOString(),
          updatedAt: now.toISOString()
        }));
        if (new Date(state.nextScheduledAt!).getTime() > now.getTime()) {
          return { automationId: automation.id, outcome: "initialized" };
        }
      }

      const scheduledFor = state.nextScheduledAt!;
      const scheduledTime = new Date(scheduledFor);
      if (scheduledTime.getTime() > now.getTime()) {
        return { automationId: automation.id, outcome: "waiting", scheduledFor };
      }

      if (now.getTime() - scheduledTime.getTime() >= this.windowGraceMs) {
        const nextScheduledAt = nextCronOccurrence(spec.cron, spec.timezone, now).toISOString();
        const window = automationScheduleWindowSchema.parse({
          id: windowId(automation.id, scheduledFor),
          automationId: automation.id,
          scheduledFor,
          outcome: "skipped",
          reason: "missed_window_policy_skip",
          recordedAt: now.toISOString()
        });
        const recorded = this.store.completeAutomationScheduleWindow({
          expectedScheduledFor: scheduledFor,
          window,
          nextScheduledAt
        });
        return {
          automationId: automation.id,
          outcome: recorded === undefined ? "stale" : recorded.outcome,
          scheduledFor,
          auditRunId: recorded?.auditRunId
        };
      }

      const planning = this.planner.planScheduleRun(automation.id, scheduledFor);
      const outcome = planning.receipt.disposition;
      const nextScheduledAt = nextCronOccurrence(spec.cron, spec.timezone, scheduledTime).toISOString();
      const window: AutomationScheduleWindow = automationScheduleWindowSchema.parse({
        id: windowId(automation.id, scheduledFor),
        automationId: automation.id,
        scheduledFor,
        outcome,
        planningReceiptId: planning.receipt.id,
        auditRunId: planning.auditRun.id,
        recordedAt: now.toISOString()
      });
      const recorded = this.store.completeAutomationScheduleWindow({
        expectedScheduledFor: scheduledFor,
        window,
        nextScheduledAt
      });
      return {
        automationId: automation.id,
        outcome: recorded === undefined ? "stale" : recorded.outcome,
        scheduledFor,
        auditRunId: planning.auditRun.id
      };
    } catch (error) {
      this.reportError(automation.id, error);
      return { automationId: automation.id, outcome: "error" };
    }
  }

  private reportError(automationId: string, error: unknown): void {
    try {
      this.dependencies.onError?.({ automationId, error });
    } catch {
      // Observability callbacks must not stop other automations being evaluated.
    }
  }
}
