import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ZodError } from "zod";
import { filterJobs, buildStats, recentReports, toApiJob } from "./api/jobView";
import { seedDemoData } from "./api/demoSeed";
import { buildHealthPayload } from "./health";
import { processGitHubWebhook, WebhookError } from "./trigger/webhook";
import { InMemoryJobQueue, type ReviewJobStore } from "./jobQueue";
import { sanitizePublicError } from "./security/redact";
import { settingsPatchSchema, type SettingsSnapshot } from "./config/settings";
import type { RealDataSnapshot } from "./data/realData";

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
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
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
  if (error instanceof ZodError) {
    sendJson(request, response, 400, errorPayload("INVALID_SETTINGS", error.issues[0]?.message ?? "Settings are invalid"), allowedOrigins);
    return;
  }
  if (error instanceof ApiError || error instanceof WebhookError) {
    sendJson(request, response, error.statusCode, errorPayload(error.code, sanitizePublicError(error.message)), allowedOrigins);
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

export type CreateApiServerOptions = {
  runProcess?: any;
  jobs?: ReviewJobStore;
  githubWebhookSecret?: string;
  apiToken?: string;
  nodeEnv?: "development" | "test" | "production";
  allowedOrigins?: string[];
  healthDetails?: () => ApiHealthDetails;
  workspaceRoot?: string;
  settings?: {
    get: () => SettingsSnapshot;
    update: (patch: unknown) => SettingsSnapshot;
  };
  realData?: () => RealDataSnapshot | undefined;
};

type RequestContext = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  path: string;
  allowedOrigins: string[];
  options: CreateApiServerOptions;
  jobs: ReviewJobStore;
  githubWebhookSecret?: string;
  apiToken?: string;
  nodeEnv: "development" | "test" | "production";
  match?: RegExpExecArray | null;
};

type Route = {
  method: string;
  path: string | RegExp;
  handler: (ctx: RequestContext) => Promise<void> | void;
  auth?: boolean;
};

const routes: Route[] = [
  {
    method: "POST",
    path: "/github/webhook",
    auth: false,
    handler: async ({ request, response, allowedOrigins, githubWebhookSecret, jobs }) => {
      if (!githubWebhookSecret) throw new WebhookError("GitHub webhook is not configured", "WEBHOOK_NOT_CONFIGURED", 503);
      const result = processGitHubWebhook({
        headers: request.headers,
        body: await readBody(request),
        secret: githubWebhookSecret,
        jobs
      });
      sendJson(request, response, result.status === "enqueued" ? 202 : 200, result, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/health",
    auth: true,
    handler: ({ request, response, allowedOrigins, options, githubWebhookSecret }) => {
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
    }
  },
  {
    method: "GET",
    path: "/settings",
    auth: true,
    handler: ({ request, response, allowedOrigins, options }) => {
      if (!options.settings) throw new ApiError("Settings service is unavailable", "SETTINGS_UNAVAILABLE", 404);
      sendJson(request, response, 200, { settings: options.settings.get() }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/real-data",
    auth: true,
    handler: ({ request, response, allowedOrigins, options }) => {
      sendJson(request, response, 200, { realData: options.realData?.() ?? null }, allowedOrigins);
    }
  },
  {
    method: "PUT",
    path: "/settings",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, nodeEnv }) => {
      if (!options.settings || nodeEnv === "production") {
        throw new ApiError("Settings updates are disabled", "SETTINGS_READ_ONLY", 404);
      }
      const patch = settingsPatchSchema.parse(await readJson(request));
      sendJson(request, response, 200, { settings: options.settings.update(patch) }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/jobs",
    auth: true,
    handler: ({ request, response, allowedOrigins, url, jobs }) => {
      sendJson(request, response, 200, { jobs: filterJobs(jobs.list(), url.searchParams).map(toApiJob) }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/reports/recent",
    auth: true,
    handler: ({ request, response, allowedOrigins, url, jobs }) => {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 10) || 10));
      sendJson(request, response, 200, { reports: recentReports(jobs.list(), limit) }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/stats",
    auth: true,
    handler: ({ request, response, allowedOrigins, jobs }) => {
      sendJson(request, response, 200, buildStats(jobs.list()), allowedOrigins);
    }
  },
  {
    method: "POST",
    path: "/demo/seed",
    auth: true,
    handler: ({ request, response, allowedOrigins, nodeEnv, jobs }) => {
      if (nodeEnv === "production") throw new ApiError("Demo seed is disabled in production", "DEMO_DISABLED", 404);
      sendJson(request, response, 201, seedDemoData(jobs), allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/jobs\/([^/]+)\/report$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, match, jobs }) => {
      const id = decodeURIComponent(match?.[1] ?? "");
      const job = jobs.get(id);
      if (!job) throw new ApiError("Job not found", "JOB_NOT_FOUND", 404);
      if (!job.result) throw new ApiError("Job report is not ready", "JOB_NOT_READY", 409);
      sendJson(request, response, 200, { report: job.result }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/jobs\/([^/]+)$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, match, jobs }) => {
      const id = decodeURIComponent(match?.[1] ?? "");
      const job = jobs.get(id);
      if (!job) throw new ApiError("Job not found", "JOB_NOT_FOUND", 404);
      sendJson(request, response, 200, { job: toApiJob(job) }, allowedOrigins);
    }
  }
];

export function createApiServer(options: CreateApiServerOptions = {}) {
  const jobs = options.jobs ?? new InMemoryJobQueue();
  const githubWebhookSecret = options.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
  const apiToken = options.apiToken ?? process.env.CONSISTENCY_API_TOKEN;
  const nodeEnv = options.nodeEnv ?? (process.env.NODE_ENV as "development" | "test" | "production" | undefined) ?? "development";
  const allowedOrigins = options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://localhost:5173"];

  return createServer(async (request, response) => {
    try {
      const contentLength = Number(request.headers["content-length"] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
        throw new ApiError("Request body exceeds 1 MB", "BODY_TOO_LARGE", 413);
      }
      const url = parseUrl(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") {
        sendJson(request, response, 204, {}, allowedOrigins);
        return;
      }

      let matchedRoute: Route | undefined;
      let routeMatch: RegExpExecArray | null = null;

      for (const route of routes) {
        if (route.method === request.method) {
          if (typeof route.path === "string") {
            if (route.path === path) {
              matchedRoute = route;
              break;
            }
          } else {
            const match = route.path.exec(path);
            if (match) {
              matchedRoute = route;
              routeMatch = match;
              break;
            }
          }
        }
      }

      if (!matchedRoute) {
        throw new ApiError("Not found", "NOT_FOUND", 404);
      }

      const requiresAuth = matchedRoute.auth !== false;
      if (requiresAuth && apiToken && !isAuthorized(request, apiToken)) {
        throw new ApiError("A valid bearer token is required", "UNAUTHORIZED", 401);
      }

      await matchedRoute.handler({
        request,
        response,
        url,
        path,
        allowedOrigins,
        options,
        jobs,
        githubWebhookSecret,
        apiToken,
        nodeEnv,
        match: routeMatch
      });

    } catch (error) {
      sendError(request, response, error, allowedOrigins);
    }
  });
}
