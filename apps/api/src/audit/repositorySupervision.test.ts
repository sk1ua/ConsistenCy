import { describe, expect, it } from "vitest";
import { workflowSpecSchema } from "@consistency/schema";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import {
  buildRepositorySupervisorRegistrations,
  EMPTY_REPOSITORY_WORKFLOW_DIGEST
} from "./repositorySupervision";
import { SQLiteAuditDomainStore } from "./store";

const firstWorkflowSpec = workflowSpecSchema.parse({
  version: 2,
  name: "repository-watch",
  nodes: [{ id: "security", uses: "engine.security" }],
  verifiers: [{ id: "syntax", uses: "verify.syntax", needs: ["security"] }],
  synthesizer: { needs: ["syntax"] }
});

const secondWorkflowSpec = workflowSpecSchema.parse({
  version: 2,
  name: "repository-watch-strict",
  nodes: [
    { id: "security", uses: "engine.security" },
    { id: "consistency", uses: "engine.structural" }
  ],
  verifiers: [{ id: "syntax", uses: "verify.syntax", needs: ["security", "consistency"] }],
  synthesizer: { needs: ["syntax"] }
});

function fixture() {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const store = new SQLiteAuditDomainStore(database);
  const monitored = store.createRepository({
    displayName: "monitored-local",
    source: "local_git",
    monitoringEnabled: true
  }, { serverLocator: "D:/server-only/monitored-local" });
  const disabled = store.createRepository({
    displayName: "disabled-local",
    source: "local_git",
    monitoringEnabled: false
  }, { serverLocator: "D:/server-only/disabled-local" });
  const remote = store.createRepository({
    displayName: "remote",
    source: "github",
    remoteFullName: "example/remote",
    monitoringEnabled: true
  });
  const timestamp = new Date().toISOString();
  database.prepare(`
    INSERT INTO repositories (
      id, display_name, source, identity_key, server_locator, remote_full_name,
      default_branch, trust_level, monitoring_enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 1, ?, ?)
  `).run(
    "repo_missing_locator",
    "missing-locator",
    "local_git",
    "local:missing-locator",
    "untrusted_readonly",
    timestamp,
    timestamp
  );
  return { database, store, monitored, disabled, remote };
}

describe("buildRepositorySupervisorRegistrations", () => {
  it("composes only monitored local targets with their server-only locator and injected interval", () => {
    const { database, store, monitored, disabled, remote } = fixture();
    try {
      const targets = store.listLocalRepositorySupervisionTargets();
      const registrations = buildRepositorySupervisorRegistrations(store, 12_345);

      expect(targets.map(target => target.repository.id)).toEqual([monitored.id]);
      expect(registrations).toEqual([{
        repositoryId: monitored.id,
        root: targets[0]!.serverLocator,
        workflowDigest: EMPTY_REPOSITORY_WORKFLOW_DIGEST,
        pollIntervalMs: 12_345
      }]);
      expect(registrations.map(registration => registration.repositoryId)).not.toContain(disabled.id);
      expect(registrations.map(registration => registration.repositoryId)).not.toContain(remote.id);
      expect(registrations.map(registration => registration.repositoryId)).not.toContain("repo_missing_locator");
      expect(registrations[0]!.workflowDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(() => buildRepositorySupervisorRegistrations(store, 0)).toThrowError(/positive integer/i);
    } finally {
      database.close();
    }
  });

  it("derives an order-independent digest from every enabled automation and workflow revision", () => {
    const { database, store, monitored } = fixture();
    try {
      const firstWorkflow = store.createWorkflowRevision({
        workflowId: "repository-watch",
        spec: firstWorkflowSpec
      });
      const secondWorkflow = store.createWorkflowRevision({
        workflowId: "repository-watch",
        spec: secondWorkflowSpec
      });
      const policy = store.createPolicyRevision({
        policyId: "default",
        name: "Default",
        requiredChecks: ["syntax"],
        minimumCoverage: 1,
        warnAtRiskScore: 40,
        failAtRiskScore: 70,
        enforcement: "advisory"
      });
      const firstAutomation = store.createAutomation({
        repositoryId: monitored.id,
        name: "Working tree",
        trigger: {
          type: "repository_event",
          eventTypes: ["working_tree"],
          debounceMs: 1_000
        },
        workflowRevisionId: firstWorkflow.id,
        policyRevisionId: policy.id,
        executionProfile: "static_readonly",
        enabled: true
      });
      const secondAutomation = store.createAutomation({
        repositoryId: monitored.id,
        name: "Nightly",
        trigger: {
          type: "schedule",
          cron: "0 2 * * *",
          timezone: "UTC",
          missedRunPolicy: "skip"
        },
        workflowRevisionId: secondWorkflow.id,
        policyRevisionId: policy.id,
        executionProfile: "static_readonly",
        enabled: true
      });

      const originalDigest = buildRepositorySupervisorRegistrations(store, 30_000)[0]!.workflowDigest;
      expect(originalDigest).not.toBe(EMPTY_REPOSITORY_WORKFLOW_DIGEST);

      const reversedStore = {
        listLocalRepositorySupervisionTargets: () => [...store.listLocalRepositorySupervisionTargets()].reverse(),
        listAutomations: (repositoryId?: string) => [...store.listAutomations(repositoryId)].reverse(),
        getWorkflowRevision: (id: string) => store.getWorkflowRevision(id)
      };
      expect(buildRepositorySupervisorRegistrations(reversedStore, 30_000)[0]!.workflowDigest)
        .toBe(originalDigest);

      const changedWorkflowDigestStore = {
        ...reversedStore,
        getWorkflowRevision: (id: string) => {
          const revision = store.getWorkflowRevision(id);
          return revision?.id === firstWorkflow.id
            ? { ...revision, digest: "f".repeat(64) }
            : revision;
        }
      };
      expect(buildRepositorySupervisorRegistrations(changedWorkflowDigestStore, 30_000)[0]!.workflowDigest)
        .not.toBe(originalDigest);

      store.setAutomationEnabled(secondAutomation.id, false);
      const oneAutomationDigest = buildRepositorySupervisorRegistrations(store, 30_000)[0]!.workflowDigest;
      expect(oneAutomationDigest).not.toBe(originalDigest);
      store.setAutomationEnabled(secondAutomation.id, true);
      expect(buildRepositorySupervisorRegistrations(store, 30_000)[0]!.workflowDigest)
        .toBe(originalDigest);

      database.prepare(`
        UPDATE automations SET trigger_json = ?, updated_at = ? WHERE id = ?
      `).run(
        JSON.stringify({
          type: "repository_event",
          eventTypes: ["working_tree"],
          debounceMs: 9_000
        }),
        new Date(Date.now() + 1_000).toISOString(),
        firstAutomation.id
      );
      expect(buildRepositorySupervisorRegistrations(store, 30_000)[0]!.workflowDigest)
        .not.toBe(originalDigest);

      const runCount = database.prepare("SELECT count(*) AS count FROM audit_runs").get() as { count: number };
      expect(runCount.count).toBe(0);
    } finally {
      database.close();
    }
  });
});

describe("buildRepositorySupervisorRegistrations (CKPT5 on_change bindings)", () => {
  it("keeps byte-identical digests without on_change bindings and re-arms when the binding set changes", () => {
    const { database, store, monitored } = fixture();
    try {
      const digestFor = (options?: { onChangeBindings?: (repositoryId: string) => readonly string[] }) =>
        buildRepositorySupervisorRegistrations(store, 30_000, options)
          .find(registration => registration.repositoryId === monitored.id)!
          .workflowDigest;

      const legacy = digestFor();
      // An empty binding source must reproduce the EXACT pre-CKPT5 digest —
      // upgrading never re-arms events for unchanged configuration.
      expect(digestFor({ onChangeBindings: () => [] })).toBe(legacy);

      const withA = digestFor({ onChangeBindings: () => ["def-a"] });
      expect(withA).not.toBe(legacy);
      expect(withA).toMatch(/^[0-9a-f]{64}$/);

      // Binding-set identity is order-independent and set-sensitive.
      const withAB = digestFor({ onChangeBindings: () => ["def-b", "def-a"] });
      expect(withAB).not.toBe(withA);
      expect(digestFor({ onChangeBindings: () => ["def-a", "def-b"] })).toBe(withAB);

      // Removing all bindings restores the legacy digest (config round-trips).
      expect(digestFor({ onChangeBindings: () => [] })).toBe(legacy);
    } finally {
      database.close();
    }
  });
});
