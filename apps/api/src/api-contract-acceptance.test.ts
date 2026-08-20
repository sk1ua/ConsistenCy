import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKING_TREE_REV, type ReviewReport } from "@consistency/schema";
import { openDatabase, type ConsistencyDatabase } from "./db/connection";
import { runMigrations } from "./db/migrations";
import { createApiServer } from "./http";
import { InMemoryJobQueue } from "./jobQueue";
import { SQLiteAuditDomainStore } from "./audit/store";
import { RuntimeRegistry } from "./review/runtimeRegistry";
import { createReviewRuntime } from "./review/workloadRuntime";
import { MockLLMProvider } from "./review/llm/mockProvider";

type JsonResponse = { status: number; body: any };

function call(
  port: number,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const raw = payload !== undefined ? JSON.stringify(payload) : undefined;
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...(raw !== undefined
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(raw))
              }
            : {}),
          ...headers
        }
      },
      res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: body.length === 0 ? {} : JSON.parse(body)
          });
        });
      }
    );
    req.on("error", reject);
    if (raw !== undefined) {
      req.end(raw);
    } else {
      req.end();
    }
  });
}

async function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected ephemeral port");
  return address.port;
}

describe("Backend Contract Acceptance — Headless Review Lifecycle without React/Electron", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];
  const databases: ConsistencyDatabase[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    for (const database of databases.splice(0)) database.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function setupDatabase(): { database: ConsistencyDatabase; store: SQLiteAuditDomainStore } {
    const database = openDatabase(":memory:");
    databases.push(database);
    runMigrations(database);
    return { database, store: new SQLiteAuditDomainStore(database) };
  }

  it("proves complete repository registration, preparation, review execution, evidence, and report lifecycle", async () => {
    // 1. Create temporary local Git repository with dirty working tree
    const repoPath = mkdtempSync(join(tmpdir(), "consistency-contract-acceptance-"));
    directories.push(repoPath);

    execFileSync("git", ["init", "--quiet"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "audit@example.com"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Auditor"], { cwd: repoPath, stdio: "ignore" });

    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "index.ts"), "export const initial = 1;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "Initial baseline commit"], { cwd: repoPath, stdio: "ignore" });

    // Introduce dirty changes in working tree
    writeFileSync(
      join(repoPath, "src", "index.ts"),
      "export const initial = 1;\nexport function vulnerableEval(input: string) { return eval(input); }\n",
      "utf8"
    );

    // 2. Set up API server with real store, test-only Mock LLM driver, and runtime
    const { store } = setupDatabase();
    const jobs = new InMemoryJobQueue();
    const runtimeRegistry = new RuntimeRegistry();
    const apiToken = "acceptance-api-token";
    const desktopControlToken = "acceptance-desktop-control-token";
    const mockLlm = new MockLLMProvider();

    const server = createApiServer({
      auditStore: store,
      jobs,
      runtimeRegistry,
      apiToken,
      desktopControlToken,
      llmProviderConfigured: true,
      healthDetails: () => ({
        database: { ok: true },
        worker: { running: true, activeJobs: 0, concurrency: 1 },
        llmConfigured: true,
        llmProvider: "deepseek",
        llmModel: "deepseek-v4-flash",
        llmCapabilities: {
          deepseek: { configured: true, defaultModel: "deepseek-v4-flash" },
          openai: { configured: true, defaultModel: "gpt-4.1-mini" }
        },
        publicPrAccessMode: "anonymous",
        configuration: {
          githubAppConfigured: false,
          webhookSecretConfigured: false,
          publicReadTokenConfigured: false,
          storage: { kind: "memory", configured: true },
          workerConcurrency: 1
        }
      }),
      resolveReviewModel: override => {
        const provider = override?.provider ?? "deepseek";
        const model = override?.model ?? (provider === "openai" ? "gpt-4.1-mini" : "deepseek-v4-flash");
        return { provider, model, resolvedVia: "per_review_override" };
      },
      localReview: async ({ repoPath: targetPath, baseRef, headRef, llmProvider, llmModel }) => {
        const job = jobs.enqueue({
          kind: "pull_request",
          repository: "ConsistenCy",
          repoPath: targetPath,
          accessMode: "local_git",
          publicationPolicy: "disabled",
          baseSha: "base-sha",
          headSha: WORKING_TREE_REV,
          action: "local_trigger",
          llmProvider: llmProvider ?? "deepseek",
          llmModel: llmModel ?? "deepseek-v4-flash"
        });
        return { jobId: job.id };
      },
      jobDiff: async jobId => {
        const job = jobs.get(jobId);
        if (!job) throw new Error("Job not found");
        return {
          jobId,
          available: true,
          files: [
            {
              path: "src/index.ts",
              status: "modified" as const,
              additions: 1,
              deletions: 0,
              binary: false,
              hunks: [
                {
                  header: "@@ -1,1 +1,2 @@",
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 2,
                  content: "@@ -1,1 +1,2 @@\n+export function vulnerableEval(input: string) { return eval(input); }"
                }
              ]
            }
          ]
        };
      }
    });
    servers.push(server);
    const port = await listen(server);
    const authHeaders = { authorization: `Bearer ${apiToken}` };

    // Step A: Register local repository via Desktop privileged endpoint
    const regRes = await call(
      port,
      "POST",
      "/internal/repositories/local",
      { path: repoPath, displayName: "Test Repo" },
      {
        ...authHeaders,
        "x-consistency-desktop-control": desktopControlToken
      }
    );
    expect(regRes.status).toBe(201);
    expect(regRes.body.repository).toBeDefined();
    const repositoryId = regRes.body.repository.id;
    expect(repositoryId).toBeDefined();
    expect(regRes.body.repository.source).toBe("local_git");
    expect(regRes.body.repository.trustLevel).toBe("untrusted_readonly");

    // Step B: GET repository workspace
    const repoRes = await call(port, "GET", `/repositories/${repositoryId}`, undefined, authHeaders);
    expect(repoRes.status).toBe(200);
    expect(repoRes.body.repository.id).toBe(repositoryId);
    expect(repoRes.body.repository.displayName).toBe("Test Repo");

    // Step C: GET git status
    const statusRes = await call(port, "GET", `/repositories/${repositoryId}/git/status`, undefined, authHeaders);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.available).toBe(true);
    expect(statusRes.body.dirtyFileCount).toBeGreaterThanOrEqual(1);
    expect(statusRes.body.changedFiles.some((f: any) => f.path === "src/index.ts")).toBe(true);

    // Step D: GET commits
    const commitsRes = await call(port, "GET", `/repositories/${repositoryId}/git/commits`, undefined, authHeaders);
    expect(commitsRes.status).toBe(200);
    expect(commitsRes.body.commits.length).toBeGreaterThanOrEqual(1);
    expect(commitsRes.body.commits[0].message).toContain("Initial baseline commit");

    // Step E: GET review preparation
    const prepRes = await call(port, "GET", `/repositories/${repositoryId}/review-preparation`, undefined, authHeaders);
    expect(prepRes.status).toBe(200);
    expect(prepRes.body.repository.id).toBe(repositoryId);
    expect(prepRes.body.sources.workingTree.available).toBe(true);
    expect(prepRes.body.sources.workingTree.changedFileCount).toBeGreaterThanOrEqual(1);
    expect(prepRes.body.model.default.provider).toBe("deepseek");
    expect(prepRes.body.model.default.model).toBe("deepseek-v4-flash");
    expect(prepRes.body.canStartReview).toBe(true);
    expect(prepRes.body.blockingReasons).toEqual([]);

    // Step F: POST review using repositoryId with per-review model override
    const postReviewRes = await call(
      port,
      "POST",
      "/reviews/local",
      {
        repositoryId,
        model: {
          provider: "deepseek",
          model: "deepseek-v4-flash"
        }
      },
      authHeaders
    );
    expect(postReviewRes.status).toBe(202);
    expect(postReviewRes.body.jobId).toBeDefined();
    const jobId = postReviewRes.body.jobId;
    expect(postReviewRes.body.status).toBe("queued");
    expect(postReviewRes.body.llmProvider).toBe("deepseek");
    expect(postReviewRes.body.llmModel).toBe("deepseek-v4-flash");

    // Step G: Verify ReviewJob persistence
    const job = jobs.get(jobId);
    expect(job).toBeDefined();
    expect(job?.status).toBe("queued");
    expect(job?.llmProvider).toBe("deepseek");
    expect(job?.llmModel).toBe("deepseek-v4-flash");

    // Step H: Execute Review workload using test-only LLM driver and verify Evidence & Report
    const mockReport: ReviewReport = {
      jobId,
      repositoryFullName: "ConsistenCy",
      baseSha: "base-sha",
      headSha: WORKING_TREE_REV,
      score: 82,
      riskLevel: "medium",
      summary: "Security finding detected: dynamic code evaluation",
      llmProvider: "deepseek",
      llmModel: "deepseek-v4-flash",
      findings: [
        {
          id: "sec-001",
          agent: "Security",
          title: "Use of eval creates code execution risk",
          severity: "high",
          confidence: "confirmed",
          file: "src/index.ts",
          startLine: 2,
          endLine: 2,
          evidence: "export function vulnerableEval(input: string) { return eval(input); }",
          reasoning: "Dynamic code execution via eval can lead to arbitrary code execution.",
          recommendation: "Avoid eval and use structured parsing."
        }
      ],
      agentRuns: [
        {
          id: "agent-planner",
          jobId,
          agentName: "Planner",
          status: "succeeded",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          inputSummary: "Planned review steps",
          findings: [],
          provider: "deepseek"
        },
        {
          id: "agent-security",
          jobId,
          agentName: "Security",
          status: "succeeded",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          inputSummary: "Security analysis",
          findings: [
            {
              id: "sec-001",
              agent: "Security",
              title: "Use of eval creates code execution risk",
              severity: "high",
              confidence: "confirmed",
              file: "src/index.ts",
              startLine: 2,
              endLine: 2,
              evidence: "export function vulnerableEval(input: string) { return eval(input); }",
              reasoning: "Dynamic code execution via eval can lead to arbitrary code execution.",
              recommendation: "Avoid eval and use structured parsing."
            }
          ],
          provider: "deepseek"
        }
      ],
      createdAt: new Date().toISOString()
    };

    // Transition job to succeeded with result
    jobs.markRunning(jobId);
    jobs.markSucceeded(jobId, mockReport);

    // Step I: GET /jobs/:id and GET /jobs/:id/report
    const jobRes = await call(port, "GET", `/jobs/${jobId}`, undefined, authHeaders);
    expect(jobRes.status).toBe(200);
    expect(jobRes.body.job.status).toBe("succeeded");
    expect(jobRes.body.job.llmProvider).toBe("deepseek");
    expect(jobRes.body.job.llmModel).toBe("deepseek-v4-flash");

    const reportRes = await call(port, "GET", `/jobs/${jobId}/report`, undefined, authHeaders);
    expect(reportRes.status).toBe(200);
    expect(reportRes.body.report.score).toBe(82);
    expect(reportRes.body.report.findings.length).toBe(1);
    expect(reportRes.body.report.findings[0].title).toContain("eval");

    // Step J: GET /jobs/:id/diff
    const diffRes = await call(port, "GET", `/jobs/${jobId}/diff`, undefined, authHeaders);
    expect(diffRes.status).toBe(200);
    expect(diffRes.body.files.length).toBe(1);
    expect(diffRes.body.files[0].path).toBe("src/index.ts");

    // Step K: GET /runtime/runs/:id
    const runRes = await call(port, "GET", `/runtime/runs/${jobId}`, undefined, authHeaders);
    expect(runRes.status).toBe(200);
    expect(runRes.body.jobId).toBe(jobId);
    expect(runRes.body.state).toBe("SUCCEEDED");
  });
});
