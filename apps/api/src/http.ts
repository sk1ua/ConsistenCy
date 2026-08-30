import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z, ZodError } from "zod";
import {
  auditCapabilitiesSchema,
  auditIssueActionRequestSchema,
  auditIssueActionSchema,
  auditIssueStateSchema,
  auditRunEventsResponseSchema,
  auditRunExportSchema,
  createAuditIssueRequestSchema,
  createAuditRunRequestSchema,
  createAutomationRequestSchema,
  createPolicyRevisionRequestSchema,
  createRepositoryRequestSchema,
  createWorkflowRevisionRequestSchema,
  DEFAULT_SECURITY_GUARANTEES,
  evaluateAuditPolicy,
  githubConnectionTestRequestSchema,
  githubConnectionTestResponseSchema,
  internalLocalRepositoryRegistrationRequestSchema,
  localReviewRequestSchema,
  notebookCardRequestSchema,
  notebookMessageRequestSchema,
  publicPrRequestSchema,
  REPOSITORY_REVIEWS_MAX_LIMIT,
  repositoryPullRequestsResponseSchema,
  repositoryReviewsResponseSchema,
  reviewPreparationResponseSchema,
  riskScoreSchema,
  saveWorkflowRequestSchema,
  stepIdSchema,
  workflowSpecSchema,
  type GitRemoteInfo,
  type GitHubConnectionTestRequest,
  type GitHubConnectionTestResponse,
  type ReviewModelOverride
} from "@consistency/schema";
import type { HeartbeatPulse, HeartbeatStreamEvent, Repository, VcsChangedFile } from "@consistency/schema";
import { LocalGitAdapter } from "@consistency/vcs-core";
import { RepositoryPullRequestService, type RepositoryPullRequestRequest } from "./github/pullRequestReader";
import { PublicRepositoryError } from "./github/publicRepository";
import { ReviewModelResolutionError, type ResolvedReviewModel } from "./review/llm/factory";

function resolveLocalPathForRepository(repositoryId: string, options: CreateApiServerOptions): string | undefined {
  const repository = options.auditStore?.getRepository(repositoryId);
  if (repository?.source !== "local_git") return undefined;
  return options.auditStore?.getLocalRepositoryPath?.(repository.id);
}

function toRendererGitRemote(remote: {
  readonly name: string;
  readonly githubFullName?: string;
}): GitRemoteInfo {
  return {
    name: remote.name,
    ...(remote.githubFullName === undefined ? {} : { githubFullName: remote.githubFullName })
  };
}

function fulfilledValue<T>(result: PromiseSettledResult<T>): T | undefined {
  switch (result.status) {
    case "fulfilled":
      return result.value;
    case "rejected":
      return undefined;
  }
}
import { filterJobs, buildStats, recentReports, toApiJob } from "./api/jobView";
import { buildHealthPayload } from "./health";
import { processGitHubWebhook, WebhookError } from "./trigger/webhook";
import { LocalTriggerError } from "./trigger/local";
import { InMemoryJobQueue, type ReviewJobStore } from "./jobQueue";
import { sanitizeExecutionError, sanitizePublicError, sanitizeValidationIssues, sanitizeStructuredData } from "./security/redact";
import { settingsPatchSchema, toRendererSettings, type SettingsSnapshot } from "./config/settings";
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
import {
  AUDIT_EXECUTION_AUTOMATION_NOT_MAPPED_REASON,
  AUDIT_EXECUTION_DISABLED_REASON,
  AUDIT_EXECUTION_LOCAL_REPOSITORY_REQUIRED_REASON
} from "./audit/executor";
import { RuntimeRegistry } from "./review/runtimeRegistry";
import {
  WorkflowRuntimeHost,
  WorkflowRepositoryNotFoundError,
  WorkflowSnapshotUnavailableError,
  WorkflowDefinitionNotFoundError,
  WorkflowDefinitionNotExecutableError,
  WorkflowDefinitionInvalidError,
  WorkflowRuntimePersistenceError,
} from "./workflow-runtime/host";
import { WorkflowRuntimeStoreError } from "./workflow-runtime/store";
import { compileWorkflowRuntimeDefinition } from "./workflow-runtime/compile";
import { listWorkflowNodeTypes } from "./workflow-runtime/registry";
import type { LLMProvider } from "./review/llm/types";
import {
  workflowRuntimeCopilotProposalRequestSchema,
  workflowRuntimeCopilotProposalResponseSchema,
  workflowRuntimeCopilotProposalSchema,
  type WorkflowRuntimeCopilotAddEdgeOperation,
  type WorkflowRuntimeCopilotProposal,
  type WorkflowRuntimeDefinition,
  type WorkflowRuntimeNodeType,
} from "@consistency/schema";
import {
  workflowRuntimeSaveDefinitionRequestSchema,
  workflowRuntimeSetBindingRequestSchema,
  workflowRuntimeRepositoryTriggerRequestSchema,
  workflowRuntimeTriggerRequestV2Schema,
} from "@consistency/schema";
import { buildEngineAllowlistCatalog, buildKernelSyscallCatalog, buildReviewPipelineCatalog } from "./catalog/catalog";
import {
  engineAllowlistCatalogResponseSchema,
  kernelSyscallCatalogResponseSchema,
  reviewPipelineCatalogResponseSchema
} from "@consistency/schema";

const MAX_BODY_BYTES = 1024 * 1024;

/** Sanitized fail-closed mapping for workflow-runtime host/store errors. */
function mapWorkflowRuntimeError(error: unknown): unknown {
  if (error instanceof WorkflowRepositoryNotFoundError) {
    return new ApiError("Repository not found", "REPOSITORY_NOT_FOUND", 404);
  }
  if (error instanceof WorkflowSnapshotUnavailableError) {
    return new ApiError(error.message, "WORKFLOW_SNAPSHOT_UNAVAILABLE", 503);
  }
  if (error instanceof WorkflowDefinitionNotFoundError) {
    return new ApiError("Workflow definition not found", "WORKFLOW_DEFINITION_NOT_FOUND", 404);
  }
  if (error instanceof WorkflowDefinitionNotExecutableError) {
    return new ApiError(sanitizePublicError(error.message), "WORKFLOW_DEFINITION_NOT_EXECUTABLE", 409);
  }
  if (error instanceof WorkflowDefinitionInvalidError) {
    return new ApiError(
      "Workflow definition failed canonical runtime validation",
      "WORKFLOW_DEFINITION_INVALID",
      400,
      { issues: sanitizeValidationIssues(error.issues) }
    );
  }
  if (error instanceof WorkflowRuntimePersistenceError) {
    return new ApiError("Workflow runtime persistence is unavailable", "WORKFLOW_RUNTIME_STORE_UNAVAILABLE", 503);
  }
  if (error instanceof WorkflowRuntimeStoreError) {
    return new ApiError(error.message, error.code, error.statusCode);
  }
  return error;
}

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 500, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * CKPT6 Phase 3 — Workflow Copilot proposal support (SPEC §18.2/§18.3/§36).
 * The endpoint is a pure advisor: zero persistence, zero run/dry-load side
 * effects, and the only path to a persisted change is a human Apply through
 * the Studio reducer and the canonical validate → save-revision gates. The
 * LLM can never bypass the compiler.
 */

/** Deterministic JSON with recursively sorted object keys (fingerprint input only). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function buildWorkflowCopilotPrompt(input: {
  instruction: string;
  definition: WorkflowRuntimeDefinition;
  nodeTypes: WorkflowRuntimeNodeType[];
}): { systemPrompt: string; userPrompt: string } {
  const registryLines = input.nodeTypes.map(nodeType => {
    const fields = nodeType.parameterSchema.fields
      .map(field => `${field.name}:${field.type}${field.required ? "(required)" : ""}${field.enumValues ? `(${field.enumValues.join("|")})` : ""}`)
      .join(", ") || "none";
    return `- type=${nodeType.type} serviceRef=${nodeType.serviceRef} role=${nodeType.role} parameters: ${fields}`;
  }).join("\n");
  const systemPrompt = [
    "You are the ConsistenCy Workflow Copilot. You translate one natural-language instruction into a structured WorkflowPatch proposal for the Workflow Studio execution graph.",
    "Hard rules:",
    "- Output ONLY a JSON object that satisfies the provided schema. No prose, no markdown fences.",
    "- Every ADD_NODE.serviceRef MUST be copied verbatim from the registry whitelist below. Never invent node types, serviceRefs, or capabilities.",
    "- Every ADD_EDGE.from/to MUST reference a node id that exists in the current definition OR is introduced by an ADD_NODE operation in the same patch.",
    "- The patch vocabulary is ADD_NODE and ADD_EDGE only; never remove or modify existing nodes or edges.",
    "- Edge conditions do not exist in this contract version; never emit a condition field.",
    "- Parameters must follow the registry parameter descriptors; prefer omitting parameters over guessing values.",
    "- failurePolicy is always fail-closed and cannot be changed.",
    "",
    "Registry whitelist (the only allowed node types / serviceRefs):",
    registryLines,
    "",
    "Current definition:",
    JSON.stringify(input.definition)
  ].join("\n");
  return { systemPrompt, userPrompt: `Instruction:\n${input.instruction}\n\nReturn the WorkflowPatch JSON object only.` };
}

async function generateWorkflowCopilotProposal(provider: LLMProvider, input: {
  instruction: string;
  definition: WorkflowRuntimeDefinition;
  nodeTypes: WorkflowRuntimeNodeType[];
}): Promise<WorkflowRuntimeCopilotProposal> {
  const { systemPrompt, userPrompt } = buildWorkflowCopilotPrompt(input);
  try {
    const result = await provider.invokeWithSchema({
      schema: workflowRuntimeCopilotProposalSchema,
      schemaName: "workflow-copilot-proposal",
      systemPrompt,
      userPrompt
    });
    return result.data;
  } catch {
    // One sanitized 502 for EVERY generation failure (schema-invalid output
    // after the provider's own repair attempt included). The raw LLM output,
    // provider errors, and prompts are never echoed back or logged.
    throw new ApiError("The configured LLM failed to produce a schema-valid workflow proposal", "WORKFLOW_PATCH_GENERATION_FAILED", 502);
  }
}

/**
 * Fail-closed post-generation validation (hallucination detection):
 * 1. registry serviceRef whitelist against the server-owned registry;
 * 2. ADD_EDGE endpoint existence, counting nodes the patch itself adds;
 * 3. ADD_EDGE duplication — an edge that already exists in the definition or
 *    was added earlier in the same patch is rejected (fail-closed: the reducer
 *    would otherwise silently skip it at Apply time);
 * 4. zero-side-effect compile of "current definition + patch applied".
 * Any violation throws the sanitized 400 WORKFLOW_PATCH_INVALID.
 */
function validateWorkflowCopilotProposal(input: {
  proposal: WorkflowRuntimeCopilotProposal;
  definition: WorkflowRuntimeDefinition;
  nodeTypes: WorkflowRuntimeNodeType[];
}): void {
  const issues: Array<{ code: string; path: (string | number)[]; message: string }> = [];
  const registryByRef = new Map(input.nodeTypes.map(nodeType => [nodeType.serviceRef, nodeType]));
  const existingIds = new Set(input.definition.nodes.map(node => node.id));
  const addedIds = new Set<string>();
  const knownEdges = new Set(input.definition.edges.map(edge => `${edge.from}\0${edge.to}`));
  for (const [index, operation] of input.proposal.patch.entries()) {
    if (operation.op === "ADD_NODE") {
      if (!registryByRef.has(operation.serviceRef)) {
        issues.push({ code: "unknown_service_ref", path: ["patch", index, "serviceRef"], message: `serviceRef '${operation.serviceRef}' is not registered in the runtime Node Registry` });
        continue;
      }
      if (existingIds.has(operation.nodeId) || addedIds.has(operation.nodeId)) {
        issues.push({ code: "duplicate_node_id", path: ["patch", index, "nodeId"], message: `Node id '${operation.nodeId}' already exists` });
        continue;
      }
      addedIds.add(operation.nodeId);
      continue;
    }
    const edgeKey = `${operation.from}\0${operation.to}`;
    if (knownEdges.has(edgeKey)) {
      issues.push({ code: "duplicate_edge", path: ["patch", index], message: `Edge '${operation.from}' → '${operation.to}' is a duplicate edge (already present in the definition or added earlier in this patch)` });
      continue;
    }
    for (const [key, endpoint] of [["from", operation.from], ["to", operation.to]] as const) {
      if (!existingIds.has(endpoint) && !addedIds.has(endpoint)) {
        issues.push({ code: "unknown_node_reference", path: ["patch", index, key], message: `Edge ${key} references unknown node '${endpoint}'` });
      }
    }
    knownEdges.add(edgeKey);
  }
  if (issues.length > 0) {
    throw new ApiError("Workflow copilot proposal references unknown registry services or nodes", "WORKFLOW_PATCH_INVALID", 400, { issues: sanitizeValidationIssues(issues) });
  }
  const nodes = [...input.definition.nodes];
  for (const operation of input.proposal.patch) {
    if (operation.op !== "ADD_NODE") continue;
    const nodeType = registryByRef.get(operation.serviceRef)!;
    nodes.push({ id: operation.nodeId, type: nodeType.type, serviceRef: nodeType.serviceRef, parameters: operation.parameters ?? {}, failurePolicy: "fail-closed" });
  }
  const candidate: WorkflowRuntimeDefinition = {
    ...input.definition,
    nodes,
    edges: [
      ...input.definition.edges,
      ...input.proposal.patch
        .filter((operation): operation is WorkflowRuntimeCopilotAddEdgeOperation => operation.op === "ADD_EDGE")
        .map(operation => ({ from: operation.from, to: operation.to }))
    ]
  };
  const compilation = compileWorkflowRuntimeDefinition(candidate);
  if (!compilation.ok) {
    throw new ApiError("Workflow copilot proposal failed canonical runtime compilation", "WORKFLOW_PATCH_INVALID", 400, { issues: sanitizeValidationIssues(compilation.errors) });
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

function requireAuditPlanner(options: CreateApiServerOptions): AuditRunPlanner {
  if (options.auditPlanner) return options.auditPlanner;
  if (options.auditStore) return new AuditRunPlanner(options.auditStore);
  throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
}

/**
 * Durable run export document (GET/POST /audit-runs/:id/export). The shape is
 * declared once in @consistency/schema (docs/output_schema.md contract) and
 * re-validated at this boundary; an unknown run keeps the canonical
 * AUDIT_RUN_NOT_FOUND 404. Counts mirror the workflow-runtime summary logic
 * without leaking evidence payloads or absolute paths.
 */
function auditExecutionForDraft(options: CreateApiServerOptions, run: Pick<import("@consistency/schema").AuditRun, "repositoryId" | "automationId">) {
  if (options.auditExecution?.enabled !== true) {
    return { available: false, reason: AUDIT_EXECUTION_DISABLED_REASON } as const;
  }
  const automation = run.automationId === undefined ? undefined : options.auditStore?.getAutomation(run.automationId);
  if (automation?.runtimeDefinitionId === undefined) {
    return { available: false, reason: AUDIT_EXECUTION_AUTOMATION_NOT_MAPPED_REASON } as const;
  }
  const repository = options.auditStore?.getRepository(run.repositoryId);
  if (repository?.source !== "local_git") {
    return { available: false, reason: AUDIT_EXECUTION_LOCAL_REPOSITORY_REQUIRED_REASON } as const;
  }
  return { available: true } as const;
}

function buildAuditRunExport(options: CreateApiServerOptions, auditRunId: string) {
  const store = options.auditStore;
  if (!store) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
  const run = store.getAuditRun(auditRunId);
  if (!run) throw new ApiError("Audit run not found", "AUDIT_RUN_NOT_FOUND", 404);
  const safeRun = {
    ...run,
    ...(run.error === undefined ? {} : { error: sanitizeExecutionError(run.error) }),
    ...(run.executionError === undefined ? {} : { executionError: sanitizeExecutionError(run.executionError) })
  };
  const automation = run.automationId === undefined ? undefined : store.getAutomation(run.automationId);
  const detail = run.workflowRuntimeRunId === undefined
    ? undefined
    : options.workflowRuntime?.getRun(run.workflowRuntimeRunId);
  const miniReport = detail?.miniReport as { findings?: unknown[]; evidenceCount?: number } | undefined;
  return auditRunExportSchema.parse(sanitizeStructuredData({
    schemaVersion: 1 as const,
    // A run export is a deterministic projection: repeated GET/POST requests
    // for the same durable run have identical bytes.
    generatedAt: run.createdAt,
    run: safeRun,
    events: store.listRunEvents(run.id).map(event => ({
      ...event,
      payload: Object.fromEntries(Object.entries(event.payload).map(([key, value]) => [
        key,
          typeof value === "string" ? sanitizeExecutionError(value) : value
      ]))
    })),
    ...(automation === undefined ? {} : { automation }),
    ...(detail === undefined ? {} : {
      workflowRuntimeRun: {
        runId: detail.runId,
        definitionId: detail.definitionId,
        revisionId: detail.revisionId,
        status: detail.status,
        createdAt: detail.createdAt,
        ...(detail.finishedAt === undefined ? {} : { finishedAt: detail.finishedAt }),
        repository: detail.snapshot.repository,
        headSha: detail.snapshot.headSha,
        findingCount: Array.isArray(miniReport?.findings) ? miniReport.findings.length : 0,
        evidenceCount: typeof miniReport?.evidenceCount === "number" ? miniReport.evidenceCount : 0,
        ...(detail.error === undefined ? {} : { error: sanitizeExecutionError(detail.error) }),
        ...(detail.trigger === undefined ? {} : { trigger: detail.trigger })
      }
    })
  }));
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
  if (error instanceof PublicPrError || error instanceof PublicRepositoryError) {
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
    // Effective review pipeline workflow name (a public-safe workflow name,
    // never a path or credential). Optional so older details stay valid.
    reviewWorkflow?: string;
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
  publicRepositoryConnect?: (input: string) => Promise<Repository>;
  publicPrAnalysisEnabled?: boolean;
  llmProviderConfigured?: boolean;
  localReview?: (input: { repoPath: string; repositoryId?: string; baseRef?: string; headRef?: string; llmProvider?: "deepseek" | "openai"; llmModel?: string }) => Promise<{ jobId: string }>;
  auditStore?: AuditDomainStore;
  auditPlanner?: AuditRunPlanner;
  automationScheduler?: { available: boolean };
  /** Executor-slice arm state from the composition root (audit execution bridge). */
  auditExecution?: { enabled: boolean };
  onAuditRepositoriesChanged?: () => Promise<void> | void;
  /** CKPT5: binding changes (enable/mode) re-arm repository supervision. */
  onWorkflowBindingsChanged?: () => Promise<void> | void;
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
  pullRequestService?: Pick<RepositoryPullRequestService, "list">;
  workflowRuntime?: WorkflowRuntimeHost;
  /** CKPT6 Phase 3: LLM provider channel for POST /workflow-runtime/copilot/proposal. */
  copilotProvider?: (resolved?: ResolvedReviewModel) => LLMProvider | undefined;
  testGitHubConnection?: (input?: GitHubConnectionTestRequest) => Promise<GitHubConnectionTestResponse>;
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
      // Executor-slice truth: computed from process wiring (executor armed ×
      // persistence), never a hard-coded promise.
      const auditExecutionAvailable = persistence
        && options.auditExecution?.enabled === true;
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
        auditExecution: auditExecutionAvailable,
        auditRunArtifacts: persistence,
        auditRunEvents: persistence,
        auditReports: persistence,
        auditExport: persistence,
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
      const repository = options.auditStore.registerLocalRepository({
        displayName: validated.displayName,
        source: "local_git",
        monitoringEnabled: validated.monitoringEnabled,
        ...(validated.remoteFullName === undefined ? {} : { remoteFullName: validated.remoteFullName }),
        ...(validated.defaultBranch === undefined ? {} : { defaultBranch: validated.defaultBranch })
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
    path: "/workflow-runtime/overview",
    auth: true,
    handler: ({ request, response, allowedOrigins, options }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      sendJson(request, response, 200, options.workflowRuntime.overview(), allowedOrigins);
    }
  },
  {
    method: "POST",
    path: "/workflow-runtime/validate",
    auth: true,
    handler: async ({ request, response, allowedOrigins }) => {
      const raw = await readJson(request);
      const definition =
        raw !== null && typeof raw === "object" && !Array.isArray(raw) && "definition" in raw
          ? (raw as { definition: unknown }).definition
          : raw;
      const compilation = compileWorkflowRuntimeDefinition(definition);
      sendJson(
        request,
        response,
        200,
        { ok: compilation.ok, errors: sanitizeValidationIssues(compilation.errors), ...(compilation.plan === undefined ? {} : { plan: compilation.plan }) },
        allowedOrigins
      );
    }
  },
  {
    method: "GET",
    path: "/workflow-runtime/definitions",
    auth: true,
    handler: ({ request, response, allowedOrigins, options }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      try {
        sendJson(request, response, 200, { definitions: options.workflowRuntime.listDefinitions() }, allowedOrigins);
      } catch (error) {
        throw mapWorkflowRuntimeError(error);
      }
    }
  },
  {
    method: "POST",
    path: "/workflow-runtime/definitions",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      const parsed = workflowRuntimeSaveDefinitionRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new ApiError(
          "Workflow definition request is invalid",
          "WORKFLOW_DEFINITION_INVALID",
          400,
          { issues: sanitizeValidationIssues(parsed.error.issues.map(issue => ({ code: "schema_invalid", path: issue.path, message: issue.message }))) }
        );
      }
      try {
        const revision = options.workflowRuntime.saveDefinition(parsed.data);
        sendJson(request, response, 201, { revision }, allowedOrigins);
      } catch (error) {
        throw mapWorkflowRuntimeError(error);
      }
    }
  },
  {
    method: "GET",
    path: /^\/workflow-runtime\/definitions\/([^/]+)\/revisions\/([^/]+)$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      try {
        const revision = options.workflowRuntime.getDefinitionRevision(
          decodeURIComponent(match?.[1] ?? ""),
          decodeURIComponent(match?.[2] ?? "")
        );
        sendJson(request, response, 200, { revision }, allowedOrigins);
      } catch (error) {
        throw mapWorkflowRuntimeError(error);
      }
    }
  },
  {
    method: "GET",
    path: /^\/workflow-runtime\/definitions\/([^/]+)\/revisions\/([^/]+)\/dry-load$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      try {
        const result = options.workflowRuntime.dryLoad(
          decodeURIComponent(match?.[1] ?? ""),
          decodeURIComponent(match?.[2] ?? "")
        );
        sendJson(request, response, 200, result, allowedOrigins);
      } catch (error) {
        throw mapWorkflowRuntimeError(error);
      }
    }
  },
  {
    method: "DELETE",
    path: /^\/workflow-runtime\/definitions\/([^/]+)$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      try {
        options.workflowRuntime.deleteDefinition(decodeURIComponent(match?.[1] ?? ""));
        sendJson(request, response, 200, { deleted: true }, allowedOrigins);
      } catch (error) {
        throw mapWorkflowRuntimeError(error);
      }
    }
  },
  {
    method: "GET",
    path: "/workflow-runtime/runs",
    auth: true,
    handler: ({ request, response, allowedOrigins, options, url }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      const limitParam = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
      try {
        sendJson(request, response, 200, { runs: options.workflowRuntime.listRuns(limit) }, allowedOrigins);
      } catch (error) {
        throw mapWorkflowRuntimeError(error);
      }
    }
  },
  {
    method: "POST",
    path: "/workflow-runtime/runs",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      const input = parseAuditInput(workflowRuntimeTriggerRequestV2Schema, await readJson(request));
      try {
        const created = await options.workflowRuntime.trigger(input);
        sendJson(request, response, 201, created, allowedOrigins);
      } catch (error) {
        throw mapWorkflowRuntimeError(error);
      }
    }
  },
  {
    method: "GET",
    path: /^\/workflow-runtime\/repositories\/([^/]+)\/bindings$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      try {
        const repositoryId = decodeURIComponent(match?.[1] ?? "");
        sendJson(request, response, 200, { bindings: options.workflowRuntime.listBindings(repositoryId) }, allowedOrigins);
      } catch (error) {
        throw mapWorkflowRuntimeError(error);
      }
    }
  },
  {
    method: "PUT",
    path: /^\/workflow-runtime\/repositories\/([^/]+)\/bindings\/([^/]+)$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      const repositoryId = decodeURIComponent(match?.[1] ?? "");
      const definitionId = decodeURIComponent(match?.[2] ?? "");
      const input = parseAuditInput(workflowRuntimeSetBindingRequestSchema, await readJson(request));
      try {
        const binding = options.workflowRuntime.setBinding({
          repositoryId,
          definitionId,
          enabled: input.enabled,
          ...(input.triggerMode === undefined ? {} : { triggerMode: input.triggerMode })
        });
        await options.onWorkflowBindingsChanged?.();
        sendJson(request, response, 200, { binding }, allowedOrigins);
      } catch (error) {
        throw mapWorkflowRuntimeError(error);
      }
    }
  },
  {
    method: "POST",
    path: /^\/workflow-runtime\/repositories\/([^/]+)\/runs$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      const repositoryId = decodeURIComponent(match?.[1] ?? "");
      const input = parseAuditInput(workflowRuntimeRepositoryTriggerRequestSchema, await readJson(request));
      try {
        const created = await options.workflowRuntime.triggerBinding({ repositoryId, definitionId: input.definitionId });
        sendJson(request, response, 201, created, allowedOrigins);
      } catch (error) {
        throw mapWorkflowRuntimeError(error);
      }
    }
  },
  {
    method: "GET",
    path: /^\/workflow-runtime\/repositories\/([^/]+)\/runs$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match, url }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      const repositoryId = decodeURIComponent(match?.[1] ?? "");
      const limitParam = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
      try {
        sendJson(request, response, 200, { runs: options.workflowRuntime.listRunsForRepository(repositoryId, limit) }, allowedOrigins);
      } catch (error) {
        throw mapWorkflowRuntimeError(error);
      }
    }
  },
  {
    method: "GET",
    path: /^\/workflow-runtime\/runs\/([^/]+)$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      try {
        const run = options.workflowRuntime.getRun(decodeURIComponent(match?.[1] ?? ""));
        if (!run) throw new ApiError("Workflow run not found", "WORKFLOW_RUN_NOT_FOUND", 404);
        sendJson(request, response, 200, run, allowedOrigins);
      } catch (error) {
        throw mapWorkflowRuntimeError(error);
      }
    }
  },
  {
    // CKPT6 Phase 3: Workflow Copilot proposal (structured WorkflowPatch).
    // Pure advisor: zero persistence, zero run/dry-load side effects, zero
    // authorization. Human Apply goes through the Studio reducer + canonical
    // validate → save-revision gates; the LLM can never bypass the compiler.
    method: "POST",
    path: "/workflow-runtime/copilot/proposal",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options }) => {
      if (!options.workflowRuntime) throw new ApiError("Workflow runtime is unavailable", "WORKFLOW_RUNTIME_UNAVAILABLE", 503);
      if (options.llmProviderConfigured === false) {
        throw new ApiError(
          "尚未配置大语言模型。ConsistenCy 需要配置真实 LLM Provider (DeepSeek 或 OpenAI) 后才能生成工作流提案。请前往设置页配置。",
          "LLM_NOT_CONFIGURED",
          503
        );
      }
      const parsed = workflowRuntimeCopilotProposalRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new ApiError("Workflow copilot proposal request is invalid", "WORKFLOW_PATCH_INVALID", 400, {
          issues: sanitizeValidationIssues(parsed.error.issues.map(issue => ({ code: "schema_invalid", path: issue.path, message: issue.message })))
        });
      }
      // Base definition: inline body XOR the latest persisted revision of a
      // definitionId; host/store failures keep their sanitized mapping.
      let baseDefinition: WorkflowRuntimeDefinition;
      try {
        if (parsed.data.definition) {
          baseDefinition = parsed.data.definition;
        } else if (parsed.data.definitionId) {
          const summary = options.workflowRuntime.listDefinitions().find(item => item.definitionId === parsed.data.definitionId);
          if (!summary?.latestRevisionId) throw new ApiError("Workflow definition not found", "WORKFLOW_DEFINITION_NOT_FOUND", 404);
          baseDefinition = options.workflowRuntime.getDefinitionRevision(parsed.data.definitionId, summary.latestRevisionId).definition;
        } else {
          throw new ApiError("Workflow copilot proposal request is invalid", "WORKFLOW_PATCH_INVALID", 400);
        }
      } catch (error) {
        throw mapWorkflowRuntimeError(error);
      }
      let resolvedModel: ResolvedReviewModel | undefined;
      if (options.resolveReviewModel) {
        try {
          resolvedModel = options.resolveReviewModel();
        } catch (error) {
          if (error instanceof ReviewModelResolutionError) {
            throw new ApiError(error.message, error.code, error.code === "INVALID_REVIEW_MODEL" ? 400 : 503);
          }
          throw error;
        }
      }
      const provider = options.copilotProvider?.(resolvedModel);
      if (!provider) {
        throw new ApiError(
          "尚未配置大语言模型。ConsistenCy 需要配置真实 LLM Provider (DeepSeek 或 OpenAI) 后才能生成工作流提案。请前往设置页配置。",
          "LLM_NOT_CONFIGURED",
          503
        );
      }
      const nodeTypes = listWorkflowNodeTypes();
      const proposal = await generateWorkflowCopilotProposal(provider, {
        instruction: parsed.data.instruction,
        definition: baseDefinition,
        nodeTypes
      });
      // Fail-closed hallucination detection BEFORE anything reaches the client.
      validateWorkflowCopilotProposal({ proposal, definition: baseDefinition, nodeTypes });
      const definitionFingerprint = createHash("sha256").update(canonicalJson(baseDefinition)).digest("hex");
      sendJson(request, response, 200, workflowRuntimeCopilotProposalResponseSchema.parse({
        proposal: { ...proposal, basis: { definitionFingerprint } }
      }), allowedOrigins);
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
    path: "/repositories/connect-public",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      if (!options.publicRepositoryConnect) {
        throw new ApiError("Public repository connection is unavailable", "PUBLIC_REPOSITORY_CONNECTION_UNAVAILABLE", 503);
      }
      const parsedBody = z.object({ input: z.string().max(500) }).strict().safeParse(await readJson(request));
      if (!parsedBody.success) {
        throw new PublicRepositoryError(
          "Enter owner/repository or a canonical GitHub URL",
          "PUBLIC_REPOSITORY_INVALID_INPUT",
          400
        );
      }
      const repository = await options.publicRepositoryConnect(parsedBody.data.input);
      sendJson(request, response, 200, { repository }, allowedOrigins);
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
      if (input.source === "github") {
        throw new ApiError(
          "GitHub repositories must be verified through the public connection endpoint",
          "GITHUB_REPOSITORY_VERIFICATION_REQUIRED",
          422
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
        const [branchResult, headShaResult, diffResult, untrackedResult, remotesResult] = await Promise.allSettled([
          vcs.getCurrentBranch(),
          vcs.getHeadSha(),
          vcs.getWorkingDiff(),
          vcs.getUntrackedFiles(),
          vcs.getRemotes()
        ] as const);
        if (diffResult.status === "rejected" || untrackedResult.status === "rejected") {
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
          return;
        }
        const branch = fulfilledValue(branchResult);
        const headSha = fulfilledValue(headShaResult);
        const remotes = fulfilledValue(remotesResult) ?? [];
        const rendererRemotes = remotes.map(toRendererGitRemote);
        sendJson(request, response, 200, {
          repositoryId,
          available: true,
          branch: branch ?? null,
          headSha: headSha ?? null,
          dirtyFileCount: diffResult.value.length,
          untrackedFileCount: untrackedResult.value.length,
          changedFiles: diffResult.value,
          untrackedFiles: untrackedResult.value,
          remotes: rendererRemotes,
          ...(rendererRemotes[0] === undefined ? {} : { primaryRemote: rendererRemotes[0] })
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
      if (!localPath) {
        sendJson(request, response, 200, {
          repositoryId,
          available: false,
          reason: "local repository path unavailable",
          commits: []
        }, allowedOrigins);
        return;
      }
      try {
        const vcs = new LocalGitAdapter({ root: localPath });
        const commits = await vcs.getCommitHistory(depth);
        sendJson(request, response, 200, {
          repositoryId,
          available: true,
          commits
        }, allowedOrigins);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        sendJson(request, response, 200, {
          repositoryId,
          available: false,
          reason: "unable to read commit history",
          commits: []
        }, allowedOrigins);
      }
    }
  },
  {
    method: "GET",
    path: /^\/repositories\/([^/]+)\/pull-requests$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, jobs, match }) => {
      const repositoryId = decodeURIComponent(match?.[1] ?? "");
      const registered = options.auditStore?.getRepository(repositoryId);
      if (!registered) {
        throw new ApiError("Repository not found", "REPOSITORY_NOT_FOUND", 404);
      }
      const localPath = resolveLocalPathForRepository(repositoryId, options);
      const input: RepositoryPullRequestRequest = {
        repositoryId,
        ...(registered.remoteFullName === undefined ? {} : { registeredRemoteFullName: registered.remoteFullName }),
        registeredSource: registered.source,
        ...(localPath === undefined ? {} : { localPath })
      };
      const service = options.pullRequestService ?? new RepositoryPullRequestService({
        jobs,
        listRemotes: async localPath => new LocalGitAdapter({ root: localPath }).getRemotes()
      });
      const servicePayload = await service.list(input);
      const parsedPayload = repositoryPullRequestsResponseSchema.safeParse(servicePayload);
      if (!parsedPayload.success) {
        throw new ApiError(
          "Pull request history response is unavailable",
          "PULL_REQUEST_HISTORY_RESPONSE_INVALID",
          502
        );
      }
      sendJson(request, response, 200, parsedPayload.data, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/repositories\/([^/]+)\/review-preparation$/,
    auth: true,
    handler: async ({ request, response, allowedOrigins, options, match }) => {
      const repositoryId = decodeURIComponent(match?.[1] ?? "");
      const repo = options.auditStore?.getRepository(repositoryId);
      const localPath = resolveLocalPathForRepository(repositoryId, options);

      if (!repo) {
        throw new ApiError("Repository not found", "REPOSITORY_NOT_FOUND", 404);
      }

      const id = repo.id;
      const displayName = repo.displayName;
      const sourceKind = repo.source;
      const trust = repo.trustLevel;

      let workingTree = {
        available: false,
        reason: undefined as string | undefined,
        changedFileCount: 0
      };
      let branchSource = {
        available: false,
        base: undefined as string | undefined,
        head: undefined as string | undefined,
        reason: undefined as string | undefined
      };

      if (localPath) {
        try {
          const vcs = new LocalGitAdapter({ root: localPath });
          const [branch, headSha, diff] = await Promise.all([
            vcs.getCurrentBranch().catch(() => undefined),
            vcs.getHeadSha().catch(() => undefined),
            vcs.getWorkingDiff().catch(() => [])
          ]);
          const dirtyCount = diff.length;
          workingTree = {
            available: dirtyCount > 0,
            reason: dirtyCount === 0 ? "工作区无未提交变更" : undefined,
            changedFileCount: dirtyCount
          };
          const trunkRef = await vcs.resolveTrunkRef().catch(() => undefined);
          const onTrunk =
            branch !== undefined &&
            (branch === trunkRef || (trunkRef === undefined && (branch === "main" || branch === "master")));
          branchSource = onTrunk
            ? {
                available: false,
                base: undefined,
                head: branch,
                reason: "当前处于主分支，无法自动对比分支差异"
              }
            : trunkRef === undefined
              ? {
                  available: false,
                  base: undefined,
                  head: branch ?? undefined,
                  reason: "无法确定基准分支"
                }
              : {
                  available: Boolean(branch),
                  base: trunkRef,
                  head: branch ?? undefined,
                  reason: branch ? undefined : "未检测到有效分支"
                };
        } catch {
          workingTree = {
            available: false,
            reason: "无法读取本地 Git 状态",
            changedFileCount: 0
          };
          branchSource = {
            available: false,
            base: undefined,
            head: undefined,
            reason: "无法读取本地 Git 分支"
          };
        }
      } else {
        workingTree = {
          available: false,
          reason: "远程仓库不支持工作区变更审查",
          changedFileCount: 0
        };
        branchSource = {
          available: false,
          base: undefined,
          head: undefined,
          reason: "远程仓库请使用 Pull Request 审查"
        };
      }

      const allJobs = options.jobs?.list() ?? [];
      const prJobs = allJobs.filter(job =>
        job.repository === repositoryId ||
        job.repository === repo.remoteFullName
      );
      const prSource = {
        available: prJobs.length > 0 || sourceKind === "github",
        pullRequestCount: prJobs.length,
        reason: (prJobs.length === 0 && sourceKind !== "github") ? "未检测到 Pull Request" : undefined
      };

      const health = options.healthDetails?.();
      const settings = options.settings?.get();
      const deepseekConfigured = health?.llmCapabilities?.deepseek?.configured === true;
      const openaiConfigured = health?.llmCapabilities?.openai?.configured === true;
      const activeProvider = health?.llmProvider === "deepseek" || health?.llmProvider === "openai"
        ? health.llmProvider
        : undefined;
      const hasConfiguredLlm = activeProvider !== undefined;
      const defaultModelName = activeProvider === "openai"
        ? health?.llmModel ?? health?.llmCapabilities?.openai?.defaultModel ?? "gpt-4.1-mini"
        : activeProvider === "deepseek"
          ? health?.llmModel ?? health?.llmCapabilities?.deepseek?.defaultModel ?? "deepseek-v4-flash"
          : "";
      const pendingProvider = settings?.llm.provider === "deepseek" || settings?.llm.provider === "openai"
        ? settings.llm.provider
        : undefined;
      const pendingRestart = settings?.restartRequired === true && pendingProvider
        ? {
            provider: pendingProvider,
            model: pendingProvider === "deepseek" ? settings.llm.deepseekModel : settings.llm.openaiModel,
            credentialConfigured: pendingProvider === "deepseek"
              ? settings.llm.deepseekApiKeyConfigured
              : settings.llm.openaiApiKeyConfigured
          }
        : null;

      const blockingReasons: string[] = [];
      if (!hasConfiguredLlm) {
        blockingReasons.push(pendingRestart
          ? `已保存 ${pendingRestart.provider === "deepseek" ? "DeepSeek" : "OpenAI"} 配置，重启 API 后生效。`
          : "尚未配置大语言模型 (DeepSeek 或 OpenAI)。请前往设置页配置。");
      }
      if (!workingTree.available && !branchSource.available && !prSource.available) {
        blockingReasons.push("当前无可用的审查来源 (工作区无变更且未检测到分支差异)");
      }

      const canStartReview = blockingReasons.length === 0;

      const payload = reviewPreparationResponseSchema.parse({
        repository: {
          id,
          displayName,
          sourceKind,
          trust
        },
        sources: {
          workingTree,
          branch: branchSource,
          pullRequest: prSource
        },
        model: {
          default: {
            provider: activeProvider ?? "none",
            model: defaultModelName
          },
          providers: {
            deepseek: {
              configured: deepseekConfigured,
              defaultModel: health?.llmCapabilities?.deepseek?.defaultModel ?? "deepseek-v4-flash"
            },
            openai: {
              configured: openaiConfigured,
              defaultModel: health?.llmCapabilities?.openai?.defaultModel ?? "gpt-4.1-mini"
            }
          },
          pendingRestart
        },
        canStartReview,
        blockingReasons
      });

      sendJson(request, response, 200, payload, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: /^\/repositories\/([^/]+)\/reviews$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, jobs, match, url }) => {
      const repositoryId = decodeURIComponent(match?.[1] ?? "");
      if (!options.auditStore?.getRepository(repositoryId)) {
        throw new ApiError("Repository not found", "REPOSITORY_NOT_FOUND", 404);
      }
      const limitParam = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.trunc(limitParam), REPOSITORY_REVIEWS_MAX_LIMIT)
        : undefined;
      // ONLY canonically associated jobs (repository_id matches); legacy
      // unassociated jobs never appear via name inference (CKPT3 Phase 4 / D1).
      let storedReviews: ReviewJob[];
      try {
        storedReviews = jobs.listJobsForRepository(repositoryId, limit);
      } catch {
        throw new ApiError("Review history is unavailable", "REVIEWS_UNAVAILABLE", 503);
      }
      let payload;
      try {
        payload = repositoryReviewsResponseSchema.parse({
          repositoryId,
          reviews: storedReviews.map(toApiJob)
        });
      } catch {
        throw new ApiError(
          "Repository review history response is unavailable",
          "REPOSITORY_REVIEWS_RESPONSE_INVALID",
          500
        );
      }
      sendJson(request, response, 200, payload, allowedOrigins);
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
        execution: auditExecutionForDraft(options, auditRun)
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
    handler: ({ request, response, allowedOrigins, options, match }) => {
      if (!options.auditStore) throw new ApiError("Audit persistence is unavailable", "AUDIT_DOMAIN_UNAVAILABLE", 503);
      const auditRunId = decodeURIComponent(match?.[1] ?? "");
      // listRunEvents asserts run existence; the explicit check keeps the
      // canonical AUDIT_RUN_NOT_FOUND semantics identical across audit routes.
      if (!options.auditStore.getAuditRun(auditRunId)) throw new ApiError("Audit run not found", "AUDIT_RUN_NOT_FOUND", 404);
      sendJson(request, response, 200, auditRunEventsResponseSchema.parse({
        events: options.auditStore.listRunEvents(auditRunId)
      }), allowedOrigins);
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
    handler: ({ request, response, allowedOrigins, options, match }) => {
      sendJson(request, response, 200, buildAuditRunExport(options, decodeURIComponent(match?.[1] ?? "")), allowedOrigins);
    }
  },
  {
    method: "POST",
    path: /^\/audit-runs\/([^/]+)\/export$/,
    auth: true,
    handler: ({ request, response, allowedOrigins, options, match }) => {
      // Export is read-only; POST exists for clients that must fetch via POST.
      sendJson(request, response, 200, buildAuditRunExport(options, decodeURIComponent(match?.[1] ?? "")), allowedOrigins);
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
          throw new ApiError("A valid repository identity is required", "INVALID_LOCAL_REVIEW_REQUEST", 400);
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

      const targetPath = resolveLocalPathForRepository(body.repositoryId, options);
      if (!targetPath) {
        throw new ApiError("The requested local repository could not be found or is not registered", "LOCAL_REPOSITORY_NOT_FOUND", 404);
      }

      let result: { jobId: string };
      try {
        result = await options.localReview({
          repoPath: targetPath,
          repositoryId: body.repositoryId,
          baseRef: body.baseRef,
          headRef: body.headRef,
          llmProvider: resolvedModel?.provider,
          llmModel: resolvedModel?.model
        });
      } catch (error: any) {
        if (
          error instanceof LocalTriggerError ||
          error?.name === "LocalTriggerError" ||
          error?.code === "PATH_NOT_ALLOWED" ||
          error?.code === "NOTHING_TO_REVIEW" ||
          error?.code === "NOT_A_REPOSITORY"
        ) {
          const code = error.code ?? "LOCAL_REVIEW_ERROR";
          const status = code === "PATH_NOT_ALLOWED"
            ? 403
            : code === "NOTHING_TO_REVIEW" ? 409 : 400;
          throw new ApiError(error.message, code, status);
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
        llmConfigured: options.llmProviderConfigured !== false,
        repositoryStore: options.auditStore
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
            : { publishWorkerConcurrency: details.configuration.publishWorkerConcurrency }),
          ...(details.configuration.reviewWorkflow === undefined
            ? {}
            : { reviewWorkflow: details.configuration.reviewWorkflow })
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
    method: "POST",
    path: "/settings/github/test-connection",
    auth: true,
    handler: async ({ request, response, allowedOrigins, options }) => {
      // CKPT4 Phase 2C: a strict-schema body may carry one unsaved draft PAT
      // to probe instead of the ACTIVE runtime credential; an empty body or a
      // missing field keeps probing the ACTIVE credential. The draft exists
      // only for this request and is never persisted, logged, or echoed back;
      // every response still flows through the sanitized
      // githubConnectionTestResponseSchema 502 path below.
      const draft = githubConnectionTestRequestSchema.parse(await readJson(request));
      if (!options.testGitHubConnection) {
        throw new ApiError("GitHub connection test is unavailable", "GITHUB_CONNECTION_TEST_UNAVAILABLE", 503);
      }
      let result: GitHubConnectionTestResponse;
      try {
        result = await options.testGitHubConnection(draft);
      } catch {
        throw new ApiError("GitHub connection test is unavailable", "GITHUB_CONNECTION_TEST_FAILED", 502);
      }
      const parsed = githubConnectionTestResponseSchema.safeParse(result);
      if (!parsed.success) {
        throw new ApiError(
          "GitHub connection test response is unavailable",
          "GITHUB_CONNECTION_TEST_RESPONSE_INVALID",
          502
        );
      }
      sendJson(request, response, 200, parsed.data, allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/catalog/review-pipeline",
    auth: true,
    handler: ({ request, response, allowedOrigins }) => {
      sendJson(request, response, 200, reviewPipelineCatalogResponseSchema.parse({
        pipeline: buildReviewPipelineCatalog()
      }), allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/catalog/kernel-syscalls",
    auth: true,
    handler: ({ request, response, allowedOrigins }) => {
      sendJson(request, response, 200, kernelSyscallCatalogResponseSchema.parse({
        catalog: buildKernelSyscallCatalog()
      }), allowedOrigins);
    }
  },
  {
    method: "GET",
    path: "/catalog/engine-allowlist",
    auth: true,
    handler: ({ request, response, allowedOrigins, options }) => {
      if (options.workflows) {
        const builtin = options.workflows.list()
          .filter(summary => summary.source === "builtin")
          .map(summary => ({ name: summary.name, ...(summary.description === undefined ? {} : { description: summary.description }) }));
        sendJson(request, response, 200, engineAllowlistCatalogResponseSchema.parse({
          catalog: buildEngineAllowlistCatalog(builtin, { runtimeVerification: options.workflowRuntime?.hasVerificationReceipt.bind(options.workflowRuntime) })
        }), allowedOrigins);
        return;
      }
      // Workflow store unconfigured: the static allowlist stays truthful while
      // the builtin workflow names are reported as unavailable — never guessed.
      sendJson(request, response, 200, engineAllowlistCatalogResponseSchema.parse({
        catalog: buildEngineAllowlistCatalog([], { builtinWorkflowsUnavailable: true, runtimeVerification: options.workflowRuntime?.hasVerificationReceipt.bind(options.workflowRuntime) })
      }), allowedOrigins);
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
