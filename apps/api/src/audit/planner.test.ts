import { describe, expect, it } from "vitest";
import { workflowSpecSchema, type RepositoryEventType } from "@consistency/schema";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { AuditRunPlanner } from "./planner";
import { SQLiteAuditDomainStore, type WorkflowRuntimeDefinitionGate } from "./store";

const workflowSpec = workflowSpecSchema.parse({
  version: 2,
  name: "vibe-safety",
  nodes: [{ id: "security", uses: "engine.security" }],
  verifiers: [{ id: "syntax", uses: "verify.syntax", needs: ["security"] }],
  synthesizer: { needs: ["syntax"] }
});

function fixture() {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const store = new SQLiteAuditDomainStore(database);
  const repository = store.createRepository({
    displayName: "local-untrusted",
    source: "local_git",
    monitoringEnabled: true
  }, { serverLocator: "D:/server-only/local-untrusted" });
  const otherRepository = store.createRepository({
    displayName: "other-local",
    source: "local_git",
    monitoringEnabled: true
  }, { serverLocator: "D:/server-only/other-local" });
  const trustedRepository = store.createRepository({
    displayName: "trusted-local",
    source: "local_git",
    monitoringEnabled: true
  }, {
    serverLocator: "D:/server-only/trusted-local",
    trustLevel: "trusted_local"
  });
  const workflow = store.createWorkflowRevision({ workflowId: "vibe-safety", spec: workflowSpec });
  const policy = store.createPolicyRevision({
    policyId: "default",
    name: "Default",
    requiredChecks: ["syntax"],
    minimumCoverage: 1,
    warnAtRiskScore: 40,
    failAtRiskScore: 70,
    enforcement: "advisory"
  });
  const createAutomation = (
    repositoryId: string,
    name: string,
    trigger: { type: "manual" } | {
      type: "repository_event";
      eventTypes: RepositoryEventType[];
      debounceMs: number;
    } | {
      type: "schedule";
      cron: string;
      timezone: string;
      missedRunPolicy: "skip";
    },
    enabled = true,
    executionProfile: "static_readonly" | "trusted_sandbox" = "static_readonly"
  ) => store.createAutomation({
    repositoryId,
    name,
    trigger,
    workflowRevisionId: workflow.id,
    policyRevisionId: policy.id,
    executionProfile,
    enabled
  });
  return {
    database,
    store,
    repository,
    otherRepository,
    trustedRepository,
    workflow,
    policy,
    createAutomation
  };
}

function saveEvent(
  store: SQLiteAuditDomainStore,
  repositoryId: string,
  id: string,
  type: RepositoryEventType,
  dedupeKey = id
) {
  return store.saveRepositoryEvent({
    id,
    repositoryId,
    type,
    source: "local_git",
    dedupeKey,
    occurredAt: "2026-08-14T10:00:00.000Z",
    baseRevision: "a".repeat(40),
    headRevision: "WORKING_TREE",
    changedFiles: [],
    metadata: {}
  });
}

describe("AuditRunPlanner", () => {
  it("matches only enabled repository-event automations for the event repository and type", () => {
    const { database, store, repository, otherRepository, createAutomation } = fixture();
    try {
      const matching = createAutomation(repository.id, "matching", {
        type: "repository_event",
        eventTypes: ["working_tree"],
        debounceMs: 0
      });
      createAutomation(repository.id, "disabled", {
        type: "repository_event",
        eventTypes: ["working_tree"],
        debounceMs: 0
      }, false);
      createAutomation(repository.id, "wrong-event", {
        type: "repository_event",
        eventTypes: ["pull_request"],
        debounceMs: 0
      });
      createAutomation(repository.id, "manual-only", { type: "manual" });
      createAutomation(repository.id, "scheduled", {
        type: "schedule",
        cron: "0 2 * * *",
        timezone: "UTC",
        missedRunPolicy: "skip"
      });
      createAutomation(otherRepository.id, "other-repository", {
        type: "repository_event",
        eventTypes: ["working_tree"],
        debounceMs: 0
      });

      const event = saveEvent(store, repository.id, "event_matching", "working_tree");
      const planner = new AuditRunPlanner(store);
      const planned = planner.planRepositoryEvent(event);
      expect(planned).toMatchObject({
        eventId: event.id,
        matchedAutomationCount: 1,
        results: [{
          disposition: "created",
          reason: "new_draft",
          auditRun: {
            automationId: matching.id,
            source: "repository_event",
            sourceEventId: event.id,
            status: "created"
          },
          execution: { available: false }
        }]
      });
      expect(store.listAuditRuns()).toHaveLength(1);
      expect(store.listAuditRunPlanningReceipts()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("deduplicates event replay and durably coalesces a new event into an active run", () => {
    const { database, store, repository, createAutomation } = fixture();
    try {
      const automation = createAutomation(repository.id, "working-tree", {
        type: "repository_event",
        eventTypes: ["working_tree"],
        debounceMs: 0
      });
      const planner = new AuditRunPlanner(store);
      const firstEvent = saveEvent(store, repository.id, "event_first", "working_tree", "logical-first");
      const first = planner.planRepositoryEvent(firstEvent).results[0]!;
      const replay = planner.planRepositoryEvent(firstEvent).results[0]!;
      expect(replay).toMatchObject({
        disposition: "deduplicated",
        reason: "trigger_replay",
        auditRun: { id: first.auditRun.id }
      });

      database.prepare("UPDATE audit_runs SET status = 'queued' WHERE id = ?").run(first.auditRun.id);
      const secondEvent = saveEvent(store, repository.id, "event_second", "working_tree", "logical-second");
      const coalesced = planner.planRepositoryEvent(secondEvent).results[0]!;
      expect(coalesced).toMatchObject({
        disposition: "coalesced",
        reason: "active_run",
        receipt: { disposition: "coalesced", automationId: automation.id },
        auditRun: { id: first.auditRun.id, status: "queued" }
      });
      expect(planner.planRepositoryEvent(secondEvent).results[0]).toMatchObject({
        disposition: "deduplicated",
        auditRun: { id: first.auditRun.id }
      });

      database.prepare("UPDATE audit_runs SET status = 'running' WHERE id = ?").run(first.auditRun.id);
      const thirdEvent = saveEvent(store, repository.id, "event_third", "working_tree", "logical-third");
      expect(planner.planRepositoryEvent(thirdEvent).results[0]).toMatchObject({
        disposition: "coalesced",
        reason: "active_run",
        auditRun: { id: first.auditRun.id, status: "running" }
      });
      expect(store.listAuditRuns()).toHaveLength(1);
      expect(store.listAuditRunPlanningReceipts(automation.id)).toHaveLength(3);
    } finally {
      database.close();
    }
  });

  it("allows explicit manual planning without enabling schedule timers and enforces repository trust", () => {
    const {
      database,
      store,
      repository,
      trustedRepository,
      createAutomation
    } = fixture();
    try {
      const scheduled = createAutomation(repository.id, "nightly", {
        type: "schedule",
        cron: "0 2 * * *",
        timezone: "UTC",
        missedRunPolicy: "skip"
      }, false);
      // Defense in depth: even a malformed persisted remote/untrusted profile
      // is downgraded by the planning transaction.
      database.prepare("UPDATE automations SET execution_profile = 'trusted_sandbox' WHERE id = ?")
        .run(scheduled.id);
      const trusted = createAutomation(
        trustedRepository.id,
        "trusted-manual",
        { type: "manual" },
        true,
        "trusted_sandbox"
      );

      let nonce = 0;
      const planner = new AuditRunPlanner(store, { createManualNonce: () => `nonce-${++nonce}` });
      const untrustedPlan = planner.planManualRun(scheduled.id);
      expect(untrustedPlan).toMatchObject({
        disposition: "created",
        auditRun: {
          source: "manual",
          executionProfile: "static_readonly",
          status: "created"
        },
        execution: { available: false }
      });
      expect(planner.planManualRun(scheduled.id)).toMatchObject({
        disposition: "coalesced",
        auditRun: { id: untrustedPlan.auditRun.id }
      });

      const trustedPlan = planner.planManualRun(trusted.id);
      expect(trustedPlan.auditRun.executionProfile).toBe("trusted_sandbox");
      expect(database.prepare("SELECT count(*) AS count FROM audit_runs WHERE source = 'schedule'")
        .get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("plans a runtime-only automation without inventing a legacy revision", () => {
    const { database, store } = fixture();
    try {
      const policy = store.createPolicyRevision({
        policyId: "default",
        name: "Default",
        requiredChecks: ["syntax"],
        minimumCoverage: 1,
        warnAtRiskScore: 40,
        failAtRiskScore: 70,
        enforcement: "advisory"
      });
      const gate: WorkflowRuntimeDefinitionGate = {
        definitionExists: (definitionId: string): boolean => definitionId === "verified-mini-review",
        getLatestValidatedRevision: (definitionId: string): any =>
          definitionId === "verified-mini-review" ? { revisionId: "wfrev_x", status: "validated" } : undefined
      };
      const bridgeStore = new SQLiteAuditDomainStore(database, { workflowRuntime: gate });
      const runtimeAutomation = bridgeStore.createAutomation({
        repositoryId: store.listRepositories()[0]!.id,
        name: "Runtime mapped",
        trigger: { type: "manual" },
        runtimeDefinitionId: "verified-mini-review",
        policyRevisionId: policy.id,
        executionProfile: "static_readonly",
        enabled: true
      });
      const planner = new AuditRunPlanner(bridgeStore);
      const planned = planner.planManualRun(runtimeAutomation.id);
      expect(planned).toMatchObject({
        disposition: "created",
        auditRun: {
          automationId: runtimeAutomation.id,
          workflowRevisionId: undefined,
          status: "created"
        },
        execution: { available: false }
      });
      expect(planned.receipt.workflowDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      database.close();
    }
  });
});
