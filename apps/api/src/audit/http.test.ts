import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type ConsistencyDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
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
      source: "github",
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
    };
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
    expect(await call(port, "GET", `/audit-runs/${runId}/events`)).toMatchObject({
      status: 501,
      body: { error: { details: { capability: "auditRunEvents" } } }
    });
    expect(await call(port, "GET", `/audit-runs/${runId}/export`)).toMatchObject({
      status: 501,
      body: { error: { details: { capability: "auditExport" } } }
    });
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
});
