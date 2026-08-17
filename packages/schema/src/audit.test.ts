import { describe, expect, it } from "vitest";
import {
  AUDIT_DRAFT_ONLY_EXECUTION_REASON,
  automationScheduleStateSchema,
  automationScheduleWindowSchema,
  auditRunPlanningResultSchema,
  automationTriggerSchema,
  cronScheduleSpecSchema,
  evaluateAuditPolicy,
  internalLocalRepositoryRegistrationRequestSchema,
  policyEvaluationSchema,
  planAuditRunDraftRequestSchema,
  repositorySchema,
  repositoryEventSchema,
  repositoryPulseSchema,
  riskScoreSchema
} from "./audit";

const policy = {
  requiredChecks: ["security", "syntax-gate"],
  minimumCoverage: 1,
  warnAtRiskScore: 40,
  failAtRiskScore: 70
};

describe("audit control-plane schemas", () => {
  it("keeps Repository renderer DTOs free of absolute paths", () => {
    const safe = repositorySchema.parse({
      id: "repo_1",
      displayName: "sk1ua/ConsistenCy",
      source: "github",
      remoteFullName: "sk1ua/ConsistenCy",
      trustLevel: "untrusted_readonly",
      monitoringEnabled: true,
      createdAt: "2026-08-14T10:00:00.000Z",
      updatedAt: "2026-08-14T10:00:00.000Z"
    });
    expect(safe.displayName).toBe("sk1ua/ConsistenCy");
    expect(safe).not.toHaveProperty("path");
    expect(safe).not.toHaveProperty("root");
    expect(safe).not.toHaveProperty("locator");

    expect(() => repositorySchema.parse({ ...safe, displayName: "C:\\private\\repo" })).toThrow(/absolute path/i);
    expect(() => repositorySchema.parse({ ...safe, repoPath: "C:\\private\\repo" })).toThrow();
  });

  it("keeps the internal registration path request separate from pulse and repository responses", () => {
    expect(internalLocalRepositoryRegistrationRequestSchema.parse({
      path: "D:/private/repository"
    })).toMatchObject({ monitoringEnabled: true });
    const pulse = {
      pulseId: "pulse_1",
      repositoryId: "repo_1",
      state: "idle",
      observedAt: "2026-08-14T10:00:00.000Z",
      dirtyFileCount: 0,
      pendingEvents: 0
    };
    expect(repositoryPulseSchema.parse(pulse)).toEqual(pulse);
    expect(() => repositoryPulseSchema.parse({ ...pulse, root: "D:/private/repository" })).toThrow();
  });

  it("uses risk scores where higher always means more dangerous", () => {
    expect(riskScoreSchema.parse(0)).toBe(0);
    expect(riskScoreSchema.parse(100)).toBe(100);
    expect(evaluateAuditPolicy(policy, {
      riskScore: 75,
      coverage: 1,
      completedChecks: ["security", "syntax-gate"]
    }).outcome).toBe("fail");
    expect(evaluateAuditPolicy(policy, {
      riskScore: 45,
      coverage: 1,
      completedChecks: ["security", "syntax-gate"]
    }).outcome).toBe("warn");
    expect(evaluateAuditPolicy(policy, {
      riskScore: 10,
      coverage: 1,
      completedChecks: ["security", "syntax-gate"]
    }).outcome).toBe("pass");
  });

  it("forces unknown when any required check is missing", () => {
    const evaluation = evaluateAuditPolicy(policy, {
      riskScore: 5,
      coverage: 0.5,
      completedChecks: ["security"]
    });
    expect(evaluation).toMatchObject({
      outcome: "unknown",
      missingRequiredChecks: ["syntax-gate"]
    });

    expect(() => policyEvaluationSchema.parse({
      ...evaluation,
      outcome: "pass"
    })).toThrow(/force policy outcome to unknown/i);
  });

  it("locks milestone-one missed schedules to skip", () => {
    expect(automationTriggerSchema.parse({
      type: "schedule",
      cron: "0 3 * * *",
      timezone: "UTC"
    })).toMatchObject({ missedRunPolicy: "skip" });
    expect(() => automationTriggerSchema.parse({
      type: "schedule",
      cron: "0 3 * * *",
      timezone: "UTC",
      missedRunPolicy: "run_once"
    })).toThrow();
  });

  it("models durable draft planning without claiming execution", () => {
    const request = {
      planningKey: "a".repeat(64),
      repositoryId: "repo_1",
      automationId: "automation_1",
      workflowRevisionId: "workflow_revision_1",
      workflowDigest: "b".repeat(64),
      policyRevisionId: "policy_revision_1",
      executionProfile: "static_readonly" as const,
      source: "repository_event" as const,
      sourceEventId: "event_1"
    };
    expect(planAuditRunDraftRequestSchema.parse(request)).toEqual(request);
    expect(() => planAuditRunDraftRequestSchema.parse({
      ...request,
      sourceEventId: undefined
    })).toThrow(/requires sourceEventId/i);
    expect(() => planAuditRunDraftRequestSchema.parse({
      ...request,
      source: "manual"
    })).toThrow(/Only repository-event planning/i);

    const auditRun = {
      id: "audit_run_1",
      repositoryId: "repo_1",
      source: "repository_event" as const,
      sourceEventId: "event_1",
      automationId: "automation_1",
      workflowRevisionId: "workflow_revision_1",
      policyRevisionId: "policy_revision_1",
      executionProfile: "static_readonly" as const,
      status: "created" as const,
      publicationStatus: "skipped" as const,
      createdAt: "2026-08-14T10:00:00.000Z"
    };
    const result = {
      disposition: "created" as const,
      reason: "new_draft" as const,
      receipt: {
        id: "planning_receipt_1",
        planningKey: request.planningKey,
        repositoryId: request.repositoryId,
        automationId: request.automationId,
        workflowDigest: request.workflowDigest,
        source: request.source,
        sourceEventId: request.sourceEventId,
        auditRunId: auditRun.id,
        disposition: "created" as const,
        createdAt: auditRun.createdAt
      },
      auditRun,
      execution: {
        available: false as const,
        reason: AUDIT_DRAFT_ONLY_EXECUTION_REASON
      }
    };
    expect(auditRunPlanningResultSchema.parse(result)).toEqual(result);
    expect(() => auditRunPlanningResultSchema.parse({
      ...result,
      disposition: "coalesced",
      reason: "new_draft"
    })).toThrow(/do not agree/i);
  });

  it("validates the supported cron5 schedule subset and durable scheduler state", () => {
    expect(cronScheduleSpecSchema.parse({
      cron: "*/15 9-17 * * 1-5",
      timezone: "Asia/Hong_Kong"
    })).toMatchObject({ missedRunPolicy: "skip" });
    expect(() => cronScheduleSpecSchema.parse({
      cron: "@daily",
      timezone: "UTC"
    })).toThrow(/five-field numeric cron/i);
    expect(() => cronScheduleSpecSchema.parse({
      cron: "0 3 * * *",
      timezone: "Mars/Olympus_Mons"
    })).toThrow(/IANA timezone/i);

    const state = {
      automationId: "automation_1",
      cron: "0 3 * * *",
      timezone: "UTC",
      status: "scheduled" as const,
      nextScheduledAt: "2026-08-15T03:00:00.000Z",
      updatedAt: "2026-08-14T10:00:00.000Z"
    };
    expect(automationScheduleStateSchema.parse(state)).toEqual(state);
    expect(() => automationScheduleStateSchema.parse({
      ...state,
      status: "invalid",
      nextScheduledAt: undefined
    })).toThrow(/requires an error/i);

    const skippedWindow = {
      id: "schedule_window_1",
      automationId: "automation_1",
      scheduledFor: "2026-08-14T03:00:00.000Z",
      outcome: "skipped" as const,
      reason: "missed_window_policy_skip" as const,
      recordedAt: "2026-08-14T10:00:00.000Z"
    };
    expect(automationScheduleWindowSchema.parse(skippedWindow)).toEqual(skippedWindow);
    expect(() => automationScheduleWindowSchema.parse({
      ...skippedWindow,
      reason: undefined
    })).toThrow(/requires a reason/i);

    expect(planAuditRunDraftRequestSchema.parse({
      planningKey: "c".repeat(64),
      repositoryId: "repo_1",
      automationId: "automation_1",
      workflowRevisionId: "workflow_revision_1",
      workflowDigest: "b".repeat(64),
      policyRevisionId: "policy_revision_1",
      executionProfile: "static_readonly",
      source: "schedule",
      scheduledFor: "2026-08-15T03:00:00.000Z"
    })).toMatchObject({ source: "schedule" });
  });

  it("rejects absolute or traversing paths in repository events", () => {
    const base = {
      id: "event_1",
      repositoryId: "repo_1",
      type: "working_tree",
      source: "local_git",
      dedupeKey: "head:working-tree",
      occurredAt: "2026-08-14T10:00:00.000Z",
      metadata: {}
    } as const;
    expect(() => repositoryEventSchema.parse({
      ...base,
      changedFiles: [{
        path: "C:\\private\\repo\\secret.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
        hunks: []
      }]
    })).toThrow(/repository-relative/i);
    expect(() => repositoryEventSchema.parse({
      ...base,
      changedFiles: [{
        path: "../secret.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
        hunks: []
      }]
    })).toThrow(/repository-relative/i);
    expect(() => repositoryEventSchema.parse({
      ...base,
      changedFiles: [{
        path: "src/renamed.ts",
        previousPath: "/private/repository/original.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        binary: false,
        hunks: []
      }]
    })).toThrow(/repository-relative/i);
    expect(() => repositoryEventSchema.parse({
      ...base,
      changedFiles: [],
      metadata: { checkoutRoot: "D:\\private\\repository" }
    })).toThrow(/must not expose absolute paths/i);
  });
});
