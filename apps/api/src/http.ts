import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { filterJobs, buildStats, recentReports, toApiJob } from "./api/jobView";
import { seedDemoData } from "./api/demoSeed";
import { buildHealthPayload } from "./health";
import { processGitHubWebhook, WebhookError } from "./githubWebhook";
import { InMemoryJobQueue, type ReviewJobStore } from "./jobQueue";
import { JobRunnerError, runNextReviewJob, runReviewJob } from "./jobRunner";
import { analyzeFileWithPython, parseAnalyzeFileRequest, PythonBridgeError, type RunProcess } from "./pythonBridge";

const MAX_BODY_BYTES = 1024 * 1024;

class ApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly statusCode: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ApiError("Request body exceeds 1 MB", "BODY_TOO_LARGE", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError("Request body must be valid JSON", "INVALID_JSON", 400);
  }
}

function responseHeaders(request: IncomingMessage, allowedOrigins: string[]): Record<string, string> {
  const origin = request.headers.origin;
  return {
    "access-control-allow-headers": "authorization,content-type,x-github-event,x-github-delivery,x-hub-signature-256",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    ...(origin && allowedOrigins.includes(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
    "content-type": "application/json; charset=utf-8"
  };
}

function sendJson(request: IncomingMessage, response: ServerResponse, statusCode: number, payload: unknown, allowedOrigins: string[]): void {
  response.writeHead(statusCode, responseHeaders(request, allowedOrigins));
  response.end(statusCode === 204 ? undefined : JSON.stringify(payload));
}

function errorPayload(code: string, message: string) {
  return { error: { code, message } };
}

function sendError(request: IncomingMessage, response: ServerResponse, error: unknown, allowedOrigins: string[]): void {
  if (error instanceof ApiError || error instanceof JobRunnerError || error instanceof WebhookError) {
    sendJson(request, response, error.statusCode, errorPayload(error.code, error.message), allowedOrigins);
    return;
  }
  if (error instanceof PythonBridgeError) {
    sendJson(request, response, error.code.startsWith("INVALID_") ? 400 : 502, errorPayload(error.code, error.message), allowedOrigins);
    return;
  }
  sendJson(request, response, 500, errorPayload("INTERNAL_ERROR", "Unexpected API error"), allowedOrigins);
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers.authorization;
  const expected = `Bearer ${token}`;
  if (!supplied || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function parseUrl(url: string | undefined): URL {
  return new URL(url ?? "/", "http://localhost");
}

export type ApiHealthDetails = {
  database: { ok: boolean };
  worker: { running: boolean; activeJobs: number; concurrency: number; lastPollAt?: string };
  llmProvider: string;
  configuration: {
    githubAppConfigured: boolean;
    webhookSecretConfigured: boolean;
    databasePath: string;
    workerConcurrency: number;
    demoMode: boolean;
  };
};

export function createApiServer(options: {
  runProcess?: RunProcess;
  jobs?: ReviewJobStore;
  githubWebhookSecret?: string;
  apiToken?: string;
  nodeEnv?: "development" | "test" | "production";
  allowedOrigins?: string[];
  healthDetails?: () => ApiHealthDetails;
} = {}) {
  const jobs = options.jobs ?? new InMemoryJobQueue();
  const githubWebhookSecret = options.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
  const apiToken = options.apiToken ?? process.env.CONSISTENCY_API_TOKEN;
  const nodeEnv = options.nodeEnv ?? (process.env.NODE_ENV as "development" | "test" | "production" | undefined) ?? "development";
  const allowedOrigins = options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://localhost:5173"];

  return createServer(async (request, response) => {
    try {
      const url = parseUrl(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") {
        sendJson(request, response, 204, {}, allowedOrigins);
        return;
      }

      if (request.method === "GET" && path === "/health") {
        sendJson(request, response, 200, {
          ...buildHealthPayload(),
          ...(options.healthDetails?.() ?? {
            database: { ok: true },
            worker: { running: false, activeJobs: 0, concurrency: 1 },
            llmProvider: "mock",
            configuration: {
              githubAppConfigured: false,
              webhookSecretConfigured: Boolean(githubWebhookSecret),
              databasePath: ":memory:",
              workerConcurrency: 1,
              demoMode: true
            }
          })
        }, allowedOrigins);
        return;
      }

      if (request.method === "POST" && path === "/github/webhook") {
        if (!githubWebhookSecret) throw new WebhookError("GitHub webhook is not configured", "WEBHOOK_NOT_CONFIGURED", 503);
        const result = processGitHubWebhook({
          headers: request.headers,
          body: await readBody(request),
          secret: githubWebhookSecret,
          jobs
        });
        sendJson(request, response, result.status === "enqueued" ? 202 : 200, result, allowedOrigins);
        return;
      }

      if (apiToken && !isAuthorized(request, apiToken)) {
        throw new ApiError("A valid bearer token is required", "UNAUTHORIZED", 401);
      }

      if (request.method === "GET" && path === "/jobs") {
        sendJson(request, response, 200, { jobs: filterJobs(jobs.list(), url.searchParams).map(toApiJob) }, allowedOrigins);
        return;
      }

      if (request.method === "GET" && path === "/reports/recent") {
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 10) || 10));
        sendJson(request, response, 200, { reports: recentReports(jobs.list(), limit) }, allowedOrigins);
        return;
      }

      if (request.method === "GET" && path === "/stats") {
        sendJson(request, response, 200, buildStats(jobs.list()), allowedOrigins);
        return;
      }

      if (request.method === "POST" && path === "/demo/seed") {
        if (nodeEnv === "production") throw new ApiError("Demo seed is disabled in production", "DEMO_DISABLED", 404);
        sendJson(request, response, 201, seedDemoData(jobs), allowedOrigins);
        return;
      }

      if (request.method === "POST" && path === "/analyze-file") {
        const report = await analyzeFileWithPython(parseAnalyzeFileRequest(await readJson(request)), {
          runProcess: options.runProcess
        });
        sendJson(request, response, 200, report, allowedOrigins);
        return;
      }

      if (request.method === "POST" && path === "/jobs/run-next") {
        const job = await runNextReviewJob(jobs, { runProcess: options.runProcess });
        if (!job) throw new ApiError("No queued jobs", "NO_QUEUED_JOBS", 404);
        sendJson(request, response, 200, { job: toApiJob(job) }, allowedOrigins);
        return;
      }

      if (request.method === "POST" && path.startsWith("/jobs/") && path.endsWith("/run")) {
        const id = decodeURIComponent(path.slice("/jobs/".length, -"/run".length));
        sendJson(request, response, 200, { job: toApiJob(await runReviewJob(jobs, id, { runProcess: options.runProcess })) }, allowedOrigins);
        return;
      }

      if (request.method === "GET" && path.startsWith("/jobs/") && path.endsWith("/report")) {
        const id = decodeURIComponent(path.slice("/jobs/".length, -"/report".length));
        const job = jobs.get(id);
        if (!job) throw new ApiError("Job not found", "JOB_NOT_FOUND", 404);
        if (job.status !== "succeeded" || !job.result) throw new ApiError("Job report is not ready", "JOB_NOT_READY", 409);
        sendJson(request, response, 200, { report: job.result }, allowedOrigins);
        return;
      }

      if (request.method === "GET" && path.startsWith("/jobs/")) {
        const job = jobs.get(decodeURIComponent(path.slice("/jobs/".length)));
        if (!job) throw new ApiError("Job not found", "JOB_NOT_FOUND", 404);
        sendJson(request, response, 200, { job: toApiJob(job) }, allowedOrigins);
        return;
      }

      throw new ApiError("Not found", "NOT_FOUND", 404);
    } catch (error) {
      sendError(request, response, error, allowedOrigins);
    }
  });
}
