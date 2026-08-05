import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ZodError } from "zod";
import { localReviewRequestSchema, notebookCardRequestSchema, notebookMessageRequestSchema, publicPrRequestSchema, saveWorkflowRequestSchema } from "@consistency/schema";
import type { HeartbeatPulse, HeartbeatStreamEvent, VcsChangedFile } from "@consistency/schema";
import { filterJobs, buildStats, recentReports, toApiJob } from "./api/jobView";
import { seedDemoData } from "./api/demoSeed";
import { buildHealthPayload } from "./health";
import { processGitHubWebhook, WebhookError } from "./trigger/webhook";
import { LocalTriggerError } from "./trigger/local";
import { InMemoryJobQueue, type ReviewJobStore } from "./jobQueue";
import { sanitizePublicError } from "./security/redact";
import { settingsPatchSchema, type SettingsSnapshot } from "./config/settings";
import type { RealDataSnapshot } from "./data/realData";
import { PublicPrError } from "./review/publicPr";
import type { NotebookGraph } from "./notebook/graph";
import type { NotebookStore } from "./notebook/store";
import type { ReviewJob } from "./jobQueue";
import type { WorkflowStore } from "./workflows/store";
import { JobDiffError, type JobDiffResult } from "./review/jobDiff";

const MAX_BODY_BYTES = 1024 * 1024;

class ApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly statusCode: number, public readonly details?: Record<string, unknown>) {
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
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    ...(origin && allowedOrigins.includes(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
    "content-type": "application/json; charset=utf-8"
  };
}

function sendJson(request: IncomingMessage, response: ServerResponse, statusCode: number, payload: unknown, allowedOrigins: string[]): void {
  response.writeHead(statusCode, responseHeaders(request, allowedOrigins));
  response.end(statusCode === 204 ? undefined : JSON.stringify(payload));
}

function startSse(request: IncomingMessage, response: ServerResponse, allowedOrigins: string[]): void {
  const headers = responseHeaders(request, allowedOrigins);
  response.writeHead(200, {
    ...headers,
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no"
  });
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
  if (response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function errorPayload(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function sendError(request: IncomingMessage, response: ServerResponse, error: unknown, allowedOrigins: string[]): void {
  if (error instanceof ZodError) {
    sendJson(request, response, 400, errorPayload("INVALID_SETTINGS", error.issues[0]?.message ?? "Settings are invalid"), allowedOrigins);
    return;
  }
  if (error instanceof ApiError || error instanceof WebhookError) {
    sendJson(request, response, error.statusCode, errorPayload(error.code, sanitizePublicError(error.message), error instanceof ApiError ? error.details : undefined), allowedOrigins);
    return;
  }
  if (error instanceof PublicPrError) {
    sendJson(request, response, error.statusCode, errorPayload(error.code, sanitizePublicError(error.message), error.details), allowedOrigins);
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
  llmModel?: string;
  publicPrAnalysis?: boolean;
  publicPrAccessMode?: "anonymous" | "pat" | "disabled";
  notebook?: boolean;
  configuration: {
    githubAppConfigured: boolean;
    webhookSecretConfigured: boolean;
    publicReadTokenConfigured: boolean;
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
  publicPr?: (url: string) => Promise<{ coordinates: { repository: string; pullRequestNumber: number; owner: string; repo: string }; job: ReviewJob }>;
  publicPrAnalysisEnabled?: boolean;
  localReview?: (input: { repoPath: string; baseRef?: string; headRef?: string }) => Promise<{ jobId: string }>;
  heartbeat?: {
    latest: () => HeartbeatPulse | undefined;
    subscribe: (subscriber: (event: HeartbeatStreamEvent) => void) => () => void;
  };
  workflows?: WorkflowStore;
  jobDiff?: (jobId: string) => Promise<JobDiffResult>;
  notebookEnabled?: boolean;
  notebookStore?: NotebookStore;
  notebookGraph?: NotebookGraph;
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
    path: "/reviews/public-pr",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, nodeEnv }) => {
      if (options.publicPrAnalysisEnabled === false || (nodeEnv === "production" && options.publicPrAnalysisEnabled !== true)) {
        throw new ApiError("Public PR analysis is disabled", "PUBLIC_PR_ANALYSIS_DISABLED", 404);
      }
      if (!options.publicPr || !options.notebookStore) {
        throw new ApiError("Public PR analysis requires a configured public GitHub read source", "PUBLIC_PR_ANALYSIS_UNAVAILABLE", 503);
      }
      let body;
      try {
        body = publicPrRequestSchema.parse(await readJson(request));
      } catch (error) {
        if (error instanceof ZodError) throw new ApiError("A GitHub pull request URL is required", "INVALID_PUBLIC_PR_REQUEST", 400);
        throw error;
      }
      const result = await options.publicPr(body.url);
      const ensured = options.notebookStore.ensureForJob(result.job);
      sendJson(request, response, 202, {
        jobId: result.job.id,
        notebookId: ensured.notebook.id,
        repository: result.coordinates.repository,
        pullRequestNumber: result.coordinates.pullRequestNumber,
        baseSha: result.job.baseSha,
        headSha: result.job.headSha,
        publicationPolicy: "disabled",
        status: "queued"
      }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/heartbeat",
    auth: true,
    handler: ({ request, response, allowedOrigins, options }) => {
      if (!options.heartbeat) throw new ApiError("Heartbeat is disabled", "HEARTBEAT_DISABLED", 404);
      const pulse = options.heartbeat.latest();
      sendJson(request, response, 200, { pulse: pulse ?? null }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/heartbeat/stream",
    auth: true,
    handler: ({ request, response, allowedOrigins, options }) => {
      if (!options.heartbeat) throw new ApiError("Heartbeat is disabled", "HEARTBEAT_DISABLED", 404);

      startSse(request, response, allowedOrigins);
      // writeHead alone does not put bytes on the wire, so a client would hang
      // without response headers until the first pulse — up to a full interval.
      response.flushHeaders?.();
      response.write(": connected\n\n");

      const unsubscribe = options.heartbeat.subscribe(event => {
        writeSse(response, event.event, event);
      });

      // The stream stays open until the client disconnects; without this the
      // daemon would accumulate a subscriber per dropped connection. A single
      // disconnect fires several of these events, so unsubscribing is latched
      // — callers must not see a second release for one subscription.
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (!response.writableEnded) response.end();
      };
      request.on("close", close);
      request.on("error", close);
      response.on("error", close);
    }
  },
  {
    method: "POST",
    path: "/reviews/local",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, jobs }) => {
      if (!options.localReview) {
        throw new ApiError("Local review is not configured", "LOCAL_REVIEW_UNAVAILABLE", 503);
      }
      let body;
      try {
        body = localReviewRequestSchema.parse(await readJson(request));
      } catch (error) {
        if (error instanceof ZodError) {
          throw new ApiError("A repository path is required", "INVALID_LOCAL_REVIEW_REQUEST", 400);
        }
        throw error;
      }

      let result: { jobId: string };
      try {
        result = await options.localReview(body);
      } catch (error) {
        if (error instanceof LocalTriggerError) {
          const status = error.code === "PATH_NOT_ALLOWED"
            ? 403
            : error.code === "NOTHING_TO_REVIEW" ? 409 : 400;
          throw new ApiError(error.message, error.code, status);
        }
        throw error;
      }

      const job = jobs.get(result.jobId);
      if (!job) throw new ApiError("Local review job was not persisted", "LOCAL_REVIEW_UNAVAILABLE", 500);
      sendJson(request, response, 202, {
        jobId: job.id,
        repository: job.repository,
        repoPath: job.repoPath,
        baseSha: job.baseSha,
        headSha: job.headSha,
        publicationPolicy: "disabled",
        status: "queued"
      }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/workflows",
    auth: true,
    handler: ({ request, response, allowedOrigins, options }) => {
      if (!options.workflows) throw new ApiError("Workflows are not configured", "WORKFLOWS_UNAVAILABLE", 503);
      sendJson(request, response, 200, { workflows: options.workflows.list() }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/workflows\/([^/]+)$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, match, options }) => {
      if (!options.workflows) throw new ApiError("Workflows are not configured", "WORKFLOWS_UNAVAILABLE", 503);
      const name = decodeURIComponent(match?.[1] ?? "");
      const found = options.workflows.get(name);
      if (!found) throw new ApiError("Workflow not found", "WORKFLOW_NOT_FOUND", 404);
      sendJson(request, response, 200, { workflow: found.spec, source: found.source }, allowedOrigins);
    }
  },
  {
    method: "PUT",
    path: /^\/workflows\/([^/]+)$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, match, options }) => {
      if (!options.workflows) throw new ApiError("Workflows are not configured", "WORKFLOWS_UNAVAILABLE", 503);
      const name = decodeURIComponent(match?.[1] ?? "");
      const body = await readJson(request);
      const parsed = saveWorkflowRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError("Workflow is invalid", "INVALID_WORKFLOW", 400, {
          issues: parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message }))
        });
      }
      if (parsed.data.name !== name) {
        throw new ApiError("Workflow name in the body must match the route", "WORKFLOW_NAME_MISMATCH", 400);
      }
      try {
        options.workflows.saveDraft(parsed.data);
      } catch (error) {
        throw new ApiError(error instanceof Error ? error.message : "Workflow draft could not be saved", "WORKFLOW_SAVE_FAILED", 400);
      }
      sendJson(request, response, 200, { workflow: parsed.data, source: "draft" }, allowedOrigins);
    }
  },
  {
    method: "DELETE",
    path: /^\/workflows\/([^/]+)$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, match, options }) => {
      if (!options.workflows) throw new ApiError("Workflows are not configured", "WORKFLOWS_UNAVAILABLE", 503);
      const name = decodeURIComponent(match?.[1] ?? "");
      if (options.workflows.isBuiltin(name)) {
        throw new ApiError("Builtin workflows cannot be deleted", "BUILTIN_WORKFLOW_PROTECTED", 409);
      }
      if (!options.workflows.deleteDraft(name)) {
        throw new ApiError("Workflow draft not found", "WORKFLOW_DRAFT_NOT_FOUND", 404);
      }
      sendJson(request, response, 204, undefined, allowedOrigins);
    }
  },
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
    path: /^\/notebooks\/([^/]+)\/sources$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, match, options }) => {
      if (options.notebookEnabled === false || !options.notebookStore) throw new ApiError("Notebook is disabled", "NOTEBOOK_DISABLED", 404);
      const id = decodeURIComponent(match?.[1] ?? "");
      const notebook = options.notebookStore.get(id);
      if (!notebook) throw new ApiError("Notebook not found", "NOTEBOOK_NOT_FOUND", 404);
      sendJson(request, response, 200, { sources: notebook.sources }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/jobs\/([^/]+)\/diff$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, match, options }) => {
      if (!options.jobDiff) throw new ApiError("Diff is not configured", "DIFF_UNAVAILABLE", 503);
      const jobId = decodeURIComponent(match?.[1] ?? "");
      try {
        const result = await options.jobDiff(jobId);
        sendJson(request, response, 200, { jobId, files: result.files, available: result.available }, allowedOrigins);
      } catch (error) {
        if (error instanceof JobDiffError) {
          throw new ApiError(error.message, error.code, error.statusCode);
        }
        throw error;
      }
    }
  },
  {
    method: "GET",
    path: /^\/notebooks\/([^/]+)$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, match, options }) => {
      if (options.notebookEnabled === false || !options.notebookStore) throw new ApiError("Notebook is disabled", "NOTEBOOK_DISABLED", 404);
      const id = decodeURIComponent(match?.[1] ?? "");
      const notebook = options.notebookStore.get(id);
      if (!notebook) throw new ApiError("Notebook not found", "NOTEBOOK_NOT_FOUND", 404);
      sendJson(request, response, 200, { notebook }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: /^\/notebooks\/([^/]+)\/messages$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, match, options }) => {
      if (options.notebookEnabled === false || !options.notebookStore || !options.notebookGraph) throw new ApiError("Notebook is disabled", "NOTEBOOK_DISABLED", 404);
      const notebookId = decodeURIComponent(match?.[1] ?? "");
      if (!options.notebookStore.get(notebookId)) throw new ApiError("Notebook not found", "NOTEBOOK_NOT_FOUND", 404);
      let body;
      try {
        body = notebookMessageRequestSchema.parse(await readJson(request));
      } catch (error) {
        if (error instanceof ZodError) throw new ApiError("Notebook message content is invalid", "INVALID_NOTEBOOK_MESSAGE", 400);
        throw error;
      }
      startSse(request, response, allowedOrigins);
      try {
        for await (const event of options.notebookGraph.streamMessage({ notebookId, content: body.content, sourceJobIds: body.sourceJobIds })) {
          writeSse(response, event.event, event.data);
        }
      } catch (error) {
        writeSse(response, "run.failed", { error: sanitizePublicError(error instanceof Error ? error.message : "Notebook run failed") });
      } finally {
        response.end();
      }
    }
  },
  {
    method: "POST",
    path: /^\/notebooks\/([^/]+)\/cards$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, match, options }) => {
      if (options.notebookEnabled === false || !options.notebookStore || !options.notebookGraph) throw new ApiError("Notebook is disabled", "NOTEBOOK_DISABLED", 404);
      const notebookId = decodeURIComponent(match?.[1] ?? "");
      if (!options.notebookStore.get(notebookId)) throw new ApiError("Notebook not found", "NOTEBOOK_NOT_FOUND", 404);
      let body;
      try {
        body = notebookCardRequestSchema.parse(await readJson(request));
      } catch (error) {
        if (error instanceof ZodError) throw new ApiError("Notebook card request is invalid", "INVALID_NOTEBOOK_CARD", 400);
        throw error;
      }
      startSse(request, response, allowedOrigins);
      try {
        for await (const event of options.notebookGraph.streamCard({ notebookId, kind: body.kind, sourceJobIds: body.sourceJobIds })) {
          writeSse(response, event.event, event.data);
        }
      } catch (error) {
        writeSse(response, "card.failed", { error: sanitizePublicError(error instanceof Error ? error.message : "Notebook card failed") });
      } finally {
        response.end();
      }
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
          publicPrAccessMode: "disabled",
          configuration: {
            githubAppConfigured: false,
            webhookSecretConfigured: Boolean(githubWebhookSecret),
            publicReadTokenConfigured: false,
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
    handler: ({ request, response, allowedOrigins, nodeEnv, jobs, options }) => {
      if (nodeEnv === "production") throw new ApiError("Demo seed is disabled in production", "DEMO_DISABLED", 404);
      sendJson(request, response, 201, seedDemoData(jobs, options.notebookStore), allowedOrigins);
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
    path: /^\/jobs\/([^/]+)\/notebook$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, match, jobs, options }) => {
      const id = decodeURIComponent(match?.[1] ?? "");
      const job = jobs.get(id);
      if (!job) throw new ApiError("Job not found", "JOB_NOT_FOUND", 404);
      if (options.notebookEnabled === false || !options.notebookStore) {
        sendJson(request, response, 200, { notebookId: null }, allowedOrigins);
        return;
      }
      const notebook = options.notebookStore.findByJobId(id);
      sendJson(request, response, 200, { notebookId: notebook?.id ?? null }, allowedOrigins);
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
      console.error(`[api error] ${sanitizePublicError(error instanceof Error ? error.message : String(error))}`);
      if (nodeEnv === "development" && error instanceof Error) console.error(error.stack);
      sendError(request, response, error, allowedOrigins);
    }
  });
}
