import { request } from "node:http";
import type { WorkflowSpec } from "@consistency/schema";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type ConsistencyDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import {
  WorkflowRuntimeHost
} from "../workflow-runtime/host";
import {
  WorkflowRuntimeStore
} from "../workflow-runtime/store";
import {
  AUDIT_EXECUTION_AUTOMATION_NOT_MAPPED_REASON,
  AUDIT_EXECUTION_DISABLED_REASON,
  AUDIT_EXECUTION_LOCAL_REPOSITORY_REQUIRED_REASON
} from "./executor";
import { createApiServer } from "../http";
import { AuditRunPlanner } from "./planner";
import { AutomationScheduler } from "./scheduler";
import { SQLiteAuditDomainStore } from "./store";

type JsonResponse = { status: number; body: any };

function call(port: number, method: "GET" | "POST", path: string, payload?: unknown): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const raw = payload === undefined ? "" : JSON.stringify(payload);
    const pending = request({
      hostname: "127.0.0.1",
      port,
      method,
      path,
      headers: raw.length === 0 ? {} : {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(raw))
      }
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: body.length === 0 ? {} : JSON.parse(body)
      }));
    });
    pending.on("error", reject);
    pending.end(raw);
  });
}

async function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected ephemeral port");
  return address.port;
}

describe("audit control-plane HTTP skeleton", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];
  const databases: ConsistencyDatabase[] = [];
  const schedulers: AutomationScheduler[] = [];

  afterEach(async () => {
    for (const scheduler of schedulers.splice(0)) scheduler.stop();
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    for (const database of databases.splice(0)) database.close();
  });

  it("persists definitions and exposes execution capability honestly", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    runMigrations(database);
    const auditStore = new SQLiteAuditDomainStore(database);
    const server = createApiServer({ auditStore });
    servers.push(server);
    const port = await listen(server);

    expect(await call(port, "GET", "/audit/capabilities")).toMatchObject({
      status: 200,
      body: {
        persistence: true,
        automationDefinitions: true,
        automationScheduling: false,
        auditRunDrafts: true,
        auditExecution: false,
        localPathRegistration: false
      }
    });

    const repositoryResponse = await call(port, "POST", "/repositories", {
      displayName: "espnet/espnet",
      source: "gitlab",
      remoteFullName: "espnet/espnet",
      monitoringEnabled: true
    });
    expect(repositoryResponse.status).toBe(201);
    expect(repositoryResponse.body.repository).not.toHaveProperty("repoPath");
    expect(repositoryResponse.body.repository).not.toHaveProperty("root");
    const repositoryId = repositoryResponse.body.repository.id as string;

    const rejectedPath = await call(port, "POST", "/repositories", {
      displayName: "C:\\private\\repository",
      source: "local_git",
      repoPath: "C:\\private\\repository"
    });
    expect(rejectedPath.status).toBe(400);
    expect(rejectedPath.body.error.code).toBe("INVALID_AUDIT_REQUEST");

    const unavailableLocalRegistration = await call(port, "POST", "/repositories", {
      displayName: "local-project",
      source: "local_git"
    });
    expect(unavailableLocalRegistration).toMatchObject({
      status: 501,
      body: { error: { code: "LOCAL_PATH_REGISTRATION_UNAVAILABLE" } }
    });

    const workflowSpec = {
        version: 2,
        name: "vibe-safety",
        nodes: [{ id: "security", uses: "engine.security" }],
        verifiers: [{ id: "syntax-gate", uses: "verify.syntax", needs: ["security"] }],
        synthesizer: { needs: ["syntax-gate"] }
    } as WorkflowSpec;
    expect(await call(port, "POST", "/workflows/vibe-safety/validate", workflowSpec)).toMatchObject({
      status: 200,
      body: { valid: true, workflowId: "vibe-safety" }
    });
    const workflowResponse = await call(port, "POST", "/workflows/vibe-safety/revisions", {
      spec: workflowSpec
    });
    expect(workflowResponse.status).toBe(201);
    const workflowRevisionId = workflowResponse.body.workflowRevision.id as string;
    expect((await call(port, "GET", "/workflows/vibe-safety/revisions")).body.workflowRevisions).toHaveLength(1);

    const policyResponse = await call(port, "POST", "/policies/default-safety/revisions", {
      name: "Default safety",
      requiredChecks: ["security", "syntax-gate"],
      minimumCoverage: 1,
      warnAtRiskScore: 40,
      failAtRiskScore: 70,
      enforcement: "advisory"
    });
    expect(policyResponse.status).toBe(201);
    const policyRevisionId = policyResponse.body.policyRevision.id as string;
    expect(await call(port, "POST", "/policies/default-safety/evaluate", {
      riskScore: 5,
      coverage: 0.5,
      completedChecks: ["security"]
    })).toMatchObject({
      status: 200,
      body: { evaluation: { outcome: "unknown", missingRequiredChecks: ["syntax-gate"] } }
    });

    const scheduleResponse = await call(port, "POST", "/automations", {
      repositoryId,
      name: "Every weekday morning",
      trigger: { type: "schedule", cron: "0 9 * * 1-5", timezone: "Asia/Hong_Kong" },
      workflowRevisionId,
      policyRevisionId,
      executionProfile: "static_readonly",
      enabled: true
    });
    expect(scheduleResponse.status).toBe(201);
    const scheduleAutomationId = scheduleResponse.body.automation.id as string;
    expect(await call(port, "POST", "/automations", {
      repositoryId,
      name: "Invalid cron",
      trigger: { type: "schedule", cron: "@daily", timezone: "UTC" },
      workflowRevisionId,
      policyRevisionId,
      executionProfile: "static_readonly",
      enabled: true
    })).toMatchObject({ status: 400, body: { error: { code: "INVALID_AUDIT_REQUEST" } } });
    expect(await call(port, "GET", `/automations/${scheduleAutomationId}/schedule`)).toMatchObject({
      status: 200,
      body: { automationId: scheduleAutomationId, scheduleState: null, scheduleWindows: [] }
    });
    auditStore.ensureAutomationScheduleState({
      automationId: scheduleAutomationId,
      cron: "0 9 * * 1-5",
      timezone: "Asia/Hong_Kong",
      status: "scheduled",
      nextScheduledAt: "2026-08-17T01:00:00.000Z",
      updatedAt: "2026-08-14T10:00:00.000Z"
    });
    expect(await call(port, "GET", `/automations/${scheduleAutomationId}/history`)).toMatchObject({
      status: 200,
      body: {
        scheduleState: { nextScheduledAt: "2026-08-17T01:00:00.000Z" },
        scheduleWindows: []
      }
    });

    const automationResponse = await call(port, "POST", "/automations", {
      repositoryId,
      name: "PR safety audit",
      trigger: { type: "repository_event", eventTypes: ["pull_request"], debounceMs: 0 },
      workflowRevisionId,
      policyRevisionId,
      executionProfile: "static_readonly",
      enabled: true
    });
    expect(automationResponse.status).toBe(201);
    const automationId = automationResponse.body.automation.id as string;
    expect((await call(port, "GET", `/automations/${automationId}`)).body.automation.id).toBe(automationId);
    expect((await call(port, "POST", `/automations/${automationId}/pause`)).body.automation.enabled).toBe(false);
    const manualPlan = await call(port, "POST", `/automations/${automationId}/run`);
    expect(manualPlan).toMatchObject({
      status: 202,
      body: {
        planning: {
          disposition: "created",
          reason: "new_draft",
          auditRun: {
            source: "manual",
            automationId,
            executionProfile: "static_readonly",
            status: "created"
          },
          execution: { available: false }
        }
      }
    });
    const runId = manualPlan.body.planning.auditRun.id as string;
    expect(await call(port, "POST", `/automations/${automationId}/run`)).toMatchObject({
      status: 202,
      body: {
        planning: {
          disposition: "coalesced",
          reason: "active_run",
          auditRun: { id: runId },
          execution: { available: false }
        }
      }
    });
    expect(await call(port, "POST", "/automations/missing/run")).toMatchObject({
      status: 404,
      body: { error: { code: "AUTOMATION_NOT_FOUND" } }
    });

    const runResponse = await call(port, "POST", "/audit-runs", {
      repositoryId,
      source: "manual",
      workflowRevisionId,
      policyRevisionId,
      executionProfile: "static_readonly",
      baseRevision: "base123",
      headRevision: "head456"
    });
    expect(runResponse).toMatchObject({
      status: 201,
      body: {
        auditRun: { status: "created", publicationStatus: "skipped" },
        execution: { available: false }
      }
    });
    const directRunId = runResponse.body.auditRun.id as string;
    const history = await call(port, "GET", `/automations/${automationId}/history`);
    expect(history.body.auditRuns).toHaveLength(1);
    expect(history.body.planningReceipts).toHaveLength(2);
    expect(await call(port, "GET", `/automations/${automationId}/schedule`)).toMatchObject({
      status: 409,
      body: { error: { code: "AUTOMATION_TRIGGER_NOT_MATCHED" } }
    });
    expect((await call(port, "GET", `/audit-runs/${runId}/steps`)).body.steps).toEqual([]);
    // Route C: real event/export endpoints replaced the 501 stubs.
    expect(await call(port, "GET", `/audit-runs/${runId}/events`)).toMatchObject({
      status: 200,
      body: { events: [] }
    });
    const exportResponse = await call(port, "GET", `/audit-runs/${runId}/export`);
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.body).toMatchObject({
      schemaVersion: 1,
      run: { id: runId, repositoryId, automationId, status: "created" },
      events: [],
      automation: { id: automationId }
    });
    expect(exportResponse.body).not.toHaveProperty("workflowRuntimeRun");
    // POST /export is the same read-only document for POST-only clients.
    const exportViaPost = await call(port, "POST", `/audit-runs/${runId}/export`);
    expect(exportViaPost.status).toBe(200);
    expect(exportViaPost.body.schemaVersion).toBe(1);
    expect((await call(port, "GET", `/audit-runs/${directRunId}`)).body.auditRun.id).toBe(directRunId);
    auditStore.saveRepositoryPulse(repositoryId, {
      pulseId: "pulse_http_1",
      state: "degraded",
      repository: { root: "D:/private/customer/project", provider: "local_git", branch: "main" },
      observedAt: "2026-08-14T12:00:00.000Z",
      dirtyFileCount: 1,
      pendingEvents: 0,
      lastError: "Unable to inspect D:/private/customer/project/.git/index"
    });
    const timeline = await call(port, "GET", `/repositories/${repositoryId}/timeline`);
    expect(timeline.body.auditRuns).toHaveLength(2);
    expect(timeline.body.repositoryPulses).toHaveLength(1);
    expect(JSON.stringify(timeline.body)).not.toContain("D:/private");
    expect((await call(port, "GET", `/repositories/${repositoryId}/metrics`)).body.evolutionSnapshots).toEqual([]);

    const issueResponse = await call(port, "POST", "/issues", {
      repositoryId,
      fingerprint: "security:src/app.ts:eval",
      ruleId: "security.eval",
      title: "Dynamic code execution",
      severity: "high",
      confidence: "confirmed",
      location: { file: "src/app.ts", startLine: 10, endLine: 10 },
      evidenceSummary: "eval(userInput)",
      firstSeenRunId: runId,
      lastSeenRunId: runId,
      tags: ["vibe-safety"]
    });
    expect(issueResponse.status).toBe(201);
    const issueId = issueResponse.body.issue.id as string;
    expect((await call(port, "GET", `/repositories/${repositoryId}/issues`)).body.issues).toHaveLength(1);
    const suppressed = await call(port, "POST", `/issues/${issueId}/triage`, {
      action: "accept_risk",
      reason: "Accepted local prototype risk"
    });
    expect(suppressed.body.issue).toMatchObject({ state: "accepted_risk", stateReason: "Accepted local prototype risk" });
    expect((await call(port, "POST", `/issues/${issueId}/triage`, { action: "reopen" })).body.issue.state).toBe("open");

    const cancelled = await call(port, "POST", `/audit-runs/${runId}/cancel`);
    expect(cancelled.body.auditRun.status).toBe("cancelled");
    // The append-only lifecycle stream is readable with honest provenance.
    const cancelledEvents = await call(port, "GET", `/audit-runs/${runId}/events`);
    expect(cancelledEvents.status).toBe(200);
    expect(cancelledEvents.body.events.map((event: { eventType: string }) => event.eventType))
      .toEqual(["run_cancelled"]);
    const cancelledExport = await call(port, "GET", `/audit-runs/${runId}/export`);
    expect(cancelledExport.body.run).toMatchObject({ id: runId, status: "cancelled" });
    expect(
      (await call(port, "GET", `/audit-runs/${runId}/export`)).body.events
        .map((event: { eventType: string }) => event.eventType)
    ).toEqual(["run_cancelled"]);
  });

  it("advertises scheduling only while the injected scheduler lifecycle is running", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    runMigrations(database);
    const auditStore = new SQLiteAuditDomainStore(database);
    const scheduler = new AutomationScheduler(auditStore, new AuditRunPlanner(auditStore), {
      timer: {
        setInterval: () => ({}),
        clearInterval: () => undefined
      }
    });
    schedulers.push(scheduler);
    const server = createApiServer({ auditStore, automationScheduler: scheduler });
    servers.push(server);
    const port = await listen(server);

    expect((await call(port, "GET", "/audit/capabilities")).body.automationScheduling).toBe(false);
    scheduler.start();
    expect((await call(port, "GET", "/audit/capabilities")).body.automationScheduling).toBe(true);
    scheduler.stop();
    expect((await call(port, "GET", "/audit/capabilities")).body.automationScheduling).toBe(false);
  });

  it("Route C: event stream ordering, export document contract, and canonical 404s", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    runMigrations(database);
    const auditStore = new SQLiteAuditDomainStore(database, {
      // Mapping-gate fake: createAutomation validation passes without seeding
      // a real definition row; the exported link is inserted directly below.
      workflowRuntime: {
        definitionExists: () => true,
        getLatestValidatedRevision: () => ({ revisionId: "rev-seed" }) as any
      }
    });
    // A real persisted workflow-runtime row backs the export summary shaping.
    const workflowRuntimeStore = new WorkflowRuntimeStore(database);
    workflowRuntimeStore.insertRun({
      runId: "wfrun_export_1",
      definitionId: "def-runtime-x",
      revisionId: "rev-7",
      origin: "user",
      status: "running",
      repository: "Fixture Local",
      headSha: "deadbeefcafe",
      createdAt: "2026-08-27T00:00:00.000Z",
      evidence: []
    });
    workflowRuntimeStore.updateRunTerminal({
      runId: "wfrun_export_1",
      status: "succeeded",
      finishedAt: "2026-08-27T00:01:00.000Z",
      evidence: [],
      miniReport: { findings: [{ id: "f1" }, { id: "f2" }], evidenceCount: 3 }
    });

    const repository = auditStore.createRepository({
      displayName: "Fixture Local",
      source: "local_git",
      monitoringEnabled: true
    }, { serverLocator: "\\\\fixture\\server\\checkout" });
    const remoteRepository = auditStore.createRepository({
      displayName: "Fixture Remote",
      source: "github",
      remoteFullName: "owner/fixture-remote"
    });
    const workflowSpec = {
      version: 2,
      name: "vibe-safety",
      nodes: [{ id: "security", uses: "engine.security" }],
      verifiers: [{ id: "syntax-gate", uses: "verify.syntax", needs: ["security"] }],
      synthesizer: { needs: ["syntax-gate"] }
    } as WorkflowSpec;
    const workflow = auditStore.createWorkflowRevision({ workflowId: "vibe-safety", spec: workflowSpec });
    const policy = auditStore.createPolicyRevision({ policyId: "default-safety", name: "Default safety" });
    const automation = auditStore.createAutomation({
      repositoryId: repository.id,
      name: "Mapped export auto",
      trigger: { type: "manual" },
      workflowRevisionId: workflow.id,
      policyRevisionId: policy.id,
      runtimeDefinitionId: "def-runtime-x",
      enabled: true
    });

    // Run A: full lifecycle with a terminal workflow-runtime outcome.
    const finished = auditStore.createAuditRunDraft({
      repositoryId: repository.id,
      source: "manual",
      automationId: automation.id,
      workflowRevisionId: workflow.id,
      policyRevisionId: policy.id
    });
    auditStore.markRunQueued(finished.id);
    auditStore.markRunRunning(finished.id, { workflowRuntimeRunId: "wfrun_export_1" });
    auditStore.markRunTerminal(finished.id, "succeeded", { workflowRuntimeRunId: "wfrun_export_1" });

    // Run B: raw draft without automation or link (sparse export shape).
    const bare = auditStore.createAuditRunDraft({
      repositoryId: remoteRepository.id,
      source: "manual",
      workflowRevisionId: workflow.id,
      policyRevisionId: policy.id
    });

    // The composition root wires the host that resolves linked-run summaries.
    const server = createApiServer({
      auditStore,
      workflowRuntime: new WorkflowRuntimeHost({ store: workflowRuntimeStore })
    });
    servers.push(server);
    const port = await listen(server);

    const events = await call(port, "GET", `/audit-runs/${finished.id}/events`);
    expect(events.status).toBe(200);
    expect(events.body.events.map((event: { eventType: string }) => event.eventType))
      .toEqual(["run_queued", "run_running", "run_succeeded"]);
    for (const [index, event] of (events.body.events as Array<Record<string, unknown>>).entries()) {
      expect(Object.keys(event).sort()).toEqual(["auditRunId", "createdAt", "eventType", "id", "payload", "seq"]);
      expect(event.seq).toBe(index + 1);
      if (index > 0) {
        const previous = (events.body.events as Array<{ createdAt: string }>)[index - 1]!;
        expect(event.auditRunId).toBe(finished.id);
        expect(String(event.createdAt) >= previous.createdAt).toBe(true);
      }
    }

    const exportDoc = await call(port, "GET", `/audit-runs/${finished.id}/export`);
    expect(exportDoc.status).toBe(200);
    expect(exportDoc.body).toMatchObject({
      schemaVersion: 1,
      run: { id: finished.id, status: "succeeded", workflowRuntimeRunId: "wfrun_export_1" },
      events: events.body.events,
      automation: { id: automation.id },
      workflowRuntimeRun: {
        runId: "wfrun_export_1",
        definitionId: "def-runtime-x",
        revisionId: "rev-7",
        status: "succeeded",
        headSha: "deadbeefcafe",
        findingCount: 2,
        evidenceCount: 3
      }
    });
    expect(JSON.stringify(exportDoc.body)).not.toContain("\\\\fixture");
    const exportViaPost = await call(port, "POST", `/audit-runs/${finished.id}/export`);
    expect(exportViaPost.status).toBe(200);
    expect(exportViaPost.body.run).toEqual(exportDoc.body.run);
    expect(exportViaPost.body.events).toEqual(events.body.events);

    const bareExport = await call(port, "GET", `/audit-runs/${bare.id}/export`);
    expect(bareExport.status).toBe(200);
    expect(bareExport.body.events).toEqual([]);
    expect(bareExport.body).not.toHaveProperty("automation");
    expect(bareExport.body).not.toHaveProperty("workflowRuntimeRun");

    // Unknown runs keep the canonical audit 404 on every supported verb;
    // unsupported verbs stay on the generic router fallback.
    expect(await call(port, "GET", "/audit-runs/auditrun_missing/events")).toMatchObject({
      status: 404,
      body: { error: { code: "AUDIT_RUN_NOT_FOUND" } }
    });
    expect(await call(port, "POST", "/audit-runs/auditrun_missing/unknown-action")).toMatchObject({
      status: 404,
      body: { error: { code: "NOT_FOUND" } }
    });
    for (const method of ["GET", "POST"] as const) {
      expect(await call(port, method, "/audit-runs/auditrun_missing/export")).toMatchObject({
        status: 404,
        body: { error: { code: "AUDIT_RUN_NOT_FOUND" } }
      });
    }
  });

  it("executor wiring flips capabilities and planning availability computed per subject", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    runMigrations(database);
    const flags = { armed: false };
    let store: SQLiteAuditDomainStore | undefined;
    const wiredStore = new SQLiteAuditDomainStore(database, {
      workflowRuntime: {
        definitionExists: () => true,
        getLatestValidatedRevision: () => ({ revisionId: "rev-seed" }) as any
      },
      resolveExecutionAvailability: subject => {
        const current = store!;
        if (!flags.armed) return { available: false, reason: AUDIT_EXECUTION_DISABLED_REASON };
        const automation = current.getAutomation(subject.automationId);
        if (automation === undefined || automation.runtimeDefinitionId === undefined) {
          return { available: false, reason: AUDIT_EXECUTION_AUTOMATION_NOT_MAPPED_REASON };
        }
        const repository = current.getRepository(subject.repositoryId);
        if (repository === undefined || repository.source !== "local_git") {
          return { available: false, reason: AUDIT_EXECUTION_LOCAL_REPOSITORY_REQUIRED_REASON };
        }
        return { available: true };
      }
    });
    store = wiredStore;

    const repository = wiredStore.createRepository({
      displayName: "Fixture Local",
      source: "local_git",
      monitoringEnabled: true
    }, { serverLocator: "\\\\fixture\\server\\checkout" });
    const remoteRepository = wiredStore.createRepository({
      displayName: "Fixture Remote",
      source: "github",
      remoteFullName: "owner/fixture-remote"
    });
    const workflowSpec = {
      version: 2,
      name: "vibe-safety",
      nodes: [{ id: "security", uses: "engine.security" }],
      verifiers: [{ id: "syntax-gate", uses: "verify.syntax", needs: ["security"] }],
      synthesizer: { needs: ["syntax-gate"] }
    } as WorkflowSpec;
    const workflow = wiredStore.createWorkflowRevision({ workflowId: "vibe-safety", spec: workflowSpec });
    const policy = wiredStore.createPolicyRevision({ policyId: "default-safety", name: "Default safety" });
    const mappedLocal = wiredStore.createAutomation({
      repositoryId: repository.id,
      name: "Mapped local",
      trigger: { type: "manual" },
      workflowRevisionId: workflow.id,
      policyRevisionId: policy.id,
      runtimeDefinitionId: "def-runtime-x",
      enabled: true
    }).id;
    const legacyOnly = wiredStore.createAutomation({
      repositoryId: repository.id,
      name: "Legacy only",
      trigger: { type: "manual" },
      workflowRevisionId: workflow.id,
      policyRevisionId: policy.id,
      enabled: true
    }).id;
    const mappedRemote = wiredStore.createAutomation({
      repositoryId: remoteRepository.id,
      name: "Mapped remote",
      trigger: { type: "manual" },
      workflowRevisionId: workflow.id,
      policyRevisionId: policy.id,
      runtimeDefinitionId: "def-runtime-x",
      enabled: true
    }).id;

    const server = createApiServer({
      auditStore: wiredStore,
      auditPlanner: new AuditRunPlanner(wiredStore),
      auditExecution: { enabled: flags.armed }
    });
    servers.push(server);
    const port = await listen(server);

    // Disarmed executor: capability false and every planned draft is honestly
    // draft-only, even a mapped local one.
    const disarmedCapabilities = (await call(port, "GET", "/audit/capabilities")).body;
    expect(disarmedCapabilities.auditExecution).toBe(false);
    expect(disarmedCapabilities.auditRunEvents).toBe(true);
    expect(disarmedCapabilities.auditExport).toBe(true);
    const disarmedPlan = (await call(port, "POST", `/automations/${mappedLocal}/run`)).body.planning;
    expect(disarmedPlan.execution).toEqual({ available: false, reason: AUDIT_EXECUTION_DISABLED_REASON });

    flags.armed = true;
    // The composition root snapshots arm state per process; a second server
    // wired to the SAME armed store shows the capability truth flip.
    const armedServer = createApiServer({
      auditStore: wiredStore,
      auditPlanner: new AuditRunPlanner(wiredStore),
      auditExecution: { enabled: true }
    });
    servers.push(armedServer);
    await new Promise<void>(resolve => armedServer.listen(0, "127.0.0.1", resolve));
    const armedPort = getListenPort(armedServer);
    expect((await call(armedPort, "GET", "/audit/capabilities")).body.auditExecution).toBe(true);

    // Mapped + local → available. Legacy-only mapping and non-local repos stay honest.
    const localPlan = (await call(armedPort, "POST", `/automations/${mappedLocal}/run`)).body.planning;
    expect(localPlan.execution).toEqual({ available: true });
    const legacyPlan = (await call(armedPort, "POST", `/automations/${legacyOnly}/run`)).body.planning;
    expect(legacyPlan.execution).toEqual({
      available: false,
      reason: AUDIT_EXECUTION_AUTOMATION_NOT_MAPPED_REASON
    });
    const remotePlan = (await call(armedPort, "POST", `/automations/${mappedRemote}/run`)).body.planning;
    expect(remotePlan.execution).toEqual({
      available: false,
      reason: AUDIT_EXECUTION_LOCAL_REPOSITORY_REQUIRED_REASON
    });
  });
});

function getListenPort(server: ReturnType<typeof createApiServer>): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected ephemeral port");
  return address.port;
}
