import { request } from "node:http";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "./http";
import { InMemoryJobQueue } from "./jobQueue";
import prReportFixture from "../../../tests/fixtures/pr_report_minimal.json";

const validAnalysisResult = {
  risk_score: 0.1,
  raw_score: 0.1,
  risk_level: "Minor Drift",
  risk_colour: "YELLOW",
  breakdown: { semantic: 0.1 },
  signal_results: {
    semantic: {
      signal_name: "semantic",
      score: 0.1,
      evidence: [],
      confidence: 1,
      metadata: {}
    }
  },
  signal_composition: { semantic: 1 },
  dominant_signals: ["semantic"],
  confidence: 0.8,
  explainability: {
    dominant_signals: ["semantic"],
    contributions: { semantic: 1 },
    evidence_chain: [{ signal_name: "semantic", text: "changed" }],
    confidence: 0.8
  },
  agent_collaboration: {
    scope: "file.py",
    decision: "monitor",
    consensus_score: 0.1,
    confidence: 0.8,
    quorum: "5/5",
    participants: ["SemanticAgent"],
    protocol: "parallel_agents -> evidence_normalization -> weighted_consensus -> reviewer_handoff"
  },
  evidence: [],
  agent_details: {
    SemanticAgent: {
      score: 0.1,
      evidence: [],
      elapsed_ms: 1
    }
  }
};

function httpJson(
  port: number,
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const raw = payload === undefined ? "" : JSON.stringify(payload);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
          ...(raw.length === 0 ? {} : { "content-length": String(Buffer.byteLength(raw)) }),
          ...headers
        }
      },
      res => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", chunk => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: responseBody ? JSON.parse(responseBody) : {}, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    req.end(raw);
  });
}

function postJson(
  port: number,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown; headers: Record<string, string | string[] | undefined> }> {
  return httpJson(port, "POST", path, payload, headers);
}

function getJson(port: number, path: string): Promise<{ status: number; body: unknown; headers: Record<string, string | string[] | undefined> }> {
  return httpJson(port, "GET", path);
}

function githubSignature(payload: unknown, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex")}`;
}

async function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }
  return address.port;
}

function enqueuePullRequestJob(jobs: InMemoryJobQueue) {
  return jobs.enqueue({
    kind: "pull_request",
    deliveryId: "delivery-queued",
    repository: "sk1ua/ConsistenCy",
    pullRequestNumber: 31,
    baseSha: "abcdef1",
    headSha: "1234567",
    installationId: 123
  });
}

describe("createApiServer", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        server =>
          new Promise<void>(resolve => {
            server.close(() => resolve());
          })
      )
    );
    servers.length = 0;
    for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("enforces CORS allow lists and the request body limit", async () => {
    const server = createApiServer({ allowedOrigins: ["https://dashboard.example.com"] });
    servers.push(server);
    const port = await listen(server);

    const allowed = await httpJson(port, "GET", "/health", undefined, { origin: "https://dashboard.example.com" });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://dashboard.example.com");
    const denied = await httpJson(port, "GET", "/health", undefined, { origin: "https://evil.example.com" });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();

    const oversized = await postJson(port, "/demo/seed", { value: "x".repeat(1024 * 1024) });
    expect(oversized.status).toBe(413);
    expect(oversized.body).toMatchObject({ error: { code: "BODY_TOO_LARGE" } });
  });

  it("projects health and settings without renderer-visible filesystem paths", async () => {
    const internalSettings = {
      llm: {
        provider: "mock" as const,
        deepseekBaseUrl: "https://api.deepseek.com",
        deepseekModel: "deepseek-chat",
        openaiModel: "gpt-4o-mini",
        deepseekApiKeyConfigured: false,
        openaiApiKeyConfigured: false
      },
      github: {
        appId: "",
        privateKeyConfigured: false,
        webhookSecretConfigured: false,
        publicReadTokenConfigured: false
      },
      runtime: {
        databasePath: "D:/private/state/consistency.db",
        workspaceRoot: "D:/private/workspaces",
        localReviewRoots: "D:/private/repositories",
        workerConcurrency: 1,
        workerPollIntervalMs: 1_000,
        webUrl: "http://127.0.0.1:5173",
        apiTokenConfigured: false
      },
      overriddenByEnvironment: [],
      restartRequired: false
    };
    const server = createApiServer({
      settings: { get: () => internalSettings, update: () => internalSettings },
      healthDetails: () => ({
        database: { ok: true },
        worker: { running: false, activeJobs: 0, concurrency: 1 },
        llmProvider: "mock",
        configuration: {
          githubAppConfigured: false,
          webhookSecretConfigured: false,
          publicReadTokenConfigured: false,
          storage: { kind: "file", configured: true },
          databasePath: "D:/private/state/consistency.db",
          workspaceRoot: "D:/private/workspaces",
          workerConcurrency: 1,
          demoMode: true
        }
      } as any)
    });
    servers.push(server);
    const port = await listen(server);

    const health = await getJson(port, "/health");
    const healthBody = health.body as any;
    expect(healthBody.configuration).toMatchObject({ storage: { kind: "file", configured: true } });
    expect(healthBody.configuration).not.toHaveProperty("databasePath");
    expect(healthBody.configuration).not.toHaveProperty("workspaceRoot");

    const settings = await getJson(port, "/settings");
    const settingsBody = settings.body as any;
    expect(settingsBody.settings.runtime).toMatchObject({
      storage: { kind: "file", configured: true },
      workspace: { configured: true },
      localReview: { configured: true, rootCount: 1 }
    });
    expect(JSON.stringify({ health: healthBody, settings: settingsBody })).not.toContain("D:/private");
  });

  it("verifies GitHub pull_request webhooks and enqueues review jobs", async () => {
    const jobs = new InMemoryJobQueue();
    const server = createApiServer({ jobs, githubWebhookSecret: "secret" });
    servers.push(server);
    const port = await listen(server);

    const payload = {
      action: "synchronize",
      repository: { full_name: "sk1ua/ConsistenCy" },
      installation: { id: 123 },
      sender: { login: "octocat" },
      pull_request: {
        number: 31,
        base: { sha: "abcdef1" },
        head: { sha: "1234567" }
      }
    };

    const response = await postJson(port, "/github/webhook", payload, {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": githubSignature(payload, "secret")
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: "enqueued",
      event: "pull_request",
      job: {
        kind: "pull_request",
        status: "queued",
        repository: "sk1ua/ConsistenCy",
        pullRequestNumber: 31,
        baseSha: "abcdef1",
        headSha: "1234567",
        installationId: 123
      }
    });

    const jobsResponse = await getJson(port, "/jobs");
    expect(jobsResponse.status).toBe(200);
    expect(jobsResponse.body).toMatchObject({
      jobs: [
        {
          type: "PR_REVIEW",
          repositoryFullName: "sk1ua/ConsistenCy"
        }
      ]
    });

    const duplicate = await postJson(port, "/github/webhook", payload, {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": githubSignature(payload, "secret")
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ status: "duplicate" });
    expect(jobs.list()).toHaveLength(1);
  });

  it("records push deliveries as ignored without creating a job", async () => {
    const jobs = new InMemoryJobQueue();
    const server = createApiServer({ jobs, githubWebhookSecret: "secret" });
    servers.push(server);
    const port = await listen(server);
    const payload = { ref: "refs/heads/main", repository: { full_name: "sk1ua/ConsistenCy" } };

    const response = await postJson(port, "/github/webhook", payload, {
      "x-github-event": "push",
      "x-github-delivery": "delivery-push",
      "x-hub-signature-256": githubSignature(payload, "secret")
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ignored", reason: "push reviews are not supported" });
    expect(jobs.list()).toHaveLength(0);
    expect(jobs.getWebhookDelivery("delivery-push")?.status).toBe("ignored");
  });

  it("rejects webhook requests when no secret is configured", async () => {
    const server = createApiServer({ githubWebhookSecret: "" });
    servers.push(server);
    const port = await listen(server);

    const response = await postJson(port, "/github/webhook", {}, {
      "x-github-event": "ping",
      "x-github-delivery": "delivery-unconfigured"
    });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: "WEBHOOK_NOT_CONFIGURED" } });
  });

  it("rejects GitHub webhooks with an invalid signature", async () => {
    const jobs = new InMemoryJobQueue();
    const server = createApiServer({ jobs, githubWebhookSecret: "secret" });
    servers.push(server);
    const port = await listen(server);

    const response = await postJson(
      port,
      "/github/webhook",
      { zen: "Keep it logically awesome." },
      {
        "x-github-event": "ping",
        "x-github-delivery": "delivery-2",
        "x-hub-signature-256": "sha256=bad"
      }
    );

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: "INVALID_SIGNATURE" } });
    expect(jobs.list()).toHaveLength(0);
  });

  it("persists signed but invalid deliveries as failed", async () => {
    const jobs = new InMemoryJobQueue();
    const server = createApiServer({ jobs, githubWebhookSecret: "secret" });
    servers.push(server);
    const port = await listen(server);
    const payload = { action: "opened" };

    const response = await postJson(port, "/github/webhook", payload, {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-invalid",
      "x-hub-signature-256": githubSignature(payload, "secret")
    });

    expect(response.status).toBe(400);
    expect(jobs.list()).toHaveLength(0);
    expect(jobs.getWebhookDelivery("delivery-invalid")?.status).toBe("failed");
  });

  it("rejects webhooks with an invalid SHA format (e.g., non-hex or bad length)", async () => {
    const jobs = new InMemoryJobQueue();
    const server = createApiServer({ jobs, githubWebhookSecret: "secret" });
    servers.push(server);
    const port = await listen(server);

    const payload = {
      action: "opened",
      repository: { full_name: "sk1ua/ConsistenCy" },
      installation: { id: 123 },
      sender: { login: "octocat" },
      pull_request: {
        number: 31,
        base: { sha: "abcdefg" }, // "g" is non-hex, also not 40 chars
        head: { sha: "1234567" }
      }
    };

    const response = await postJson(port, "/github/webhook", payload, {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-bad-sha",
      "x-hub-signature-256": githubSignature(payload, "secret")
    });

    expect(response.status).toBe(400);
    expect(jobs.list()).toHaveLength(0);
    expect(jobs.getWebhookDelivery("delivery-bad-sha")?.status).toBe("failed");
  });



  it("protects management routes with a bearer token", async () => {
    const server = createApiServer({ apiToken: "api-secret" });
    servers.push(server);
    const port = await listen(server);

    const unauthorized = await getJson(port, "/jobs");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    const authorized = await httpJson(port, "GET", "/jobs", undefined, {
      authorization: "Bearer api-secret"
    });
    expect(authorized.status).toBe(200);
  });

  it("seeds demo reports and exposes filters, stats, and recent reports", async () => {
    const jobs = new InMemoryJobQueue();
    const server = createApiServer({ jobs, nodeEnv: "development" });
    servers.push(server);
    const port = await listen(server);

    const seeded = await postJson(port, "/demo/seed", {});
    expect(seeded.status).toBe(201);
    expect(seeded.body).toEqual({ created: 8 });

    const filtered = await getJson(port, "/jobs?status=succeeded&repository=payments&severity=medium");
    expect(filtered.status).toBe(200);
    expect(filtered.body).toMatchObject({
      jobs: [{ repositoryFullName: "acme/payments-api", status: "succeeded" }]
    });

    const stats = await getJson(port, "/stats");
    expect(stats.body).toMatchObject({ totalJobs: 8, succeededJobs: 5, failedJobs: 1, runningJobs: 1 });

    const reports = await getJson(port, "/reports/recent?limit=2");
    const recent = (reports.body as { reports: Array<{ repositoryFullName: string }> }).reports;
    expect(recent).toHaveLength(2);
    expect(recent[0]?.repositoryFullName).toBe("sk1ua/ConsistenCy");
  });

  it("serves review report when job status is awaiting_publish", async () => {
    const jobs = new InMemoryJobQueue();
    const server = createApiServer({ jobs });
    servers.push(server);
    const port = await listen(server);

    const job = enqueuePullRequestJob(jobs);
    jobs.markRunning(job.id);
    jobs.persistReportAndEnqueuePublish(job.id, {
      jobId: job.id,
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 31,
      baseSha: "abcdef1",
      headSha: "1234567",
      summary: "Awaiting publish report test",
      score: 92,
      riskLevel: "low",
      agentRuns: [],
      findings: [],
      createdAt: "2026-07-30T12:00:00.000Z"
    });

    const res = await getJson(port, `/jobs/${job.id}/report`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      report: {
        score: 92,
        summary: "Awaiting publish report test"
      }
    });
  });
});
