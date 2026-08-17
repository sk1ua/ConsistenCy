import { describe, expect, it, vi } from "vitest";
import { workflowSpecSchema } from "@consistency/schema";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { AuditRunPlanner } from "./planner";
import { AutomationScheduler, type AutomationSchedulerTimer } from "./scheduler";
import { SQLiteAuditDomainStore } from "./store";

const workflowSpec = workflowSpecSchema.parse({
  version: 2,
  name: "scheduled-safety",
  nodes: [{ id: "security", uses: "engine.security" }],
  verifiers: [{ id: "syntax", uses: "verify.syntax", needs: ["security"] }],
  synthesizer: { needs: ["syntax"] }
});

function fixture() {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const store = new SQLiteAuditDomainStore(database);
  const repository = store.createRepository({
    displayName: "scheduled-repository",
    source: "local_git",
    monitoringEnabled: true
  }, { serverLocator: "D:/server-only/scheduled-repository" });
  const workflow = store.createWorkflowRevision({ workflowId: "scheduled-safety", spec: workflowSpec });
  const policy = store.createPolicyRevision({
    policyId: "scheduled-safety",
    name: "Scheduled safety",
    requiredChecks: ["syntax"],
    minimumCoverage: 1,
    warnAtRiskScore: 40,
    failAtRiskScore: 70,
    enforcement: "advisory"
  });
  const schedule = store.createAutomation({
    repositoryId: repository.id,
    name: "Every minute",
    trigger: { type: "schedule", cron: "* * * * *", timezone: "UTC", missedRunPolicy: "skip" },
    workflowRevisionId: workflow.id,
    policyRevisionId: policy.id,
    executionProfile: "static_readonly",
    enabled: true
  });
  const manual = store.createAutomation({
    repositoryId: repository.id,
    name: "Manual only",
    trigger: { type: "manual" },
    workflowRevisionId: workflow.id,
    policyRevisionId: policy.id,
    executionProfile: "static_readonly",
    enabled: true
  });
  return { database, store, repository, workflow, policy, schedule, manual };
}

function fakeTimer() {
  const callbacks = new Map<object, () => void>();
  const clearInterval = vi.fn((timer: unknown) => { callbacks.delete(timer as object); });
  const timer: AutomationSchedulerTimer = {
    setInterval(callback) {
      const handle = {};
      callbacks.set(handle, callback);
      return handle;
    },
    clearInterval
  };
  return { callbacks, clearInterval, timer };
}

describe("AutomationScheduler", () => {
  it("plans a due schedule window once and persists restart-safe state", () => {
    const { database, store, schedule, manual } = fixture();
    try {
      let now = new Date("2026-08-14T10:00:30.000Z");
      const timers = fakeTimer();
      const planner = new AuditRunPlanner(store);
      const scheduler = new AutomationScheduler(store, planner, {
        now: () => now,
        timer: timers.timer,
        pollIntervalMs: 5_000
      });
      expect(scheduler.available).toBe(false);
      expect(scheduler.start()).toEqual([{
        automationId: schedule.id,
        outcome: "initialized"
      }]);
      expect(scheduler.isRunning).toBe(true);
      expect(scheduler.available).toBe(true);
      expect(store.getAutomationScheduleState(schedule.id)).toMatchObject({
        status: "scheduled",
        nextScheduledAt: "2026-08-14T10:01:00.000Z"
      });
      expect(store.getAutomationScheduleState(manual.id)).toBeUndefined();

      now = new Date("2026-08-14T10:01:05.000Z");
      expect(scheduler.tick()).toMatchObject([{
        automationId: schedule.id,
        outcome: "created",
        scheduledFor: "2026-08-14T10:01:00.000Z"
      }]);
      const runs = store.listAuditRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ source: "schedule", status: "created" });
      expect(store.listAutomationScheduleWindows(schedule.id)).toMatchObject([{
        outcome: "created",
        auditRunId: runs[0]!.id
      }]);
      expect(store.getAutomationScheduleState(schedule.id)).toMatchObject({
        nextScheduledAt: "2026-08-14T10:02:00.000Z",
        lastOutcome: "created",
        lastAuditRunId: runs[0]!.id
      });

      expect(scheduler.tick()[0]).toMatchObject({ outcome: "waiting" });
      expect(store.listAuditRuns()).toHaveLength(1);
      scheduler.stop();
      expect(scheduler.isRunning).toBe(false);
      expect(scheduler.available).toBe(false);
      expect(timers.clearInterval).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("records an overdue window as skipped and never catches it up", () => {
    const { database, store, schedule } = fixture();
    try {
      let now = new Date("2026-08-14T10:00:30.000Z");
      const planner = new AuditRunPlanner(store);
      const first = new AutomationScheduler(store, planner, { now: () => now });
      first.start();
      first.stop();

      now = new Date("2026-08-14T10:03:05.000Z");
      const restarted = new AutomationScheduler(store, planner, { now: () => now });
      expect(restarted.start()).toMatchObject([{
        automationId: schedule.id,
        outcome: "skipped",
        scheduledFor: "2026-08-14T10:01:00.000Z"
      }]);
      expect(store.listAuditRuns()).toEqual([]);
      expect(store.listAutomationScheduleWindows(schedule.id)).toMatchObject([{
        scheduledFor: "2026-08-14T10:01:00.000Z",
        outcome: "skipped",
        reason: "missed_window_policy_skip"
      }]);
      expect(store.getAutomationScheduleState(schedule.id)).toMatchObject({
        nextScheduledAt: "2026-08-14T10:04:00.000Z",
        lastOutcome: "skipped"
      });
      restarted.stop();
    } finally {
      database.close();
    }
  });

  it("keeps run-now independent from next schedule and coalesces the due window", () => {
    const { database, store, schedule } = fixture();
    try {
      let now = new Date("2026-08-14T10:00:30.000Z");
      const planner = new AuditRunPlanner(store, { createManualNonce: () => "run-now" });
      const scheduler = new AutomationScheduler(store, planner, { now: () => now });
      scheduler.start();
      const before = store.getAutomationScheduleState(schedule.id)!;
      const manual = planner.planManualRun(schedule.id);
      expect(manual.auditRun.source).toBe("manual");
      expect(store.getAutomationScheduleState(schedule.id)).toEqual(before);

      now = new Date("2026-08-14T10:01:05.000Z");
      expect(scheduler.tick()).toMatchObject([{
        automationId: schedule.id,
        outcome: "coalesced",
        auditRunId: manual.auditRun.id
      }]);
      expect(store.listAuditRuns()).toHaveLength(1);
      expect(store.listAutomationScheduleWindows(schedule.id)[0]).toMatchObject({
        outcome: "coalesced",
        auditRunId: manual.auditRun.id
      });
      scheduler.stop();
    } finally {
      database.close();
    }
  });

  it("isolates invalid persisted cron specs without affecting healthy schedules", () => {
    const { database, store, schedule, manual } = fixture();
    try {
      database.prepare("UPDATE automations SET trigger_json = ? WHERE id = ?")
        .run(JSON.stringify({ type: "schedule", cron: "@daily", timezone: "UTC", missedRunPolicy: "skip" }), manual.id);
      const failures = vi.fn();
      const scheduler = new AutomationScheduler(store, new AuditRunPlanner(store), {
        now: () => new Date("2026-08-14T10:00:30.000Z"),
        onError: failures
      });
      expect(scheduler.start()).toEqual(expect.arrayContaining([
        expect.objectContaining({ automationId: schedule.id, outcome: "initialized" }),
        expect.objectContaining({ automationId: manual.id, outcome: "invalid" })
      ]));
      expect(store.getAutomationScheduleState(manual.id)).toMatchObject({ status: "invalid" });
      expect(store.getAutomationScheduleState(schedule.id)).toMatchObject({ status: "scheduled" });
      expect(failures).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally {
      database.close();
    }
  });
});
