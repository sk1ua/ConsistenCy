import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowSpecSchema } from "@consistency/schema";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { AuditDomainError, SQLiteAuditDomainStore } from "./store";

const workflowSpec = workflowSpecSchema.parse({
  version: 2,
  name: "vibe-safety",
  nodes: [{ id: "security", uses: "engine.security" }],
  verifiers: [{ id: "syntax-gate", uses: "verify.syntax", needs: ["security"] }],
  synthesizer: { needs: ["syntax-gate"] }
});

function fixture(database = openDatabase(":memory:")) {
  runMigrations(database);
  const store = new SQLiteAuditDomainStore(database);
  const repository = store.createRepository({
    displayName: "local-project",
    source: "local_git",
    monitoringEnabled: true
  }, {
    serverLocator: "D:/private/work/local-project",
    trustLevel: "trusted_local"
  });
  const workflow = store.createWorkflowRevision({ workflowId: "vibe-safety", spec: workflowSpec });
  const policy = store.createPolicyRevision({
    policyId: "default-safety",
    name: "Default safety",
    requiredChecks: ["security", "syntax-gate"],
    minimumCoverage: 1,
    warnAtRiskScore: 40,
    failAtRiskScore: 70,
    enforcement: "advisory"
  });
  return { database, store, repository, workflow, policy };
}

describe("SQLiteAuditDomainStore", () => {
  it("keeps server locators in SQLite and never returns them in Repository DTOs", () => {
    const { database, store, repository } = fixture();
    try {
      expect(repository).not.toHaveProperty("serverLocator");
      expect(repository).not.toHaveProperty("repoPath");
      expect(JSON.stringify(store.listRepositories())).not.toContain("D:/private/work");
      expect(() => store.createRepository({
        displayName: "unlocated-local-project",
        source: "local_git"
      })).toThrowError(/server-side locator/i);

      const row = database.prepare("SELECT server_locator FROM repositories WHERE id = ?").get(repository.id) as { server_locator: string };
      expect(row.server_locator.replace(/\\/g, "/")).toContain("D:/private/work/local-project");
    } finally {
      database.close();
    }
  });

  it("persists revisions, automation definitions, honest run drafts, and issue actions", () => {
    const { database, store, repository, workflow, policy } = fixture();
    try {
      const duplicateRevision = store.createWorkflowRevision({ workflowId: "vibe-safety", spec: workflowSpec });
      expect(duplicateRevision.id).toBe(workflow.id);

      const automation = store.createAutomation({
        repositoryId: repository.id,
        name: "On local change",
        trigger: { type: "repository_event", eventTypes: ["working_tree"], debounceMs: 5_000 },
        workflowRevisionId: workflow.id,
        policyRevisionId: policy.id,
        executionProfile: "trusted_sandbox",
        enabled: true
      });
      expect(store.setAutomationEnabled(automation.id, false).enabled).toBe(false);

      const run = store.createAuditRunDraft({
        repositoryId: repository.id,
        source: "manual",
        automationId: automation.id,
        workflowRevisionId: workflow.id,
        policyRevisionId: policy.id,
        executionProfile: "trusted_sandbox",
        headRevision: "WORKING_TREE"
      });
      expect(run).toMatchObject({ status: "created", publicationStatus: "skipped" });

      const issue = store.createIssue({
        repositoryId: repository.id,
        fingerprint: "security:src/app.ts:eval",
        ruleId: "security.eval",
        title: "Dynamic code execution",
        severity: "high",
        confidence: "confirmed",
        location: { file: "src/app.ts", startLine: 10, endLine: 10 },
        evidenceSummary: "eval(userInput)",
        firstSeenRunId: run.id,
        lastSeenRunId: run.id,
        tags: ["vibe-safety"]
      });
      expect(store.applyIssueAction(issue.id, "review", "Owner notified")).toMatchObject({
        state: "reviewing",
        stateReason: "Owner notified"
      });
      expect(store.applyIssueAction(issue.id, "accept_risk", "Sandboxed prototype")).toMatchObject({
        state: "accepted_risk",
        stateReason: "Sandboxed prototype"
      });
      expect(store.applyIssueAction(issue.id, "reopen", "Threat model changed")).toMatchObject({
        state: "open",
        stateReason: "Threat model changed",
        resolvedAt: undefined
      });
      expect(store.applyIssueAction(issue.id, "mark_false_positive", "Rule matched a fixture")).toMatchObject({
        state: "false_positive"
      });
      expect(store.applyIssueAction(issue.id, "reopen")).toMatchObject({ state: "open" });
      expect(store.applyIssueAction(issue.id, "resolve", "Removed eval")).toMatchObject({ state: "resolved" });
      expect(store.cancelAuditRun(run.id).status).toBe("cancelled");
    } finally {
      database.close();
    }
  });

  it("uses repository event dedupe keys idempotently and rejects conflicting replays", () => {
    const { database, store, repository } = fixture();
    try {
      const event = {
        id: "event_original",
        repositoryId: repository.id,
        type: "working_tree" as const,
        source: "local_git" as const,
        dedupeKey: "working-tree:head123:index456",
        occurredAt: "2026-08-14T10:00:00.000Z",
        headRevision: "WORKING_TREE",
        changedFiles: [],
        metadata: { dirtyFileCount: 0 }
      };
      expect(store.saveRepositoryEvent(event)).toEqual(event);
      expect(store.saveRepositoryEvent({ ...event, id: "event_replayed" }).id).toBe("event_original");
      expect(store.saveRepositoryEvent({
        ...event,
        id: "event_replayed_after_restart",
        occurredAt: "2026-08-14T11:00:00.000Z"
      }).id).toBe("event_original");
      expect(store.listRepositoryEvents(repository.id)).toHaveLength(1);

      try {
        store.saveRepositoryEvent({ ...event, id: "event_conflict", headRevision: "different-head" });
        throw new Error("Expected conflicting repository event replay to fail");
      } catch (error) {
        expect(error).toMatchObject({ code: "REPOSITORY_EVENT_CONFLICT", statusCode: 409 });
      }
    } finally {
      database.close();
    }
  });

  it("plans drafts transactionally, deduplicates trigger receipts, and enforces one active run", () => {
    const { database, store, repository, workflow, policy } = fixture();
    try {
      const automation = store.createAutomation({
        repositoryId: repository.id,
        name: "Durable event planning",
        trigger: { type: "repository_event", eventTypes: ["working_tree"], debounceMs: 0 },
        workflowRevisionId: workflow.id,
        policyRevisionId: policy.id,
        executionProfile: "trusted_sandbox",
        enabled: true
      });
      const firstEvent = store.saveRepositoryEvent({
        id: "event_plan_first",
        repositoryId: repository.id,
        type: "working_tree",
        source: "local_git",
        dedupeKey: "plan:first",
        occurredAt: "2026-08-14T10:00:00.000Z",
        changedFiles: [],
        metadata: {}
      });
      const firstInput = {
        planningKey: "1".repeat(64),
        repositoryId: repository.id,
        automationId: automation.id,
        workflowRevisionId: workflow.id,
        workflowDigest: workflow.digest,
        policyRevisionId: policy.id,
        executionProfile: "trusted_sandbox" as const,
        source: "repository_event" as const,
        sourceEventId: firstEvent.id
      };
      const first = store.planAuditRunDraft(firstInput);
      expect(first).toMatchObject({ disposition: "created", auditRun: { status: "created" } });
      expect(store.planAuditRunDraft(firstInput)).toMatchObject({
        disposition: "deduplicated",
        auditRun: { id: first.auditRun.id }
      });
      // The event tuple is independently unique even if a caller derives a
      // different planning key.
      expect(store.planAuditRunDraft({ ...firstInput, planningKey: "2".repeat(64) })).toMatchObject({
        disposition: "deduplicated",
        auditRun: { id: first.auditRun.id }
      });

      const secondEvent = store.saveRepositoryEvent({
        ...firstEvent,
        id: "event_plan_second",
        dedupeKey: "plan:second",
        occurredAt: "2026-08-14T10:01:00.000Z"
      });
      const second = store.planAuditRunDraft({
        ...firstInput,
        planningKey: "3".repeat(64),
        sourceEventId: secondEvent.id
      });
      expect(second).toMatchObject({
        disposition: "coalesced",
        receipt: { disposition: "coalesced" },
        auditRun: { id: first.auditRun.id }
      });
      expect(() => store.createAuditRunDraft({
        repositoryId: repository.id,
        source: "manual",
        automationId: automation.id,
        workflowRevisionId: workflow.id,
        policyRevisionId: policy.id,
        executionProfile: "trusted_sandbox"
      })).toThrowError(/already has an active audit run/i);

      expect(store.cancelAuditRun(first.auditRun.id).status).toBe("cancelled");
      expect(store.planAuditRunDraft({
        ...firstInput,
        planningKey: "3".repeat(64),
        sourceEventId: secondEvent.id
      })).toMatchObject({
        disposition: "deduplicated",
        auditRun: { id: first.auditRun.id, status: "cancelled" }
      });
      expect(store.listAuditRuns(repository.id)).toHaveLength(1);
      expect(store.listAuditRunPlanningReceipts(automation.id)).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("keeps event planning idempotent across independent SQLite connections", () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-planning-concurrency-"));
    const databasePath = join(directory, "audit.db");
    const primaryDatabase = openDatabase(databasePath);
    const secondaryDatabase = openDatabase(databasePath);
    try {
      const { store, repository, workflow, policy } = fixture(primaryDatabase);
      expect(runMigrations(secondaryDatabase)).toEqual([]);
      const secondaryStore = new SQLiteAuditDomainStore(secondaryDatabase);
      const automation = store.createAutomation({
        repositoryId: repository.id,
        name: "Cross-connection planning",
        trigger: { type: "repository_event", eventTypes: ["working_tree"], debounceMs: 0 },
        workflowRevisionId: workflow.id,
        policyRevisionId: policy.id,
        executionProfile: "trusted_sandbox",
        enabled: true
      });
      const event = store.saveRepositoryEvent({
        id: "event_cross_connection",
        repositoryId: repository.id,
        type: "working_tree",
        source: "local_git",
        dedupeKey: "cross-connection",
        occurredAt: "2026-08-14T10:00:00.000Z",
        changedFiles: [],
        metadata: {}
      });
      const input = {
        planningKey: "c".repeat(64),
        repositoryId: repository.id,
        automationId: automation.id,
        workflowRevisionId: workflow.id,
        workflowDigest: workflow.digest,
        policyRevisionId: policy.id,
        executionProfile: "trusted_sandbox" as const,
        source: "repository_event" as const,
        sourceEventId: event.id
      };
      const created = store.planAuditRunDraft(input);
      const replayed = secondaryStore.planAuditRunDraft(input);
      expect(replayed).toMatchObject({
        disposition: "deduplicated",
        auditRun: { id: created.auditRun.id }
      });
      expect(secondaryStore.listAuditRuns(repository.id)).toHaveLength(1);
      expect(secondaryStore.listAuditRunPlanningReceipts(automation.id)).toHaveLength(1);
    } finally {
      secondaryDatabase.close();
      primaryDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists schedule windows with tuple idempotency and compare-and-swap advancement", () => {
    const { database, store, repository, workflow, policy } = fixture();
    try {
      const automation = store.createAutomation({
        repositoryId: repository.id,
        name: "Durable schedule planning",
        trigger: { type: "schedule", cron: "* * * * *", timezone: "UTC", missedRunPolicy: "skip" },
        workflowRevisionId: workflow.id,
        policyRevisionId: policy.id,
        executionProfile: "static_readonly",
        enabled: true
      });
      const scheduledFor = "2026-08-14T10:01:00.000Z";
      store.ensureAutomationScheduleState({
        automationId: automation.id,
        cron: "* * * * *",
        timezone: "UTC",
        status: "scheduled",
        nextScheduledAt: scheduledFor,
        updatedAt: "2026-08-14T10:00:30.000Z"
      });
      const input = {
        planningKey: "d".repeat(64),
        repositoryId: repository.id,
        automationId: automation.id,
        workflowRevisionId: workflow.id,
        workflowDigest: workflow.digest,
        policyRevisionId: policy.id,
        executionProfile: "static_readonly" as const,
        source: "schedule" as const,
        scheduledFor
      };
      const planned = store.planAuditRunDraft(input);
      expect(planned).toMatchObject({
        disposition: "created",
        auditRun: { source: "schedule", scheduledFor }
      });
      // The schedule tuple, not just the caller's digest, is replay-safe.
      expect(store.planAuditRunDraft({ ...input, planningKey: "e".repeat(64) })).toMatchObject({
        disposition: "deduplicated",
        auditRun: { id: planned.auditRun.id }
      });

      const window = {
        id: "schedule_window_store_1",
        automationId: automation.id,
        scheduledFor,
        outcome: "created" as const,
        planningReceiptId: planned.receipt.id,
        auditRunId: planned.auditRun.id,
        recordedAt: "2026-08-14T10:01:05.000Z"
      };
      // A competing late-skip decision must recover the already durable
      // planning receipt instead of recording a contradictory skipped window.
      expect(store.completeAutomationScheduleWindow({
        expectedScheduledFor: scheduledFor,
        window: {
          id: window.id,
          automationId: automation.id,
          scheduledFor,
          outcome: "skipped",
          reason: "missed_window_policy_skip",
          recordedAt: window.recordedAt
        },
        nextScheduledAt: "2026-08-14T10:02:00.000Z"
      })).toEqual(window);
      expect(store.getAutomationScheduleState(automation.id)).toMatchObject({
        nextScheduledAt: "2026-08-14T10:02:00.000Z",
        lastScheduledFor: scheduledFor,
        lastOutcome: "created"
      });
      expect(store.completeAutomationScheduleWindow({
        expectedScheduledFor: scheduledFor,
        window: { ...window, id: "schedule_window_replayed" },
        nextScheduledAt: "2026-08-14T10:03:00.000Z"
      })).toEqual(window);
      expect(store.listAutomationScheduleWindows(automation.id)).toEqual([window]);
      expect(store.getAutomationScheduleState(automation.id)?.nextScheduledAt)
        .toBe("2026-08-14T10:02:00.000Z");
    } finally {
      database.close();
    }
  });

  it("persists renderer-safe repository pulses across database restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-pulses-"));
    const databasePath = join(directory, "audit.db");
    let database = openDatabase(databasePath);
    try {
      runMigrations(database);
      let store = new SQLiteAuditDomainStore(database);
      const repository = store.createRepository({
        displayName: "private-project",
        source: "local_git",
        monitoringEnabled: true
      }, {
        serverLocator: "D:/private/customer/project"
      });
      const pulse = {
        pulseId: "pulse_restart_1",
        state: "degraded" as const,
        repository: {
          root: "D:/private/customer/project",
          provider: "local_git" as const,
          branch: "main",
          headSha: "a".repeat(40)
        },
        observedAt: "2026-08-14T12:00:00.000Z",
        dirtyFileCount: 2,
        pendingEvents: 1,
        lastError: "Unable to scan D:/private/customer/project/.git/index"
      };
      const saved = store.saveRepositoryPulse(repository.id, pulse);
      expect(saved).not.toHaveProperty("root");
      expect(saved.lastError).toContain("[PATH_REDACTED]");
      expect(store.saveRepositoryPulse(repository.id, pulse)).toEqual(saved);

      database.close();
      database = openDatabase(databasePath);
      expect(runMigrations(database)).toEqual([]);
      store = new SQLiteAuditDomainStore(database);
      expect(store.listRepositoryPulses(repository.id)).toEqual([saved]);
      expect(JSON.stringify(store.listRepositoryPulses(repository.id))).not.toContain("D:/private");
      expect(store.listLocalRepositorySupervisionTargets()).toHaveLength(1);

      expect(() => store.saveRepositoryPulse(repository.id, {
        ...pulse,
        dirtyFileCount: 3
      })).toThrowError(/conflicts with a different payload/i);
    } finally {
      if (database.open) database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses trusted automation and forces remote run drafts to static read-only", () => {
    const { database, store, repository, workflow, policy } = fixture();
    try {
      const remote = store.createRepository({
        displayName: "espnet/espnet",
        source: "github",
        remoteFullName: "espnet/espnet",
        monitoringEnabled: false
      });
      expect(() => store.createAutomation({
        repositoryId: remote.id,
        name: "Unsafe remote execution",
        trigger: { type: "manual" },
        workflowRevisionId: workflow.id,
        policyRevisionId: policy.id,
        executionProfile: "trusted_sandbox",
        enabled: true
      })).toThrowError(AuditDomainError);
      expect(store.createAuditRunDraft({
        repositoryId: remote.id,
        source: "manual",
        workflowRevisionId: workflow.id,
        policyRevisionId: policy.id,
        executionProfile: "trusted_sandbox"
      }).executionProfile).toBe("static_readonly");

      const staticAutomation = store.createAutomation({
        repositoryId: repository.id,
        name: "Static trusted-local automation",
        trigger: { type: "manual" },
        workflowRevisionId: workflow.id,
        policyRevisionId: policy.id,
        executionProfile: "static_readonly",
        enabled: true
      });
      expect(store.createAuditRunDraft({
        repositoryId: repository.id,
        source: "manual",
        automationId: staticAutomation.id,
        workflowRevisionId: workflow.id,
        policyRevisionId: policy.id,
        executionProfile: "trusted_sandbox"
      }).executionProfile).toBe("static_readonly");
    } finally {
      database.close();
    }
  });
});
