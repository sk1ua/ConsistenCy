import { createHash, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z, ZodError } from "zod";
import {
  auditCapabilitiesSchema,
  auditIssueActionRequestSchema,
  auditIssueActionSchema,
  auditIssueStateSchema,
  createAuditIssueRequestSchema,
  createAuditRunRequestSchema,
  createAutomationRequestSchema,
  createPolicyRevisionRequestSchema,
  createRepositoryRequestSchema,
  createWorkflowRevisionRequestSchema,
  DEFAULT_SECURITY_GUARANTEES,
  evaluateAuditPolicy,
  internalLocalRepositoryRegistrationRequestSchema,
  localReviewRequestSchema,
  notebookCardRequestSchema,
  notebookMessageRequestSchema,
  publicPrRequestSchema,
  riskScoreSchema,
  saveWorkflowRequestSchema,
  stepIdSchema,
  workflowSpecSchema,
  type ReviewModelOverride
} from "@consistency/schema";
import type { HeartbeatPulse, HeartbeatStreamEvent, VcsChangedFile } from "@consistency/schema";
import { LocalGitAdapter, parseGitHubRemote } from "@consistency/vcs-core";
import { existsSync } from "node:fs";
import { ReviewModelResolutionError, type ResolvedReviewModel } from "./review/llm/factory";

function resolveLocalPathForRepository(repositoryId: string, options: CreateApiServerOptions): string | undefined {
  if (options.auditStore?.getLocalRepositoryPath) {
    const fromStore = options.auditStore.getLocalRepositoryPath(repositoryId);
    if (fromStore && existsSync(fromStore)) return fromStore;
  }
  const heartbeatPulse = options.heartbeat?.latest?.();
  if (heartbeatPulse?.repository.root && heartbeatPulse.repository.root !== "unknown") {
    const pulseRoot = heartbeatPulse.repository.root;
    const pulseName = pulseRoot.split(/[\\/]/).filter(Boolean).at(-1);
    if (repositoryId === `local:${pulseName}` || repositoryId === pulseName || repositoryId === pulseRoot) {
      if (existsSync(pulseRoot)) return pulseRoot;
    }
  }
  const projectRoot = findProjectRoot();
  const projectName = projectRoot.split(/[\\/]/).filter(Boolean).at(-1);
  if (
    repositoryId === "sk1ua/ConsistenCy" ||
    repositoryId === "ConsistenCy" ||
    repositoryId === projectName ||
    repositoryId === `local:${projectName}` ||
    repositoryId.startsWith("local:ConsistenCy")
  ) {
    if (existsSync(projectRoot) && existsSync(resolve(projectRoot, ".git"))) return projectRoot;
  }
  return undefined;
}
import { filterJobs, buildStats, recentReports, toApiJob } from "./api/jobView";
import { buildHealthPayload } from "./health";
import { processGitHubWebhook, WebhookError } from "./trigger/webhook";
import { LocalTriggerError } from "./trigger/local";
import { InMemoryJobQueue, type ReviewJobStore } from "./jobQueue";
import { sanitizePublicError } from "./security/redact";
import { settingsPatchSchema, toRendererSettings, findProjectRoot, type SettingsSnapshot } from "./config/settings";
import type { RealDataSnapshot } from "./data/realData";
import { PublicPrError } from "./review/publicPr";
import type { NotebookGraph } from "./notebook/graph";
import type { NotebookStore } from "./notebook/store";
import type { ReviewJob } from "./jobQueue";
import type { WorkflowStore } from "./workflows/store";
import { JobDiffError, type JobDiffResult } from "./review/jobDiff";
import { AuditDomainError, type AuditDomainStore } from "./audit/store";
import { validateLocalRepositoryRegistration } from "./audit/localRegistration";
import { AuditRunPlanner } from "./audit/planner";
import { RuntimeRegistry } from "./review/runtimeRegistry";

const MAX_BODY_BYTES = 1024 * 1024;

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 500, readonly details?: Record<string, unknown>) {
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
    "access-control-allow-headers": "authorization,content-type,x-consistency-desktop-control,x-github-event,x-github-delivery,x-hub-signature-256",
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

function parseAuditInput<TSchema extends z.ZodTypeAny>(schema: TSchema, value: unknown): z.output<TSchema> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ApiError(
        error.issues[0]?.message ?? "Audit request is invalid",
        "INVALID_AUDIT_REQUEST",
        400
      );
    }
    throw error;
  }
}

function auditInputWithPathId(value: unknown, field: "workflowId" | "policyId", id: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return { ...(value as Record<string, unknown>), [field]: id };
}

function auditCapabilityUnavailable(capability: string): never {
  throw new ApiError(
    `Audit capability '${capability}' is not wired yet`,
    "AUDIT_CAPABILITY_UNAVAILABLE",
    501,
    { capability }
  );
}

function requireAuditPlanner(options: CreateApiServerOptions): AuditRunPlanner {
  if (options.auditPlanner) return options.auditPlanner;
  if (options.auditStore) return new AuditRunPlanner(options.auditStore);
  throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
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
  if (error instanceof AuditDomainError) {
    sendJson(request, response, error.statusCode, errorPayload(error.code, sanitizePublicError(error.message)), allowedOrigins);
    return;
  }
  sendJson(request, response, 500, errorPayload("INTERNAL_ERROR", "Unexpected API error"), allowedOrigins);
}

function constantTimeTokenMatches(supplied: string | undefined, expected: string): boolean {
  const suppliedDigest = createHash("sha256").update(supplied ?? "").digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return supplied !== undefined && timingSafeEqual(suppliedDigest, expectedDigest);
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  return constantTimeTokenMatches(request.headers.authorization, `Bearer ${token}`);
}

function isDesktopControlAuthorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers["x-consistency-desktop-control"];
  return constantTimeTokenMatches(typeof supplied === "string" ? supplied : undefined, token);
}

function parseUrl(url: string | undefined): URL {
  return new URL(url ?? "/", "http://localhost");
}

function filesystemDisplayLabel(value: string): string {
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? "Local repository";
}

function toRendererHeartbeatPulse(pulse: HeartbeatPulse): HeartbeatPulse {
  return {
    ...pulse,
    repository: {
      ...pulse.repository,
      root: pulse.repository.root === "unknown"
        ? "Local repository"
        : filesystemDisplayLabel(pulse.repository.root)
    },
    ...(pulse.lastError === undefined ? {} : { lastError: sanitizePublicError(pulse.lastError) })
  };
}

function toRendererHeartbeatEvent(event: HeartbeatStreamEvent): HeartbeatStreamEvent {
  if (event.event === "pulse") return { ...event, pulse: toRendererHeartbeatPulse(event.pulse) };
  if (event.event === "change") {
    return {
      ...event,
      change: {
        ...event.change,
        repository: {
          ...event.change.repository,
          root: filesystemDisplayLabel(event.change.repository.root)
        }
      }
    };
  }
  if (event.event === "index_progress" && event.currentPath !== undefined) {
    const currentPath = /^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|file:)/i.test(event.currentPath)
      ? filesystemDisplayLabel(event.currentPath)
      : event.currentPath;
    return { ...event, currentPath };
  }
  if (event.event === "error") return { ...event, message: sanitizePublicError(event.message) };
  return event;
}

export type ApiHealthDetails = {
  database: { ok: boolean };
  worker: { running: boolean; activeJobs: number; concurrency: number; lastPollAt?: string };
  llmConfigured?: boolean;
  llmProvider: string;
  llmModel?: string;
  llmCapabilities?: {
    deepseek?: { configured: boolean; defaultModel: string };
    openai?: { configured: boolean; defaultModel: string };
  };
  publicPrAnalysis?: boolean;
  publicPrAccessMode?: "anonymous" | "pat" | "disabled";
  notebook?: boolean;
  configuration: {
    githubAppConfigured: boolean;
    webhookSecretConfigured: boolean;
    publicReadTokenConfigured: boolean;
    storage: { kind: "memory" | "file"; configured: boolean };
    workerConcurrency: number;
    publishWorkerConcurrency?: number;
  };
};

export type CreateApiServerOptions = {
  runProcess?: any;
  jobs?: ReviewJobStore;
  githubWebhookSecret?: string;
  apiToken?: string;
  desktopControlToken?: string;
  nodeEnv?: "development" | "test" | "production";
  allowedOrigins?: string[];
  healthDetails?: () => ApiHealthDetails;
  workspaceRoot?: string;
  settingsWritable?: boolean;
  settings?: {
    get: () => SettingsSnapshot;
    update: (patch: unknown) => SettingsSnapshot;
  };
  realData?: () => RealDataSnapshot | undefined;
  resolveReviewModel?: (override?: ReviewModelOverride) => ResolvedReviewModel;
  publicPr?: (url: string, modelOverride?: ResolvedReviewModel) => Promise<{ coordinates: { repository: string; pullRequestNumber: number; owner: string; repo: string }; job: ReviewJob }>;
  publicPrAnalysisEnabled?: boolean;
  llmProviderConfigured?: boolean;
  localReview?: (input: { repoPath: string; baseRef?: string; headRef?: string; llmProvider?: "deepseek" | "openai"; llmModel?: string }) => Promise<{ jobId: string }>;
  auditStore?: AuditDomainStore;
  auditPlanner?: AuditRunPlanner;
  automationScheduler?: { available: boolean };
  onAuditRepositoriesChanged?: () => Promise<void> | void;
  heartbeat?: {
    latest: () => HeartbeatPulse | undefined;
    subscribe: (subscriber: (event: HeartbeatStreamEvent) => void) => () => void;
  };
  workflows?: WorkflowStore;
  jobDiff?: (jobId: string) => Promise<JobDiffResult>;
  notebookEnabled?: boolean;
  notebookStore?: NotebookStore;
  notebookGraph?: NotebookGraph;
  runtimeRegistry?: RuntimeRegistry;
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
  desktopControlToken?: string;
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
    method: "GET",
    path: "/audit/capabilities",
    auth: true,
    handler: ({ request, response, allowedOrigins, options }) => {
      const persistence = options.auditStore !== undefined;
      sendJson(request, response, 200, auditCapabilitiesSchema.parse({
        domainVersion: 2,
        persistence,
        repositoryRegistration: persistence,
        localPathRegistration: false,
        repositoryTimeline: persistence,
        repositoryMetrics: persistence,
        workflowValidation: true,
        automationDefinitions: persistence,
        automationScheduling: persistence && options.automationScheduler?.available === true,
        automationHistory: persistence,
        auditRunDrafts: persistence,
        auditExecution: false,
        auditRunArtifacts: persistence,
        auditRunEvents: false,
        auditReports: persistence,
        auditExport: false,
        issueTriage: persistence,
        evolutionPersistence: persistence,
        policyEvaluation: true
      }), allowedOrigins);
    }
  },
  {
    method: "POST",
    path: "/internal/repositories/local",
    auth: true,
    handler: async ({
      request,
      response,
      allowedOrigins,
      options,
      apiToken,
      desktopControlToken
    }) => {
      if (!apiToken || !desktopControlToken) {
        throw new ApiError(
          "Desktop repository control is not configured",
          "DESKTOP_CONTROL_UNAVAILABLE",
          503
        );
      }
      if (!isDesktopControlAuthorized(request, desktopControlToken)) {
        throw new ApiError(
          "Valid desktop control authorization is required",
          "DESKTOP_CONTROL_UNAUTHORIZED",
          401
        );
      }
      if (!options.auditStore) {
        throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      }

      const input = parseAuditInput(
        internalLocalRepositoryRegistrationRequestSchema,
        await readJson(request)
      );
      const validated = await validateLocalRepositoryRegistration(input);
      const repository = options.auditStore.createRepository({
        displayName: validated.displayName,
        source: "local_git",
        monitoringEnabled: validated.monitoringEnabled
      }, {
        serverLocator: validated.serverLocator
      });
      await options.onAuditRepositoriesChanged?.();
      sendJson(request, response, 201, { repository }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/workflows\/([^/]+)\/revisions$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const workflowId = decodeURIComponent(match?.[1] ?? "");
      sendJson(request, response, 200, {
        workflowId,
        workflowRevisions: options.auditStore.listWorkflowRevisions(workflowId)
      }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: /^\/workflows\/([^/]+)\/revisions$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const workflowId = decodeURIComponent(match?.[1] ?? "");
      const input = parseAuditInput(
        createWorkflowRevisionRequestSchema,
        auditInputWithPathId(await readJson(request), "workflowId", workflowId)
      );
      const workflowRevision = options.auditStore.createWorkflowRevision(input);
      sendJson(request, response, 201, { workflowRevision }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: /^\/workflows\/([^/]+)\/validate$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, match }) => {
      const workflowId = decodeURIComponent(match?.[1] ?? "");
      const raw = await readJson(request);
      const specCandidate = raw !== null && typeof raw === "object" && !Array.isArray(raw) && "spec" in raw
        ? (raw as { spec: unknown }).spec
        : raw;
      const spec = parseAuditInput(workflowSpecSchema, specCandidate);
      sendJson(request, response, 200, { valid: true, workflowId, spec }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/policies\/([^/]+)\/revisions$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const policyId = decodeURIComponent(match?.[1] ?? "");
      sendJson(request, response, 200, {
        policyId,
        policyRevisions: options.auditStore.listPolicyRevisions(policyId)
      }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: /^\/policies\/([^/]+)\/revisions$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const policyId = decodeURIComponent(match?.[1] ?? "");
      const input = parseAuditInput(
        createPolicyRevisionRequestSchema,
        auditInputWithPathId(await readJson(request), "policyId", policyId)
      );
      const policyRevision = options.auditStore.createPolicyRevision(input);
      sendJson(request, response, 201, { policyRevision }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: /^\/policies\/([^/]+)\/evaluate$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const policyId = decodeURIComponent(match?.[1] ?? "");
      const policyRevision = options.auditStore.listPolicyRevisions(policyId)[0];
      if (!policyRevision) throw new ApiError("Policy not found", "POLICY_NOT_FOUND", 404);
      const input = parseAuditInput(z.object({
        riskScore: riskScoreSchema,
        coverage: z.number().min(0).max(1),
        completedChecks: z.array(stepIdSchema).default([])
      }).strict(), await readJson(request));
      const evaluation = evaluateAuditPolicy(policyRevision, input);
      sendJson(request, response, 200, {
        policyId,
        policyRevisionId: policyRevision.id,
        evaluation
      }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/repositories",
    auth: true,
    handler: ({ request, response, allowedOrigins, options }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      sendJson(request, response, 200, { repositories: options.auditStore.listRepositories() }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: "/repositories",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const input = parseAuditInput(createRepositoryRequestSchema, await readJson(request));
      // Local checkout paths are intentionally not accepted by this public DTO.
      // Desktop main uses the separately authenticated internal registration route.
      if (input.source === "local_git") {
        throw new ApiError(
          "Local repository registration requires the privileged desktop adapter",
          "LOCAL_PATH_REGISTRATION_UNAVAILABLE",
          501
        );
      }
      const repository = options.auditStore.createRepository(input);
      sendJson(request, response, 201, { repository }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/repositories\/([^/]+)$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const repository = options.auditStore.getRepository(decodeURIComponent(match?.[1] ?? ""));
      if (!repository) throw new ApiError("Repository not found", "REPOSITORY_NOT_FOUND", 404);
      sendJson(request, response, 200, { repository }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/repositories\/([^/]+)\/events$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const repositoryId = decodeURIComponent(match?.[1] ?? "");
      if (!options.auditStore.getRepository(repositoryId)) throw new ApiError("Repository not found", "REPOSITORY_NOT_FOUND", 404);
      sendJson(request, response, 200, { events: options.auditStore.listRepositoryEvents(repositoryId) }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/repositories\/([^/]+)\/timeline$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const repositoryId = decodeURIComponent(match?.[1] ?? "");
      if (!options.auditStore.getRepository(repositoryId)) throw new ApiError("Repository not found", "REPOSITORY_NOT_FOUND", 404);
      sendJson(request, response, 200, {
        repositoryId,
        repositoryEvents: options.auditStore.listRepositoryEvents(repositoryId),
        repositoryPulses: options.auditStore.listRepositoryPulses(repositoryId),
        auditRuns: options.auditStore.listAuditRuns(repositoryId)
      }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/repositories\/([^/]+)\/metrics$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const repositoryId = decodeURIComponent(match?.[1] ?? "");
      sendJson(request, response, 200, {
        repositoryId,
        evolutionSnapshots: options.auditStore.listEvolutionSnapshots(repositoryId)
      }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/repositories\/([^/]+)\/issues$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match, url }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const repositoryId = decodeURIComponent(match?.[1] ?? "");
      if (!options.auditStore.getRepository(repositoryId)) throw new ApiError("Repository not found", "REPOSITORY_NOT_FOUND", 404);
      const stateRaw = url.searchParams.get("state") ?? undefined;
      const state = stateRaw === undefined ? undefined : parseAuditInput(auditIssueStateSchema, stateRaw);
      sendJson(request, response, 200, {
        repositoryId,
        issues: options.auditStore.listIssues(repositoryId, state)
      }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/repositories\/([^/]+)\/git\/status$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      const repositoryId = decodeURIComponent(match?.[1] ?? "");
      const localPath = resolveLocalPathForRepository(repositoryId, options);
      if (!localPath) {
        sendJson(request, response, 200, {
          repositoryId,
          available: false,
          reason: "local repository path unavailable",
          branch: null,
          headSha: null,
          dirtyFileCount: 0,
          untrackedFileCount: 0,
          changedFiles: [],
          untrackedFiles: [],
          remotes: []
        }, allowedOrigins);
        return;
      }
      try {
        const vcs = new LocalGitAdapter({ root: localPath });
        const [branch, headSha, diff, untracked, remotes] = await Promise.all([
          vcs.getCurrentBranch().catch(() => undefined),
          vcs.getHeadSha().catch(() => undefined),
          vcs.getWorkingDiff().catch(() => []),
          vcs.getUntrackedFiles().catch(() => []),
          vcs.getRemotes().catch(() => [])
        ]);
        sendJson(request, response, 200, {
          repositoryId,
          available: true,
          branch: branch ?? null,
          headSha: headSha ?? null,
          dirtyFileCount: diff.length,
          untrackedFileCount: untracked.length,
          changedFiles: diff,
          untrackedFiles: untracked,
          remotes,
          primaryRemote: remotes[0]
        }, allowedOrigins);
      } catch {
        sendJson(request, response, 200, {
          repositoryId,
          available: false,
          reason: "failed to execute git status",
          branch: null,
          headSha: null,
          dirtyFileCount: 0,
          untrackedFileCount: 0,
          changedFiles: [],
          untrackedFiles: [],
          remotes: []
        }, allowedOrigins);
      }
    }
  },
  {
    method: "GET",
    path: /^\/repositories\/([^/]+)\/git\/commits$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match, url }) => {
      const repositoryId = decodeURIComponent(match?.[1] ?? "");
      const depth = Math.min(50, Math.max(1, Number(url.searchParams.get("depth") || 30)));
      const localPath = resolveLocalPathForRepository(repositoryId, options);
      if (localPath) {
        try {
          const vcs = new LocalGitAdapter({ root: localPath });
          const commits = await vcs.getCommitHistory(depth);
          sendJson(request, response, 200, { repositoryId, commits }, allowedOrigins);
          return;
        } catch {
          // fall through
        }
      }
      sendJson(request, response, 200, { repositoryId, commits: [] }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/repositories\/([^/]+)\/pull-requests$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      const repositoryId = decodeURIComponent(match?.[1] ?? "");
      const allJobs = options.jobs?.list() ?? [];
      const matchingJobs = allJobs.filter(job =>
        job.repository === repositoryId ||
        repositoryId.includes(job.repository) ||
        (repositoryId.startsWith("local:") && job.accessMode === "local_git")
      );

      const prs = matchingJobs
        .filter(job => job.pullRequestNumber !== undefined)
        .map(job => ({
          number: job.pullRequestNumber!,
          title: job.result?.summary ? `Review for ${job.repository} #${job.pullRequestNumber}` : `Pull request #${job.pullRequestNumber}`,
          state: job.status === "succeeded" ? "open" as const : job.status === "failed" ? "closed" as const : "open" as const,
          author: "demo-contributor",
          baseRef: "main",
          headRef: `pr-${job.pullRequestNumber}`,
          baseSha: job.baseSha ?? "base-sha",
          headSha: job.headSha ?? "head-sha",
          createdAt: job.createdAt,
          updatedAt: job.finishedAt ?? job.startedAt ?? job.createdAt,
          reviewStatus: job.status as "succeeded" | "running" | "failed",
          score: job.result?.score,
          riskLevel: job.result?.riskLevel,
          jobId: job.id
        }));

      if (prs.length === 0 && (repositoryId.startsWith("local:") || repositoryId.startsWith("repo_"))) {
        sendJson(request, response, 200, {
          repositoryId,
          available: false,
          reason: "No GitHub remote connected or PR history unavailable",
          pullRequests: []
        }, allowedOrigins);
        return;
      }

      sendJson(request, response, 200, {
        repositoryId,
        available: true,
        pullRequests: prs
      }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: /^\/repositories\/([^/]+)\/actions\/set-monitoring$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const body = parseAuditInput(z.object({ enabled: z.boolean() }).strict(), await readJson(request));
      const repository = options.auditStore.setRepositoryMonitoring(decodeURIComponent(match?.[1] ?? ""), body.enabled);
      await options.onAuditRepositoriesChanged?.();
      sendJson(request, response, 200, { repository }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/workflow-revisions",
    auth: true,
    handler: ({ request, response, allowedOrigins, options, url }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      sendJson(request, response, 200, {
        workflowRevisions: options.auditStore.listWorkflowRevisions(url.searchParams.get("workflowId") ?? undefined)
      }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: "/workflow-revisions",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const revision = options.auditStore.createWorkflowRevision(
        parseAuditInput(createWorkflowRevisionRequestSchema, await readJson(request))
      );
      sendJson(request, response, 201, { workflowRevision: revision }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/policy-revisions",
    auth: true,
    handler: ({ request, response, allowedOrigins, options, url }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      sendJson(request, response, 200, {
        policyRevisions: options.auditStore.listPolicyRevisions(url.searchParams.get("policyId") ?? undefined)
      }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: "/policy-revisions",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const revision = options.auditStore.createPolicyRevision(
        parseAuditInput(createPolicyRevisionRequestSchema, await readJson(request))
      );
      sendJson(request, response, 201, { policyRevision: revision }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/automations",
    auth: true,
    handler: ({ request, response, allowedOrigins, options, url }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      sendJson(request, response, 200, {
        automations: options.auditStore.listAutomations(url.searchParams.get("repositoryId") ?? undefined)
      }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: "/automations",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const automation = options.auditStore.createAutomation(
        parseAuditInput(createAutomationRequestSchema, await readJson(request))
      );
      await options.onAuditRepositoriesChanged?.();
      sendJson(request, response, 201, { automation }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/automations\/([^/]+)$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const automation = options.auditStore.getAutomation(decodeURIComponent(match?.[1] ?? ""));
      if (!automation) throw new ApiError("Automation not found", "AUTOMATION_NOT_FOUND", 404);
      sendJson(request, response, 200, { automation }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: /^\/automations\/([^/]+)\/(pause|resume)$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const automation = options.auditStore.setAutomationEnabled(
        decodeURIComponent(match?.[1] ?? ""),
        match?.[2] === "resume"
      );
      await options.onAuditRepositoriesChanged?.();
      sendJson(request, response, 200, { automation }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/automations\/([^/]+)\/history$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const automationId = decodeURIComponent(match?.[1] ?? "");
      const automation = options.auditStore.getAutomation(automationId);
      if (!automation) throw new ApiError("Automation not found", "AUTOMATION_NOT_FOUND", 404);
      const auditRuns = options.auditStore.listAuditRuns(automation.repositoryId)
        .filter(run => run.automationId === automationId);
      const planningReceipts = options.auditStore.listAuditRunPlanningReceipts(automationId);
      const scheduleState = options.auditStore.getAutomationScheduleState(automationId) ?? null;
      const scheduleWindows = automation.trigger.type === "schedule"
        ? options.auditStore.listAutomationScheduleWindows(automationId)
        : [];
      sendJson(request, response, 200, {
        automationId,
        auditRuns,
        planningReceipts,
        scheduleState,
        scheduleWindows
      }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/automations\/([^/]+)\/schedule$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const automationId = decodeURIComponent(match?.[1] ?? "");
      const automation = options.auditStore.getAutomation(automationId);
      if (!automation) throw new ApiError("Automation not found", "AUTOMATION_NOT_FOUND", 404);
      if (automation.trigger.type !== "schedule") {
        throw new ApiError("Automation is not schedule-triggered", "AUTOMATION_TRIGGER_NOT_MATCHED", 409);
      }
      sendJson(request, response, 200, {
        automationId,
        scheduleState: options.auditStore.getAutomationScheduleState(automationId) ?? null,
        scheduleWindows: options.auditStore.listAutomationScheduleWindows(automationId)
      }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: /^\/automations\/([^/]+)\/run$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const automationId = decodeURIComponent(match?.[1] ?? "");
      const planning = requireAuditPlanner(options).planManualRun(automationId);
      sendJson(request, response, 202, { planning }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: /^\/automations\/([^/]+)\/actions\/(pause|resume)$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const automation = options.auditStore.setAutomationEnabled(
        decodeURIComponent(match?.[1] ?? ""),
        match?.[2] === "resume"
      );
      await options.onAuditRepositoriesChanged?.();
      sendJson(request, response, 200, { automation }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/audit-runs",
    auth: true,
    handler: ({ request, response, allowedOrigins, options, url }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      sendJson(request, response, 200, {
        auditRuns: options.auditStore.listAuditRuns(url.searchParams.get("repositoryId") ?? undefined)
      }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: "/audit-runs",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const auditRun = options.auditStore.createAuditRunDraft(
        parseAuditInput(createAuditRunRequestSchema, await readJson(request))
      );
      sendJson(request, response, 201, {
        auditRun,
        execution: { available: false, reason: "Audit execution is not wired to the v2 domain yet" }
      }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/audit-runs\/([^/]+)\/steps$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const auditRunId = decodeURIComponent(match?.[1] ?? "");
      sendJson(request, response, 200, {
        auditRunId,
        steps: options.auditStore.listRunStepArtifacts(auditRunId)
      }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/audit-runs\/([^/]+)\/report$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const auditRunId = decodeURIComponent(match?.[1] ?? "");
      if (!options.auditStore.getAuditRun(auditRunId)) throw new ApiError("Audit run not found", "AUDIT_RUN_NOT_FOUND", 404);
      const report = options.auditStore.getAuditReport(auditRunId);
      if (!report) throw new ApiError("Audit report not found", "AUDIT_REPORT_NOT_FOUND", 404);
      sendJson(request, response, 200, { report }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/audit-runs\/([^/]+)\/events$/,
    auth: true,
    handler: ({ options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const auditRunId = decodeURIComponent(match?.[1] ?? "");
      if (!options.auditStore.getAuditRun(auditRunId)) throw new ApiError("Audit run not found", "AUDIT_RUN_NOT_FOUND", 404);
      auditCapabilityUnavailable("auditRunEvents");
    }
  },
  {
    method: "POST",
    path: /^\/audit-runs\/([^/]+)\/cancel$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const auditRun = options.auditStore.cancelAuditRun(decodeURIComponent(match?.[1] ?? ""));
      sendJson(request, response, 200, { auditRun }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/audit-runs\/([^/]+)\/export$/,
    auth: true,
    handler: ({ options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const auditRunId = decodeURIComponent(match?.[1] ?? "");
      if (!options.auditStore.getAuditRun(auditRunId)) throw new ApiError("Audit run not found", "AUDIT_RUN_NOT_FOUND", 404);
      auditCapabilityUnavailable("auditExport");
    }
  },
  {
    method: "POST",
    path: /^\/audit-runs\/([^/]+)\/export$/,
    auth: true,
    handler: ({ options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const auditRunId = decodeURIComponent(match?.[1] ?? "");
      if (!options.auditStore.getAuditRun(auditRunId)) throw new ApiError("Audit run not found", "AUDIT_RUN_NOT_FOUND", 404);
      auditCapabilityUnavailable("auditExport");
    }
  },
  {
    method: "GET",
    path: /^\/audit-runs\/([^/]+)$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const auditRun = options.auditStore.getAuditRun(decodeURIComponent(match?.[1] ?? ""));
      if (!auditRun) throw new ApiError("Audit run not found", "AUDIT_RUN_NOT_FOUND", 404);
      sendJson(request, response, 200, { auditRun }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: /^\/audit-runs\/([^/]+)\/actions\/cancel$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const auditRun = options.auditStore.cancelAuditRun(decodeURIComponent(match?.[1] ?? ""));
      sendJson(request, response, 200, { auditRun }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/issues",
    auth: true,
    handler: ({ request, response, allowedOrigins, options, url }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const stateRaw = url.searchParams.get("state") ?? undefined;
      const state = stateRaw === undefined ? undefined : parseAuditInput(auditIssueStateSchema, stateRaw);
      sendJson(request, response, 200, {
        issues: options.auditStore.listIssues(url.searchParams.get("repositoryId") ?? undefined, state)
      }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: "/issues",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const issue = options.auditStore.createIssue(
        parseAuditInput(createAuditIssueRequestSchema, await readJson(request))
      );
      sendJson(request, response, 201, { issue }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/issues\/([^/]+)$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const issue = options.auditStore.getIssue(decodeURIComponent(match?.[1] ?? ""));
      if (!issue) throw new ApiError("Issue not found", "ISSUE_NOT_FOUND", 404);
      sendJson(request, response, 200, { issue }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: /^\/issues\/([^/]+)\/triage$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const body = parseAuditInput(z.object({
        action: auditIssueActionSchema,
        reason: z.string().trim().min(1).max(2_000).optional()
      }).strict(), await readJson(request));
      const issue = options.auditStore.applyIssueAction(
        decodeURIComponent(match?.[1] ?? ""),
        body.action,
        body.reason
      );
      sendJson(request, response, 200, { issue }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: /^\/issues\/([^/]+)\/actions\/([^/]+)$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const action = parseAuditInput(auditIssueActionSchema, decodeURIComponent(match?.[2] ?? ""));
      const body = parseAuditInput(auditIssueActionRequestSchema, await readJson(request));
      const issue = options.auditStore.applyIssueAction(decodeURIComponent(match?.[1] ?? ""), action, body.reason);
      sendJson(request, response, 200, { issue }, allowedOrigins);
    }
  },
  {
    method: "POST",
    path: "/reviews/public-pr",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, nodeEnv }) => {
      if (options.publicPrAnalysisEnabled === false || (nodeEnv === "production" && options.publicPrAnalysisEnabled !== true)) {
        throw new ApiError("Public PR analysis is disabled", "PUBLIC_PR_ANALYSIS_DISABLED", 404);
      }
      if (options.llmProviderConfigured === false) {
        throw new ApiError(
          "尚未配置大语言模型。ConsistenCy 需要配置真实 LLM Provider (DeepSeek 或 OpenAI) 后才能执行审查。请前往设置页配置。",
          "LLM_NOT_CONFIGURED",
          400
        );
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
      const modelOverride = body.model ?? body.llm;
      let resolvedModel: ResolvedReviewModel | undefined;
      if (options.resolveReviewModel) {
        try {
          resolvedModel = options.resolveReviewModel(modelOverride);
        } catch (error) {
          if (error instanceof ReviewModelResolutionError) {
            throw new ApiError(error.message, error.code, 400);
          }
          throw error;
        }
      }
      const result = await options.publicPr(body.url, resolvedModel);
      const ensured = options.notebookStore.ensureForJob(result.job);
      sendJson(request, response, 202, {
        jobId: result.job.id,
        notebookId: ensured.notebook.id,
        repository: result.coordinates.repository,
        pullRequestNumber: result.coordinates.pullRequestNumber,
        baseSha: result.job.baseSha,
        headSha: result.job.headSha,
        publicationPolicy: "disabled",
        llmProvider: result.job.llmProvider,
        llmModel: result.job.llmModel,
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
      sendJson(request, response, 200, { pulse: pulse === undefined ? null : toRendererHeartbeatPulse(pulse) }, allowedOrigins);
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
        writeSse(response, event.event, toRendererHeartbeatEvent(event));
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
      if (options.llmProviderConfigured === false) {
        throw new ApiError(
          "尚未配置大语言模型。ConsistenCy 需要配置真实 LLM Provider (DeepSeek 或 OpenAI) 后才能执行审查。请前往设置页配置。",
          "LLM_NOT_CONFIGURED",
          400
        );
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

      const modelOverride = body.model ?? body.llm;
      let resolvedModel: ResolvedReviewModel | undefined;
      if (options.resolveReviewModel) {
        try {
          resolvedModel = options.resolveReviewModel(modelOverride);
        } catch (error) {
          if (error instanceof ReviewModelResolutionError) {
            throw new ApiError(error.message, error.code, 400);
          }
          throw error;
        }
      }

      let result: { jobId: string };
      try {
        result = await options.localReview({
          repoPath: body.repoPath,
          baseRef: body.baseRef,
          headRef: body.headRef,
          llmProvider: resolvedModel?.provider,
          llmModel: resolvedModel?.model
        });
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
        baseSha: job.baseSha,
        headSha: job.headSha,
        publicationPolicy: "disabled",
        llmProvider: job.llmProvider,
        llmModel: job.llmModel,
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
    handler: async ({ request, response, allowedOrigins, githubWebhookSecret, jobs, options }) => {
      if (!githubWebhookSecret) throw new WebhookError("GitHub webhook is not configured", "WEBHOOK_NOT_CONFIGURED", 503);
      const result = processGitHubWebhook({
        headers: request.headers,
        body: await readBody(request),
        secret: githubWebhookSecret,
        jobs,
        llmConfigured: options.llmProviderConfigured !== false
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
    auth: false,
    handler: ({ request, response, allowedOrigins, options, githubWebhookSecret }) => {
      const details = options.healthDetails?.() ?? {
        database: { ok: true },
        worker: { running: false, activeJobs: 0, concurrency: 1 },
        llmConfigured: false,
        llmProvider: "none",
        publicPrAccessMode: "disabled" as const,
        configuration: {
          githubAppConfigured: false,
          webhookSecretConfigured: Boolean(githubWebhookSecret),
          publicReadTokenConfigured: false,
          storage: { kind: "memory" as const, configured: true },
          workerConcurrency: 1
        }
      };
      sendJson(request, response, 200, {
        ...buildHealthPayload(),
        ...details,
        configuration: {
          githubAppConfigured: details.configuration.githubAppConfigured,
          webhookSecretConfigured: details.configuration.webhookSecretConfigured,
          publicReadTokenConfigured: details.configuration.publicReadTokenConfigured,
          storage: details.configuration.storage,
          workerConcurrency: details.configuration.workerConcurrency,
          ...(details.configuration.publishWorkerConcurrency === undefined
            ? {}
            : { publishWorkerConcurrency: details.configuration.publishWorkerConcurrency })
        }
      }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/settings",
    auth: true,
    handler: ({ request, response, allowedOrigins, options }) => {
      if (!options.settings) throw new ApiError("Settings service is unavailable", "SETTINGS_UNAVAILABLE", 404);
      sendJson(request, response, 200, { settings: toRendererSettings(options.settings.get()) }, allowedOrigins);
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
      const settingsWritable = options.settingsWritable ?? (nodeEnv !== "production");
      if (!options.settings || !settingsWritable) {
        throw new ApiError("Settings updates are disabled", "SETTINGS_READ_ONLY", 404);
      }
      const patch = settingsPatchSchema.parse(await readJson(request));
      sendJson(request, response, 200, {
        settings: toRendererSettings(options.settings.update(patch))
      }, allowedOrigins);
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
  },
  {
    method: "GET",
    path: /^\/(?:api\/)?runtime\/runs$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options }) => {
      const registry = options.runtimeRegistry ?? defaultRuntimeRegistry;
      sendJson(request, response, 200, { runs: registry.listRunSummaries() }, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/(?:api\/)?runtime\/runs\/([^/]+)$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match, jobs }) => {
      const id = decodeURIComponent(match?.[1] ?? "");
      const registry = options.runtimeRegistry ?? defaultRuntimeRegistry;
      const snapshot = registry.getSnapshot(id);

      if (snapshot) {
        sendJson(request, response, 200, snapshot, allowedOrigins);
        return;
      }

      // Check if job exists in jobStore to see if it's an old run without telemetry
      const job = jobs.get(id) ?? jobs.list().find(j => j.id === id);
      if (job) {
        sendJson(request, response, 200, {
          runId: job.id,
          workloadKind: "pr_review",
          jobId: job.id,
          state: job.status.toUpperCase(),
          createdAt: job.createdAt,
          finishedAt: job.finishedAt,
          telemetryStatus: "unavailable",
          agentCounts: { total: 0, running: 0, waiting: 0, terminal: 0 },
          concurrency: 1,
          securityGuarantees: DEFAULT_SECURITY_GUARANTEES,
          agents: []
        }, allowedOrigins);
        return;
      }

      throw new ApiError("Run runtime snapshot not found", "RUN_NOT_FOUND", 404);
    }
  }
];

const defaultRuntimeRegistry = new RuntimeRegistry();

export function createApiServer(options: CreateApiServerOptions = {}) {
  const jobs = options.jobs ?? new InMemoryJobQueue();
  const githubWebhookSecret = options.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
  const apiToken = options.apiToken ?? process.env.CONSISTENCY_API_TOKEN;
  const desktopControlToken = options.desktopControlToken ?? process.env.CONSISTENCY_DESKTOP_CONTROL_TOKEN;
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
        desktopControlToken,
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
