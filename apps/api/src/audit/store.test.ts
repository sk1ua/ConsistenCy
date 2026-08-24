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

  it("resolves canonical GitHub identity case-insensitively and prefers a local checkout", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const store = new SQLiteAuditDomainStore(database);
    try {
      const remote = store.connectGitHubRepository({
        displayName: "Repository",
        source: "github",
        remoteFullName: "Acme/Repository",
        defaultBranch: "main"
      });
      expect(store.connectGitHubRepository({
        displayName: "duplicate",
        source: "github",
        remoteFullName: "acme/repository"
      }).id).toBe(remote.id);

      const local = store.registerLocalRepository({
        displayName: "local-repository",
        source: "local_git",
        remoteFullName: "ACME/REPOSITORY",
        defaultBranch: "trunk",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/local-repository" });
      expect(local).toMatchObject({
        id: remote.id,
        source: "local_git",
        remoteFullName: "ACME/REPOSITORY",
        defaultBranch: "main"
      });
      expect(store.findRepositoryByRemoteFullName("acme/REPOSITORY")?.id).toBe(remote.id);
      expect(store.listRepositories()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("updates GitHub records from verified provider metadata without nulling a known default branch", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const store = new SQLiteAuditDomainStore(database);
    try {
      const original = store.connectGitHubRepository({
        displayName: "Original",
        source: "github",
        remoteFullName: "Acme/Repository",
        defaultBranch: "main"
      });
      const refreshed = store.connectGitHubRepository({
        displayName: "Provider Name",
        source: "github",
        remoteFullName: "acme/repository",
        defaultBranch: "trunk"
      });
      expect(refreshed).toMatchObject({
        id: original.id,
        displayName: "Provider Name",
        remoteFullName: "acme/repository",
        defaultBranch: "trunk"
      });
      expect(store.connectGitHubRepository({
        displayName: "Provider Name",
        source: "github",
        remoteFullName: "ACME/REPOSITORY"
      })).toMatchObject({ id: original.id, defaultBranch: "trunk" });

      const renamed = store.connectGitHubRepository({
        displayName: "Renamed",
        source: "github",
        remoteFullName: "Acme/Renamed.Repository",
        defaultBranch: "main"
      }, { existingRepositoryId: original.id });
      expect(renamed).toMatchObject({
        id: original.id,
        remoteFullName: "Acme/Renamed.Repository",
        defaultBranch: "main"
      });
      expect(store.findRepositoryByRemoteFullName("acme/renamed.repository")?.id).toBe(original.id);
      expect(store.findRepositoryByRemoteFullName("acme/repository")).toBeUndefined();
      const row = database.prepare("SELECT identity_key FROM repositories WHERE id = ?")
        .get(original.id) as { identity_key: string };
      expect(row.identity_key).toBe("github:acme/renamed.repository");
      expect(store.listRepositories()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("rolls back provider rename metadata when the target identity key collides", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const store = new SQLiteAuditDomainStore(database);
    try {
      const original = store.connectGitHubRepository({
        displayName: "Original",
        source: "github",
        remoteFullName: "Acme/Original",
        defaultBranch: "main"
      });
      const blocker = store.createRepository({
        displayName: "Blocker",
        source: "gitlab",
        remoteFullName: "elsewhere/blocker"
      });
      database.prepare("UPDATE repositories SET identity_key = ? WHERE id = ?")
        .run("github:acme/renamed", blocker.id);
      const before = store.getRepository(original.id);

      expect(() => store.connectGitHubRepository({
        displayName: "Renamed",
        source: "github",
        remoteFullName: "Acme/Renamed",
        defaultBranch: "trunk"
      }, { existingRepositoryId: original.id })).toThrowError(/reconciliation/i);
      expect(store.getRepository(original.id)).toEqual(before);
      expect(store.findRepositoryByRemoteFullName("acme/original")?.id).toBe(original.id);
      expect(store.findRepositoryByRemoteFullName("acme/renamed")).toBeUndefined();
      const row = database.prepare("SELECT identity_key FROM repositories WHERE id = ?")
        .get(original.id) as { identity_key: string };
      expect(row.identity_key).toBe("github:acme/original");
    } finally {
      database.close();
    }
  });

  it("keeps a local identity key when verified provider metadata renames its remote", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const store = new SQLiteAuditDomainStore(database);
    try {
      const local = store.registerLocalRepository({
        displayName: "Local",
        source: "local_git",
        remoteFullName: "Acme/Original",
        defaultBranch: "main"
      }, { serverLocator: "D:/private/work/local-provider-rename" });
      const before = database.prepare("SELECT identity_key FROM repositories WHERE id = ?")
        .get(local.id) as { identity_key: string };
      const renamed = store.connectGitHubRepository({
        displayName: "Provider Renamed",
        source: "github",
        remoteFullName: "Acme/Renamed",
        defaultBranch: "trunk"
      }, { existingRepositoryId: local.id });
      const after = database.prepare("SELECT identity_key FROM repositories WHERE id = ?")
        .get(local.id) as { identity_key: string };
      expect(renamed).toMatchObject({
        id: local.id,
        source: "local_git",
        remoteFullName: "Acme/Renamed",
        defaultBranch: "trunk"
      });
      expect(after.identity_key).toBe(before.identity_key);
      expect(after.identity_key.startsWith("local:")).toBe(true);
    } finally {
      database.close();
    }
  });

  it("enriches an existing same-path local registration without changing its opaque ID", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const store = new SQLiteAuditDomainStore(database);
    try {
      const original = store.createRepository({
        displayName: "legacy-local",
        source: "local_git",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/legacy-local" });
      const enriched = store.registerLocalRepository({
        displayName: "legacy-local",
        source: "local_git",
        remoteFullName: "Acme/Repository",
        defaultBranch: "develop",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/legacy-local" });
      expect(enriched).toMatchObject({
        id: original.id,
        remoteFullName: "Acme/Repository",
        defaultBranch: "develop"
      });
      expect(store.registerLocalRepository({
        displayName: "legacy-local",
        source: "local_git",
        remoteFullName: "acme/repository",
        defaultBranch: "develop",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/legacy-local" }).id).toBe(original.id);
      expect(store.listRepositories()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("uses fill-only default-branch precedence for local registration", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const store = new SQLiteAuditDomainStore(database);
    try {
      const providerRepository = store.connectGitHubRepository({
        displayName: "Repository",
        source: "github",
        remoteFullName: "Acme/Repository",
        defaultBranch: "main"
      });
      const reconciled = store.registerLocalRepository({
        displayName: "local-repository",
        source: "local_git",
        remoteFullName: "acme/repository",
        defaultBranch: "stale-local",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/provider-preservation" });
      expect(reconciled).toMatchObject({
        id: providerRepository.id,
        source: "local_git",
        defaultBranch: "main"
      });

      const repeated = store.registerLocalRepository({
        displayName: "local-repository",
        source: "local_git",
        remoteFullName: "ACME/REPOSITORY",
        defaultBranch: "changed-symbolic-head",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/provider-preservation" });
      expect(repeated).toMatchObject({ id: providerRepository.id, defaultBranch: "main" });

      const branchless = store.createRepository({
        displayName: "branchless",
        source: "local_git",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/branchless" });
      expect(store.registerLocalRepository({
        displayName: "branchless",
        source: "local_git",
        defaultBranch: "develop",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/branchless" })).toMatchObject({
        id: branchless.id,
        defaultBranch: "develop"
      });
      expect(store.registerLocalRepository({
        displayName: "branchless",
        source: "local_git",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/branchless" })).toMatchObject({
        id: branchless.id,
        defaultBranch: "develop"
      });
    } finally {
      database.close();
    }
  });

  it("rejects same-path and cross-checkout canonical identity conflicts without mutation", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const store = new SQLiteAuditDomainStore(database);
    try {
      const existingPath = store.createRepository({
        displayName: "existing-path",
        source: "local_git",
        remoteFullName: "Acme/Original",
        defaultBranch: "main",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/existing-path" });
      const beforeDifferentRemote = store.listRepositories();
      expect(() => store.registerLocalRepository({
        displayName: "changed",
        source: "local_git",
        remoteFullName: "Acme/Different",
        defaultBranch: "trunk",
        monitoringEnabled: false
      }, { serverLocator: "D:/private/work/existing-path" })).toThrowError(AuditDomainError);
      try {
        store.registerLocalRepository({
          displayName: "changed",
          source: "local_git",
          remoteFullName: "Acme/Different"
        }, { serverLocator: "D:/private/work/existing-path" });
      } catch (error) {
        expect(error).toMatchObject({ code: "REPOSITORY_RECONCILIATION_CONFLICT", statusCode: 409 });
      }
      expect(store.listRepositories()).toEqual(beforeDifferentRemote);

      const otherCheckout = store.createRepository({
        displayName: "other-checkout",
        source: "local_git",
        remoteFullName: "Acme/Shared",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/other-checkout" });
      const beforeCrossCheckout = store.listRepositories();
      expect(() => store.registerLocalRepository({
        displayName: "selected-checkout",
        source: "local_git",
        remoteFullName: "acme/shared",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/selected-checkout" })).toThrowError(/reconciliation/i);
      expect(store.listRepositories()).toEqual(beforeCrossCheckout);
      expect(store.getRepository(otherCheckout.id)).toEqual(otherCheckout);
      expect(store.getRepository(existingPath.id)).toEqual(existingPath);
    } finally {
      database.close();
    }
  });

  it("rejects a same-path local plus separate GitHub canonical row without mutating either record", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const store = new SQLiteAuditDomainStore(database);
    try {
      const local = store.createRepository({
        displayName: "legacy-local",
        source: "local_git",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/legacy-local-conflict" });
      const provider = store.connectGitHubRepository({
        displayName: "provider-record",
        source: "github",
        remoteFullName: "Acme/Repository",
        defaultBranch: "main"
      });
      const before = store.listRepositories();
      expect(() => store.registerLocalRepository({
        displayName: "legacy-local",
        source: "local_git",
        remoteFullName: "acme/repository",
        defaultBranch: "trunk",
        monitoringEnabled: true
      }, { serverLocator: "D:/private/work/legacy-local-conflict" })).toThrowError(/reconciliation/i);
      expect(store.listRepositories()).toEqual(before);
      expect(store.getRepository(local.id)).toEqual(local);
      expect(store.getRepository(provider.id)).toEqual(provider);
    } finally {
      database.close();
    }
  });

  it("does not confuse a GitLab full name with canonical GitHub identity", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const store = new SQLiteAuditDomainStore(database);
    try {
      store.createRepository({
        displayName: "GitLab repository",
        source: "gitlab",
        remoteFullName: "acme/repository"
      });
      expect(store.findRepositoryByRemoteFullName("acme/repository")).toBeUndefined();
      expect(store.connectGitHubRepository({
        displayName: "GitHub repository",
        source: "github",
        remoteFullName: "acme/repository"
      }).source).toBe("github");
      expect(store.listRepositories()).toHaveLength(2);
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
