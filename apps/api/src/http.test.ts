import { request, ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repositoryCommitsResponseSchema, repositoryGitStatusResponseSchema, repositoryPullRequestsResponseSchema, reviewPreparationResponseSchema, type Repository } from "@consistency/schema";
import { LocalGitAdapter } from "@consistency/vcs-core";
import { createApiServer, ApiError } from "./http";
import { InMemoryJobQueue } from "./jobQueue";
import type { SettingsSnapshot } from "./config/settings";
import type { RepositoryPullRequestRequest } from "./github/pullRequestReader";
import { AuditDomainError, type AuditDomainStore } from "./audit/store";

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

class TestAuditStore implements AuditDomainStore {
  private readonly repositories = new Map<string, Repository>();
  private readonly localRepositoryPaths = new Map<string, string>();
  private repositoryCount = 0;

  registerLocal(displayName: string, serverLocator: string): Repository {
    return this.register({ displayName, source: "local_git" }, serverLocator);
  }

  registerRemote(displayName: string, remoteFullName: string): Repository {
    return this.register({ displayName, source: "github", remoteFullName });
  }

  listRepositories(): Repository[] {
    return [...this.repositories.values()];
  }

  getRepository(id: string): Repository | undefined {
    return this.repositories.get(id);
  }

  findRepositoryByRemoteFullName(remoteFullName: string): Repository | undefined {
    const normalized = remoteFullName.toLowerCase();
    return this.listRepositories().find(repository => repository.remoteFullName?.toLowerCase() === normalized);
  }

  getLocalRepositoryPath(id: string): string | undefined {
    return this.localRepositoryPaths.get(id);
  }

  registerLocalRepository(): never { throw new Error("Not implemented in HTTP route tests"); }
  connectGitHubRepository(): never { throw new Error("Not implemented in HTTP route tests"); }
  createRepository(): never { throw new Error("Not implemented in HTTP route tests"); }
  setRepositoryMonitoring(id: string, enabled: boolean): Repository {
    const existing = this.repositories.get(id);
    if (!existing) {
      throw new AuditDomainError("Repository not found", "REPOSITORY_NOT_FOUND", 404);
    }
    const updated: Repository = {
      ...existing,
      monitoringEnabled: enabled,
      updatedAt: new Date().toISOString()
    };
    this.repositories.set(id, updated);
    return updated;
  }
  listLocalRepositorySupervisionTargets(): never { throw new Error("Not implemented in HTTP route tests"); }
  listRepositoryEvents(): never { throw new Error("Not implemented in HTTP route tests"); }
  getRepositoryEvent(): never { throw new Error("Not implemented in HTTP route tests"); }
  saveRepositoryEvent(): never { throw new Error("Not implemented in HTTP route tests"); }
  listRepositoryPulses(): never { throw new Error("Not implemented in HTTP route tests"); }
  saveRepositoryPulse(): never { throw new Error("Not implemented in HTTP route tests"); }
  listWorkflowRevisions(): never { throw new Error("Not implemented in HTTP route tests"); }
  getWorkflowRevision(): never { throw new Error("Not implemented in HTTP route tests"); }
  createWorkflowRevision(): never { throw new Error("Not implemented in HTTP route tests"); }
  listPolicyRevisions(): never { throw new Error("Not implemented in HTTP route tests"); }
  getPolicyRevision(): never { throw new Error("Not implemented in HTTP route tests"); }
  createPolicyRevision(): never { throw new Error("Not implemented in HTTP route tests"); }
  listAutomations(): never { throw new Error("Not implemented in HTTP route tests"); }
  getAutomation(): never { throw new Error("Not implemented in HTTP route tests"); }
  createAutomation(): never { throw new Error("Not implemented in HTTP route tests"); }
  setAutomationEnabled(): never { throw new Error("Not implemented in HTTP route tests"); }
  listAuditRuns(): never { throw new Error("Not implemented in HTTP route tests"); }
  getAuditRun(): never { throw new Error("Not implemented in HTTP route tests"); }
  createAuditRunDraft(): never { throw new Error("Not implemented in HTTP route tests"); }
  listAuditRunPlanningReceipts(): never { throw new Error("Not implemented in HTTP route tests"); }
  planAuditRunDraft(): never { throw new Error("Not implemented in HTTP route tests"); }
  getAutomationScheduleState(): never { throw new Error("Not implemented in HTTP route tests"); }
  ensureAutomationScheduleState(): never { throw new Error("Not implemented in HTTP route tests"); }
  listAutomationScheduleWindows(): never { throw new Error("Not implemented in HTTP route tests"); }
  completeAutomationScheduleWindow(): never { throw new Error("Not implemented in HTTP route tests"); }
  cancelAuditRun(): never { throw new Error("Not implemented in HTTP route tests"); }
  listRunStepArtifacts(): never { throw new Error("Not implemented in HTTP route tests"); }
  saveRunStepArtifact(): never { throw new Error("Not implemented in HTTP route tests"); }
  listIssues(): never { throw new Error("Not implemented in HTTP route tests"); }
  getIssue(): never { throw new Error("Not implemented in HTTP route tests"); }
  createIssue(): never { throw new Error("Not implemented in HTTP route tests"); }
  applyIssueAction(): never { throw new Error("Not implemented in HTTP route tests"); }
  saveFindingOccurrence(): never { throw new Error("Not implemented in HTTP route tests"); }
  listEvolutionSnapshots(): never { throw new Error("Not implemented in HTTP route tests"); }
  saveEvolutionSnapshot(): never { throw new Error("Not implemented in HTTP route tests"); }
  getAuditReport(): never { throw new Error("Not implemented in HTTP route tests"); }
  saveAuditReport(): never { throw new Error("Not implemented in HTTP route tests"); }

  private register(
    input: { readonly displayName: string; readonly source: "local_git" | "github"; readonly remoteFullName?: string },
    serverLocator?: string
  ): Repository {
    this.repositoryCount += 1;
    const createdAt = "2026-08-23T00:00:00.000Z";
    const repository: Repository = {
      id: `repo_registered_${this.repositoryCount}`,
      displayName: input.displayName,
      source: input.source,
      ...(input.remoteFullName === undefined ? {} : { remoteFullName: input.remoteFullName }),
      trustLevel: input.source === "local_git" ? "trusted_local" : "untrusted_readonly",
      monitoringEnabled: true,
      createdAt,
      updatedAt: createdAt
    };
    this.repositories.set(repository.id, repository);
    if (serverLocator !== undefined) this.localRepositoryPaths.set(repository.id, serverLocator);
    return repository;
  }
}

function createAuditStore(): TestAuditStore {
  return new TestAuditStore();
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

    const oversized = await postJson(port, "/reviews/local", { value: "x".repeat(1024 * 1024) });
    expect(oversized.status).toBe(413);
    expect(oversized.body).toMatchObject({ error: { code: "BODY_TOO_LARGE" } });
  });

  it("projects health and settings without renderer-visible filesystem paths", async () => {
    const internalSettings = {
      llm: {
        provider: "none" as const,
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
        llmConfigured: false,
        llmProvider: "none",
        configuration: {
          githubAppConfigured: false,
          webhookSecretConfigured: false,
          publicReadTokenConfigured: false,
          storage: { kind: "file", configured: true },
          databasePath: "D:/private/state/consistency.db",
          workspaceRoot: "D:/private/workspaces",
          workerConcurrency: 1
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

  it("records PR webhook deliveries as ignored without creating ReviewJob when LLM is unconfigured", async () => {
    const jobs = new InMemoryJobQueue();
    const server = createApiServer({
      jobs,
      githubWebhookSecret: "secret",
      llmProviderConfigured: false
    });
    servers.push(server);
    const port = await listen(server);
    const payload = {
      action: "opened",
      number: 42,
      repository: { full_name: "sk1ua/ConsistenCy" },
      sender: { login: "sk1ua" },
      installation: { id: 123 },
      pull_request: {
        number: 42,
        base: { sha: "abcdef1" },
        head: { sha: "1234567" }
      }
    };

    const response = await postJson(port, "/github/webhook", payload, {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-no-llm",
      "x-hub-signature-256": githubSignature(payload, "secret")
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ignored",
      event: "pull_request",
      deliveryId: "delivery-no-llm",
      reason: "llm provider not configured"
    });
    expect(jobs.list()).toHaveLength(0);
    expect(jobs.getWebhookDelivery("delivery-no-llm")?.status).toBe("ignored");

    // Idempotent duplicate check
    const duplicate = await postJson(port, "/github/webhook", payload, {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-no-llm",
      "x-hub-signature-256": githubSignature(payload, "secret")
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ status: "duplicate" });
    expect(jobs.list()).toHaveLength(0);
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

  it("reports available: false for unresolvable repository git status without fabricating clean state", async () => {
    const server = createApiServer({});
    servers.push(server);
    const port = await listen(server);

    const res = await getJson(port, "/repositories/unknown-remote-repo/git/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      repositoryId: "unknown-remote-repo",
      available: false,
      reason: "local repository path unavailable",
      dirtyFileCount: 0,
      changedFiles: []
    });
  });

  it("reports a registered non-Git repository status as unavailable without leaking its path", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "consistency-http-non-git-repository-"));
    tempDirectories.push(repositoryPath);
    const auditStore = createAuditStore();
    const repository = auditStore.registerLocal("Unreadable repository", repositoryPath);
    const server = createApiServer({ auditStore });
    servers.push(server);
    const port = await listen(server);

    const response = await getJson(port, `/repositories/${repository.id}/git/status`);
    const status = repositoryGitStatusResponseSchema.parse(response.body);

    expect(response.status).toBe(200);
    expect(status).toEqual({
      repositoryId: repository.id,
      available: false,
      reason: "failed to execute git status",
      branch: null,
      headSha: null,
      dirtyFileCount: 0,
      untrackedFileCount: 0,
      changedFiles: [],
      untrackedFiles: [],
      remotes: []
    });
    expect(JSON.stringify(status)).not.toContain(repositoryPath);
  });

  it("waits for a pending untracked read before returning a required diff failure", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "consistency-http-status-settlement-"));
    tempDirectories.push(repositoryPath);
    const auditStore = createAuditStore();
    const repository = auditStore.registerLocal("Settling repository", repositoryPath);
    const server = createApiServer({ auditStore });
    servers.push(server);
    const port = await listen(server);
    let releaseUntracked: (() => void) | undefined;
    let markUntrackedStarted: (() => void) | undefined;
    const untrackedReadStarted = new Promise<void>(resolve => {
      markUntrackedStarted = () => resolve();
    });
    const pendingUntrackedRead = new Promise<void>(resolve => {
      releaseUntracked = () => resolve();
    });
    const workingDiffRead = vi.spyOn(LocalGitAdapter.prototype, "getWorkingDiff").mockRejectedValue(new Error("working diff failure"));
    const untrackedRead = vi.spyOn(LocalGitAdapter.prototype, "getUntrackedFiles").mockImplementation(async () => {
      markUntrackedStarted?.();
      await pendingUntrackedRead;
      return [];
    });
    const responseEnd = vi.spyOn(ServerResponse.prototype, "end");

    try {
      const responsePromise = getJson(port, `/repositories/${repository.id}/git/status`);
      await untrackedReadStarted;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(responseEnd).not.toHaveBeenCalled();

      if (releaseUntracked === undefined) throw new Error("Expected untracked read release");
      releaseUntracked();
      const response = await responsePromise;
      const status = repositoryGitStatusResponseSchema.parse(response.body);

      expect(untrackedRead).toHaveBeenCalledOnce();
      expect(responseEnd).toHaveBeenCalledOnce();
      expect(status).toMatchObject({
        repositoryId: repository.id,
        available: false,
        reason: "failed to execute git status",
        changedFiles: [],
        untrackedFiles: []
      });
    } finally {
      releaseUntracked?.();
      responseEnd.mockRestore();
      untrackedRead.mockRestore();
      workingDiffRead.mockRestore();
    }
  });

  it("uses only an exact registered ID for local Git status and commits", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "consistency-http-local-repository-"));
    tempDirectories.push(repositoryPath);
    execFileSync("git", ["init", "--quiet"], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "audit@example.com"], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Auditor"], { cwd: repositoryPath, stdio: "ignore" });
    writeFileSync(join(repositoryPath, "README.md"), "local repository\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync("git", ["commit", "--quiet", "-m", "Initial repository"], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/private.git"], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "upstream", "https://username:very-secret-token@example.test/private.git"], { cwd: repositoryPath, stdio: "ignore" });

    const auditStore = createAuditStore();
    const repository = auditStore.registerLocal("Friendly checkout", repositoryPath);
    const server = createApiServer({ auditStore });
    servers.push(server);
    const port = await listen(server);

    const statusRes = await getJson(port, `/repositories/${repository.id}/git/status`);
    const status = repositoryGitStatusResponseSchema.parse(statusRes.body);
    expect(statusRes.status).toBe(200);
    expect(status).toMatchObject({
      repositoryId: repository.id,
      available: true,
      remotes: [
        { name: "origin", githubFullName: "acme/private" },
        { name: "upstream" }
      ],
      primaryRemote: { name: "origin", githubFullName: "acme/private" }
    });
    expect(JSON.stringify(status)).not.toContain("very-secret-token");
    expect(JSON.stringify(status)).not.toContain("username@");

    const commitsRes = await getJson(port, `/repositories/${repository.id}/git/commits?depth=5`);
    expect(commitsRes.status).toBe(200);
    const commitsBody = commitsRes.body as { repositoryId: string; commits: Array<{ sha: string; message: string }> };
    expect(commitsBody.repositoryId).toBe(repository.id);
    expect(commitsBody.commits).toHaveLength(1);
    expect(commitsBody.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commitsBody.commits[0]?.message).toBe("Initial repository");

    for (const selector of [
      "Friendly checkout",
      "origin",
      "acme/private",
      "local:Friendly checkout",
      repositoryPath,
      ".",
      "repo_unknown_999"
    ]) {
      const response = await getJson(port, `/repositories/${encodeURIComponent(selector)}/git/status`);
      if (response.status === 200) {
        expect(repositoryGitStatusResponseSchema.parse(response.body)).toMatchObject({
          repositoryId: selector,
          available: false,
          reason: "local repository path unavailable",
          remotes: []
        });
      } else {
        expect(response.status).toBe(404);
      }
    }
  });

  it("advertises the branch-diff source only against a verified trunk ref", async () => {
    const masterRepo = mkdtempSync(join(tmpdir(), "consistency-preparation-master-"));
    const onTrunkRepo = mkdtempSync(join(tmpdir(), "consistency-preparation-on-trunk-"));
    tempDirectories.push(masterRepo, onTrunkRepo);
    for (const repoPath of [masterRepo, onTrunkRepo]) {
      execFileSync("git", ["init", "--quiet", "--initial-branch=master"], { cwd: repoPath, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "audit@example.com"], { cwd: repoPath, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Auditor"], { cwd: repoPath, stdio: "ignore" });
      writeFileSync(join(repoPath, "README.md"), "trunk repository\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "ignore" });
      execFileSync("git", ["commit", "--quiet", "-m", "Initial repository"], { cwd: repoPath, stdio: "ignore" });
    }
    writeFileSync(join(masterRepo, "evidence.md"), "branch change\n", "utf8");
    execFileSync("git", ["checkout", "--quiet", "-b", "feature/evidence"], { cwd: masterRepo, stdio: "ignore" });
    execFileSync("git", ["add", "evidence.md"], { cwd: masterRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "--quiet", "-m", "Branch change"], { cwd: masterRepo, stdio: "ignore" });

    const auditStore = createAuditStore();
    const masterRepository = auditStore.registerLocal("Master trunk checkout", masterRepo);
    const onTrunkRepository = auditStore.registerLocal("On trunk checkout", onTrunkRepo);
    const server = createApiServer({ auditStore });
    servers.push(server);
    const port = await listen(server);

    const branchResponse = await getJson(port, `/repositories/${masterRepository.id}/review-preparation`);
    expect(branchResponse.status).toBe(200);
    const branchPreparation = reviewPreparationResponseSchema.parse(branchResponse.body);
    expect(branchPreparation.sources.branch).toEqual({
      available: true,
      base: "master",
      head: "feature/evidence"
    });

    const onTrunkResponse = await getJson(port, `/repositories/${onTrunkRepository.id}/review-preparation`);
    expect(onTrunkResponse.status).toBe(200);
    const onTrunkPreparation = reviewPreparationResponseSchema.parse(onTrunkResponse.body);
    expect(onTrunkPreparation.sources.branch).toEqual({
      available: false,
      head: "master",
      reason: "当前处于主分支，无法自动对比分支差异"
    });
  });

  it("reports readable empty history only for an exact registered local repository", async () => {
    const unbornRepository = mkdtempSync(join(tmpdir(), "consistency-history-unborn-"));
    tempDirectories.push(unbornRepository);
    execFileSync("git", ["init", "--quiet"], { cwd: unbornRepository, stdio: "ignore" });

    const auditStore = createAuditStore();
    const repository = auditStore.registerLocal("Unborn repository", unbornRepository);
    const server = createApiServer({ auditStore });
    servers.push(server);
    const port = await listen(server);

    const readableResponse = await getJson(
      port,
      `/repositories/${repository.id}/git/commits?depth=99`
    );
    const readable = repositoryCommitsResponseSchema.parse(readableResponse.body);
    expect(readableResponse.status).toBe(200);
    expect(readable).toEqual({
      repositoryId: repository.id,
      available: true,
      commits: []
    });

    const unavailableResponse = await getJson(
      port,
      `/repositories/${encodeURIComponent(unbornRepository)}/git/commits`
    );
    const unavailable = repositoryCommitsResponseSchema.parse(unavailableResponse.body);
    expect(unavailableResponse.status).toBe(200);
    expect(unavailable).toEqual({
      repositoryId: unbornRepository,
      available: false,
      reason: "local repository path unavailable",
      commits: []
    });
    if (unavailable.available) throw new Error("Expected unavailable commit history");
    expect(unavailable.reason).not.toContain(unbornRepository);
  });

  it("returns 404 for an unregistered opaque repository ID", async () => {
    let pullRequestServiceCalled = false;
    const server = createApiServer({
      pullRequestService: {
        list: async input => {
          pullRequestServiceCalled = true;
          return {
            repositoryId: input.repositoryId,
            available: false,
            reasonCode: "identity_unavailable",
            reason: "GitHub repository remote unavailable",
            pullRequests: []
          };
        }
      }
    });
    servers.push(server);
    const port = await listen(server);

    const response = await getJson(port, "/repositories/repository-without-a-github-remote/pull-requests");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "REPOSITORY_NOT_FOUND" } });
    expect(pullRequestServiceCalled).toBe(false);
  });

  it("serves provider summaries through the injected pull request service", async () => {
    const requests: RepositoryPullRequestRequest[] = [];
    const auditStore = createAuditStore();
    const repository = auditStore.registerRemote("Provider repository", "Octo/Repository");
    const server = createApiServer({
      auditStore,
      pullRequestService: {
        list: async input => {
          requests.push(input);
          return {
            repositoryId: input.repositoryId,
            repositoryFullName: "Octo/Repository",
            available: true,
            page: { limit: 100, truncated: true },
            pullRequests: [{
              provider: "github",
              number: 42,
              title: "Provider title",
              state: "open",
              draft: false,
              labels: [{ name: "review", color: "ededed" }],
              author: "octocat",
              baseRef: "main",
              headRef: "feature/provider",
              baseSha: "base-123",
              headSha: "head-456",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-02T00:00:00.000Z",
              closedAt: null,
              mergedAt: null,
              htmlUrl: "https://github.com/octo/repository/pull/42"
            }]
          };
        }
      }
    });
    servers.push(server);
    const port = await listen(server);

    const response = await getJson(port, `/repositories/${repository.id}/pull-requests`);
    const payload = repositoryPullRequestsResponseSchema.parse(response.body);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      repositoryId: repository.id,
      repositoryFullName: "Octo/Repository",
      available: true,
      page: { limit: 100, truncated: true },
      pullRequests: [{ provider: "github", number: 42, title: "Provider title" }]
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      repositoryId: repository.id,
      registeredRemoteFullName: "Octo/Repository",
      registeredSource: "github"
    });
    expect(requests[0]).not.toHaveProperty("localPath");
  });

  it.each([
    ["missing canonical identity", (repositoryId: string) => ({
      repositoryId,
      available: true,
      page: { limit: 100, truncated: false },
      pullRequests: []
    })],
    ["trailing-hyphen owner identity", (repositoryId: string) => ({
      repositoryId,
      repositoryFullName: "bad-/repo",
      available: true,
      page: { limit: 100, truncated: false },
      pullRequests: []
    })],
    ["all-dot repository identity", (repositoryId: string) => ({
      repositoryId,
      repositoryFullName: "owner/...",
      available: true,
      page: { limit: 100, truncated: false },
      pullRequests: []
    })],
    ["overlong identity components", (repositoryId: string) => ({
      repositoryId,
      repositoryFullName: `${"a".repeat(40)}/${"r".repeat(101)}`,
      available: true,
      page: { limit: 100, truncated: false },
      pullRequests: []
    })],
    ["more than 100 rows", (repositoryId: string) => ({
      repositoryId,
      repositoryFullName: "Octo/Repository",
      available: true,
      page: { limit: 100, truncated: true },
      pullRequests: Array.from({ length: 101 }, (_, index) => ({
        provider: "github" as const,
        number: index + 1,
        title: `Provider PR ${index + 1}`,
        state: "open" as const,
        draft: false,
        labels: [],
        author: null,
        baseRef: "main",
        headRef: `feature-${index + 1}`,
        baseSha: "base-123",
        headSha: "head-456",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        closedAt: null,
        mergedAt: null,
        htmlUrl: `https://github.com/Octo/Repository/pull/${index + 1}`
      }))
    })]
  ])("fails closed for an invalid injected PR service response: %s", async (_case, invalidResponse) => {
    const auditStore = createAuditStore();
    const repository = auditStore.registerRemote("Invalid service repository", "Octo/Repository");
    const server = createApiServer({
      auditStore,
      pullRequestService: {
        list: async input => invalidResponse(input.repositoryId) as never
      }
    });
    servers.push(server);
    const port = await listen(server);

    const response = await getJson(port, `/repositories/${repository.id}/pull-requests`);
    const serialized = JSON.stringify(response.body);

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: {
        code: "PULL_REQUEST_HISTORY_RESPONSE_INVALID",
        message: "Pull request history response is unavailable"
      }
    });
    expect(serialized).not.toContain("Zod");
    expect(serialized).not.toContain("pullRequests.100");
    expect(serialized).not.toContain("repositoryFullName");
  });

  it("serves sanitized typed pull request unavailability without secrets or paths", async () => {
    const auditStore = createAuditStore();
    const repository = auditStore.registerRemote("Unavailable repository", "Octo/Repository");
    const server = createApiServer({
      auditStore,
      pullRequestService: {
        list: async input => ({
          repositoryId: input.repositoryId,
          available: false,
          reasonCode: "rate_limited",
          reason: "GitHub rate limit reached",
          pullRequests: []
        })
      }
    });
    servers.push(server);
    const port = await listen(server);

    const response = await getJson(port, `/repositories/${repository.id}/pull-requests`);
    const payload = repositoryPullRequestsResponseSchema.parse(response.body);
    const serialized = JSON.stringify(response.body);

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      repositoryId: repository.id,
      available: false,
      reasonCode: "rate_limited",
      reason: "GitHub rate limit reached",
      pullRequests: []
    });
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  it("rejects /demo/seed as route not found", async () => {
    const jobs = new InMemoryJobQueue();
    const server = createApiServer({ jobs });
    servers.push(server);
    const port = await listen(server);

    const seeded = await postJson(port, "/demo/seed", {});
    expect(seeded.status).toBe(404);
  });

  it("rejects review start when LLM provider is not configured", async () => {
    const jobs = new InMemoryJobQueue();
    const auditStore = createAuditStore();
    const repository = auditStore.registerLocal("LLM test repository", "D:/workspace");
    const server = createApiServer({
      jobs,
      auditStore,
      localReview: async () => ({ jobId: "job_1" }),
      llmProviderConfigured: false
    });
    servers.push(server);
    const port = await listen(server);

    const res = await postJson(port, "/reviews/local", { repositoryId: repository.id });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: "LLM_NOT_CONFIGURED" }
    });
  });

  it("exposes filters, stats, and recent reports for review jobs", async () => {
    const jobs = new InMemoryJobQueue();
    const server = createApiServer({ jobs, nodeEnv: "development" });
    servers.push(server);
    const port = await listen(server);

    const job1 = jobs.enqueue({
      kind: "pull_request",
      deliveryId: "delivery-1",
      repository: "acme/payments-api",
      pullRequestNumber: 182,
      baseSha: "base1",
      headSha: "head1",
      installationId: 123
    });
    jobs.markRunning(job1.id);
    jobs.persistReportAndEnqueuePublish(job1.id, {
      jobId: job1.id,
      repositoryFullName: "acme/payments-api",
      pullRequestNumber: 182,
      baseSha: "base1",
      headSha: "head1",
      summary: "Payments review",
      score: 75,
      riskLevel: "medium",
      agentRuns: [],
      findings: [],
      createdAt: new Date().toISOString()
    });

    const filtered = await getJson(port, "/jobs?status=awaiting_publish&repository=payments");
    expect(filtered.status).toBe(200);
    expect(filtered.body).toMatchObject({
      jobs: [{ repositoryFullName: "acme/payments-api", status: "awaiting_publish" }]
    });

    const stats = await getJson(port, "/stats");
    expect(stats.body).toMatchObject({ totalJobs: 1 });

    const reports = await getJson(port, "/reports/recent?limit=1");
    const recent = (reports.body as { reports: Array<{ repositoryFullName: string }> }).reports;
    expect(recent).toHaveLength(1);
    expect(recent[0]?.repositoryFullName).toBe("acme/payments-api");
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

  it("enforces settings write capability: read-only in standalone production by default", async () => {
    let internalSettings = {
      llm: { provider: "deepseek" as const, deepseekModel: "deepseek-v4-flash", openaiModel: "gpt-4.1-mini" },
      github: { appId: "123" },
      runtime: {
        databasePath: ":memory:",
        workspaceRoot: "workspaces",
        localReviewRoots: "",
        workerConcurrency: 1,
        workerPollIntervalMs: 1000,
        webUrl: "http://127.0.0.1:5173",
        apiTokenConfigured: true
      },
      overriddenByEnvironment: []
    };
    const server = createApiServer({
      nodeEnv: "production",
      apiToken: "secret-token",
      settings: {
        get: () => internalSettings as any,
        update: patch => {
          internalSettings = { ...internalSettings, ...(patch as any) };
          return internalSettings as any;
        }
      }
    });
    servers.push(server);
    const port = await listen(server);

    const updateRes = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: "PUT",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ llm: { provider: "openai" } })
    });
    expect(updateRes.status).toBe(404);
    const errorBody = await updateRes.json() as any;
    expect(errorBody.error.code).toBe("SETTINGS_READ_ONLY");
  });

  it("enforces settings write capability: allows updates when settingsWritable is true in production", async () => {
    let internalSettings = {
      llm: { provider: "deepseek" as const, deepseekModel: "deepseek-v4-flash", openaiModel: "gpt-4.1-mini" },
      github: { appId: "123" },
      runtime: {
        databasePath: ":memory:",
        workspaceRoot: "workspaces",
        localReviewRoots: "",
        workerConcurrency: 1,
        workerPollIntervalMs: 1000,
        webUrl: "http://127.0.0.1:5173",
        apiTokenConfigured: true
      },
      overriddenByEnvironment: []
    };
    const server = createApiServer({
      nodeEnv: "production",
      settingsWritable: true,
      apiToken: "secret-token",
      settings: {
        get: () => internalSettings as any,
        update: patch => {
          internalSettings = { ...internalSettings, ...(patch as any) };
          return internalSettings as any;
        }
      }
    });
    servers.push(server);
    const port = await listen(server);

    const updateRes = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: "PUT",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ llm: { provider: "openai" } })
    });
    expect(updateRes.status).toBe(200);
    const successBody = await updateRes.json() as any;
    expect(successBody.settings.llm.provider).toBe("openai");
  });

  it("supports per-review model override on local review and rejects unconfigured or mock providers", async () => {
    const jobs = new InMemoryJobQueue();
    const auditStore = createAuditStore();
    const repository = auditStore.registerLocal("Model override repository", "D:/test-repo");
    const server = createApiServer({
      jobs,
      auditStore,
      localReview: async input => {
        const job = jobs.enqueue({
          kind: "pull_request",
          repository: "test-repo",
          repoPath: input.repoPath,
          accessMode: "local_git",
          publicationPolicy: "disabled",
          baseSha: "base123",
          headSha: "head123",
          llmProvider: input.llmProvider,
          llmModel: input.llmModel,
          action: "local_trigger"
        });
        return { jobId: job.id };
      },
      resolveReviewModel: override => {
        if ((override as any)?.provider === "mock") {
          throw new ApiError("Unsupported provider: mock", "INVALID_REVIEW_MODEL", 400);
        }
        if (override?.provider === "openai") {
          return { provider: "openai", model: override.model ?? override.name ?? "gpt-4.1-mini" };
        }
        if (override?.provider === "deepseek") {
          return { provider: "deepseek", model: override.model ?? override.name ?? "deepseek-v4-flash" };
        }
        return { provider: "deepseek", model: "deepseek-v4-flash" };
      }
    });
    servers.push(server);
    const port = await listen(server);

    const overrideRes = await fetch(`http://127.0.0.1:${port}/reviews/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: repository.id,
        model: { provider: "openai", model: "gpt-4.1-mini" }
      })
    });
    expect(overrideRes.status).toBe(202);
    const overrideBody = await overrideRes.json() as any;
    expect(overrideBody.llmProvider).toBe("openai");
    expect(overrideBody.llmModel).toBe("gpt-4.1-mini");

    const defaultRes = await fetch(`http://127.0.0.1:${port}/reviews/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: repository.id })
    });
    expect(defaultRes.status).toBe(202);
    const defaultBody = await defaultRes.json() as any;
    expect(defaultBody.llmProvider).toBe("deepseek");
    expect(defaultBody.llmModel).toBe("deepseek-v4-flash");

    const mockRes = await fetch(`http://127.0.0.1:${port}/reviews/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: repository.id,
        model: { provider: "mock", model: "mock" }
      })
    });
    expect(mockRes.status).toBe(400);
  });

  it("admits local review via registered repositoryId resolving canonical path without exposing paths to renderer", async () => {
    const jobs = new InMemoryJobQueue();
    let invokedRepoPath: string | undefined;
    const auditStore = createAuditStore();
    const repository = auditStore.registerLocal("My Registered Repo", "D:/canonical/repo-path");
    const server = createApiServer({
      jobs,
      auditStore,
      localReview: async input => {
        invokedRepoPath = input.repoPath;
        const job = jobs.enqueue({
          kind: "pull_request",
          repository: "My Registered Repo",
          repoPath: input.repoPath,
          accessMode: "local_git",
          publicationPolicy: "disabled",
          baseSha: "base123",
          headSha: "head123",
          action: "local_trigger"
        });
        return { jobId: job.id };
      }
    });
    servers.push(server);
    const port = await listen(server);

    const res = await fetch(`http://127.0.0.1:${port}/reviews/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: repository.id,
        baseRef: "main",
        headRef: "v3-pr2"
      })
    });
    expect(res.status).toBe(202);
    const body = await res.json() as any;
    expect(body.jobId).toBeTruthy();
    expect(body.status).toBe("queued");
    expect(invokedRepoPath).toBe("D:/canonical/repo-path");

    const repoPathRejected = await fetch(`http://127.0.0.1:${port}/reviews/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: repository.id, repoPath: "D:/private/checkout" })
    });
    expect(repoPathRejected.status).toBe(400);
    expect(await repoPathRejected.json()).toMatchObject({
      error: { code: "INVALID_LOCAL_REVIEW_REQUEST" }
    });

    const unknownRes = await fetch(`http://127.0.0.1:${port}/reviews/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: "repo_unknown_999" })
    });
    expect(unknownRes.status).toBe(404);

    const emptyRes = await fetch(`http://127.0.0.1:${port}/reviews/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(emptyRes.status).toBe(400);
  });

  it("reports saved DeepSeek as pending restart while runtime remains unconfigured", async () => {
    const savedSettings: SettingsSnapshot = {
      llm: {
        provider: "deepseek",
        deepseekBaseUrl: "https://api.deepseek.com",
        deepseekModel: "deepseek-v4-flash",
        openaiModel: "gpt-4.1-mini",
        deepseekApiKeyConfigured: true,
        openaiApiKeyConfigured: false
      },
      github: {
        appId: "",
        privateKeyConfigured: false,
        webhookSecretConfigured: false,
        publicReadTokenConfigured: false
      },
      runtime: {
        databasePath: ":memory:",
        workspaceRoot: "workspaces",
        localReviewRoots: "",
        workerConcurrency: 1,
        workerPollIntervalMs: 1_000,
        webUrl: "http://127.0.0.1:5173",
        apiTokenConfigured: false
      },
      overriddenByEnvironment: [],
      restartRequired: true
    };
    const auditStore = createAuditStore();
    const repository = auditStore.registerRemote("Pending restart repository", "acme/pending-restart");
    const server = createApiServer({
      auditStore,
      settings: { get: () => savedSettings, update: () => savedSettings },
      healthDetails: () => ({
        database: { ok: true },
        worker: { running: true, activeJobs: 0, concurrency: 1 },
        llmConfigured: false,
        llmProvider: "none",
        llmCapabilities: {
          deepseek: { configured: false, defaultModel: "deepseek-v4-flash" },
          openai: { configured: false, defaultModel: "gpt-4.1-mini" }
        },
        configuration: {
          githubAppConfigured: false,
          webhookSecretConfigured: false,
          publicReadTokenConfigured: false,
          storage: { kind: "memory", configured: true },
          workerConcurrency: 1
        }
      })
    });
    servers.push(server);
    const port = await listen(server);

    const response = await getJson(port, `/repositories/${repository.id}/review-preparation`);
    const preparation = reviewPreparationResponseSchema.parse(response.body);

    expect(response.status).toBe(200);
    expect(preparation.model.default).toEqual({ provider: "none", model: "" });
    expect(preparation.model.providers.deepseek.configured).toBe(false);
    expect(preparation.model.pendingRestart).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      credentialConfigured: true
    });
    expect(preparation.canStartReview).toBe(false);
    expect(preparation.blockingReasons).toContain("已保存 DeepSeek 配置，重启 API 后生效。");
  });

  it("continues to report the active provider from health rather than saved settings", async () => {
    const savedSettings: SettingsSnapshot = {
      llm: {
        provider: "openai",
        deepseekBaseUrl: "https://api.deepseek.com",
        deepseekModel: "deepseek-v4-flash",
        openaiModel: "gpt-4.1-mini",
        deepseekApiKeyConfigured: false,
        openaiApiKeyConfigured: true
      },
      github: {
        appId: "",
        privateKeyConfigured: false,
        webhookSecretConfigured: false,
        publicReadTokenConfigured: false
      },
      runtime: {
        databasePath: ":memory:",
        workspaceRoot: "workspaces",
        localReviewRoots: "",
        workerConcurrency: 1,
        workerPollIntervalMs: 1_000,
        webUrl: "http://127.0.0.1:5173",
        apiTokenConfigured: false
      },
      overriddenByEnvironment: [],
      restartRequired: false
    };
    const auditStore = createAuditStore();
    const repository = auditStore.registerRemote("Active provider repository", "acme/active-provider");
    const server = createApiServer({
      auditStore,
      settings: { get: () => savedSettings, update: () => savedSettings },
      healthDetails: () => ({
        database: { ok: true },
        worker: { running: true, activeJobs: 0, concurrency: 1 },
        llmConfigured: true,
        llmProvider: "deepseek",
        llmModel: "deepseek-v4-flash",
        llmCapabilities: {
          deepseek: { configured: true, defaultModel: "deepseek-v4-flash" },
          openai: { configured: false, defaultModel: "gpt-4.1-mini" }
        },
        configuration: {
          githubAppConfigured: false,
          webhookSecretConfigured: false,
          publicReadTokenConfigured: false,
          storage: { kind: "memory", configured: true },
          workerConcurrency: 1
        }
      })
    });
    servers.push(server);
    const port = await listen(server);

    const response = await getJson(port, `/repositories/${repository.id}/review-preparation`);
    const preparation = reviewPreparationResponseSchema.parse(response.body);

    expect(response.status).toBe(200);
    expect(preparation.model.default).toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
    expect(preparation.model.providers).toEqual({
      deepseek: { configured: true, defaultModel: "deepseek-v4-flash" },
      openai: { configured: false, defaultModel: "gpt-4.1-mini" }
    });
    expect(preparation.model.pendingRestart).toBeNull();
  });

  it("handles set-monitoring as POST, updates monitoring status, and handles invalid inputs", async () => {
    const auditStore = createAuditStore();
    const repository = auditStore.registerLocal("Monitored Repo", "D:/workspace/repo");
    let changedCount = 0;
    const server = createApiServer({
      auditStore,
      onAuditRepositoriesChanged: async () => {
        changedCount++;
      }
    });
    servers.push(server);
    const port = await listen(server);

    // 1. Success case: POST with valid boolean payload
    const postRes = await postJson(port, `/repositories/${repository.id}/actions/set-monitoring`, { enabled: true });
    expect(postRes.status).toBe(200);
    expect(postRes.body).toMatchObject({
      repository: {
        id: repository.id,
        monitoringEnabled: true
      }
    });
    expect(changedCount).toBe(1);

    // 2. Reject GET on set-monitoring endpoint
    const getRes = await getJson(port, `/repositories/${repository.id}/actions/set-monitoring`);
    expect(getRes.status).toBe(404);

    // 3. Reject invalid body (not boolean)
    const invalidBodyRes = await postJson(port, `/repositories/${repository.id}/actions/set-monitoring`, { enabled: "true" as any });
    expect(invalidBodyRes.status).toBe(400);

    // 4. Reject extra properties (strict)
    const extraPropRes = await postJson(port, `/repositories/${repository.id}/actions/set-monitoring`, { enabled: false, extra: 123 });
    expect(extraPropRes.status).toBe(400);

    // 5. Unknown repository ID
    const unknownRepoRes = await postJson(port, `/repositories/repo_nonexistent/actions/set-monitoring`, { enabled: true });
    expect(unknownRepoRes.status).toBe(404);
  });
});
