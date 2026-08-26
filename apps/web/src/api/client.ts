import {
  jobDetailResponseSchema,
  jobListResponseSchema,
  recentReportsResponseSchema,
  reportResponseSchema,
  statsResponseSchema,
  notebookResponseSchema,
  notebookSourcesResponseSchema,
  workflowListResponseSchema,
  workflowResponseSchema,
  jobDiffResponseSchema,
  heartbeatPulseSchema,
  heartbeatStreamEventSchema,
  auditCapabilitiesSchema,
  auditIssueSchema,
  auditRunSchema,
  automationSchema,
  evolutionSnapshotSchema,
  githubConnectionTestResponseSchema,
  repositoryEventSchema,
  repositoryPulseSchema,
  repositorySchema,
  repositoryGitStatusResponseSchema,
  repositoryCommitsResponseSchema,
  repositoryPullRequestsResponseSchema,
  repositoryReviewsResponseSchema,
  reviewPreparationResponseSchema,
  runRuntimeSnapshotSchema,
  runtimeRunsResponseSchema,
  localReviewResponseSchema,
  publicPrResponseSchema,
  type LocalReviewRequest,
  type ReviewModelOverride,
  type JobStatus,
  type Notebook,
  type NotebookCardKind,
  type ReviewJob,
  type ReviewReport,
  type RunRuntimeSnapshot,
  type RuntimeRunsResponse,
  type RepositoryGitStatusResponse,
  type RepositoryCommitsResponse,
  type RepositoryPullRequestsResponse,
  type ReviewPreparationResponse,
  type PullRequestSummary,
  type Severity,
  type StatsResponse,
  type HeartbeatPulse,
  type HeartbeatStreamEvent,
  type WorkflowResponse,
  type WorkflowSpec,
  type WorkflowSummary,
  type WorkflowRuntimeDefinition,
  type WorkflowRuntimeNodeType,
  type WorkflowRuntimeDefinitionSummary,
  type WorkflowRuntimeDefinitionRevision,
  type WorkflowRuntimeDryLoadResult,
  type WorkflowRuntimeBinding,
  type WorkflowRuntimeRun,
  type WorkflowRuntimeRunSummary,
  type WorkflowRuntimeRunV2,
  type WorkflowRuntimeValidationResult,
  type JobDiffResponse,
  type AuditCapabilities,
  type Automation,
  type Repository,
  type AuditIssue,
  type AuditRun,
  type EvolutionSnapshot,
  type GitHubConnectionTestResponse,
  type RepositoryEvent,
  type RepositoryPulse
} from "@consistency/schema";

// The renderer always talks to a same-origin capability broker. In browser
// development Vite proxies `/api`; Electron serves the same path from its
// restricted `consistency://app` protocol and injects its one-time token in
// the main process. Secrets must never be compiled into this bundle.
const apiBaseUrl = "/api";

export type HealthResponse = {
  ok: boolean;
  service: string;
  // The /health payload also carries the deterministic engine kind and the
  // shared protocol version; both are delivered passthrough (no zod schema on
  // this route) and stay optional so older payloads remain valid.
  engine?: string;
  schemaVersion?: string;
  database: { ok: boolean };
  worker: { running: boolean; activeJobs: number; concurrency: number; lastPollAt?: string };
  deterministicAnalyzer?: { running: boolean; generation: number; pendingCount: number };
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
    // Effective review pipeline workflow name; optional because older API
    // payloads predate the field and the Reviews section degrades to
    // "not reported" without it.
    reviewWorkflow?: string;
  };
};

export type SettingsSnapshot = {
  llm: {
    provider?: "deepseek" | "openai" | "none";
    deepseekBaseUrl: string;
    deepseekModel: string;
    openaiModel: string;
    deepseekApiKeyConfigured: boolean;
    openaiApiKeyConfigured: boolean;
  };
  github: {
    appId: string;
    privateKeyConfigured: boolean;
    webhookSecretConfigured: boolean;
    publicReadTokenConfigured: boolean;
  };
  runtime: {
    storage: { kind: "memory" | "file"; configured: boolean };
    workspace: { configured: boolean };
    localReview: { configured: boolean; rootCount: number };
    workerConcurrency: number;
    workerPollIntervalMs: number;
    webUrl: string;
    apiTokenConfigured: boolean;
  };
  overriddenByEnvironment: string[];
  restartRequired: boolean;
};

export type SettingsPatch = {
  llm?: {
    provider?: SettingsSnapshot["llm"]["provider"];
    deepseekBaseUrl?: string;
    deepseekModel?: string;
    openaiModel?: string;
    deepseekApiKey?: string | null;
    openaiApiKey?: string | null;
  };
  github?: {
    appId?: string | null;
    privateKey?: string | null;
    webhookSecret?: string | null;
    publicReadToken?: string | null;
  };
  runtime?: {
    workerConcurrency?: number;
    workerPollIntervalMs?: number;
    webUrl?: string;
    apiToken?: string | null;
  };
};

export type NotebookStreamEvent = { event: string; data: unknown };

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiError = typeof payload === "object" && payload && "error" in payload
      ? (payload as { error?: { message?: string; code?: string; details?: Record<string, unknown> } }).error
      : undefined;
    throw new ApiRequestError(
      apiError?.message ?? `API request failed with ${response.status}`,
      apiError?.code ?? "API_REQUEST_FAILED",
      response.status,
      apiError?.details
    );
  }
  return payload;
}

async function* readSse(response: Response): AsyncIterable<NotebookStreamEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() ?? "message";
      const data = block.match(/^data:\s*(.+)$/m)?.[1]?.trim();
      if (!data) continue;
      try {
        yield { event, data: JSON.parse(data) };
      } catch {
        yield { event, data: { text: data } };
      }
    }
  }
}

async function openSse(path: string, payload: unknown, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify(payload),
    signal
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = typeof body === "object" && body && "error" in body
      ? (body as { error?: { message?: string } }).error?.message
      : undefined;
    throw new Error(message ?? `Notebook stream failed with ${response.status}`);
  }
  return response;
}

async function openGetSse(path: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      accept: "text/event-stream"
    },
    signal
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = typeof body === "object" && body && "error" in body
      ? (body as { error?: { message?: string } }).error?.message
      : undefined;
    throw new Error(message ?? `Heartbeat stream failed with ${response.status}`);
  }
  return response;
}

export const api = {
  async jobs(filters: { status?: JobStatus; repository?: string; severity?: Severity } = {}, signal?: AbortSignal): Promise<ReviewJob[]> {
    const query = new URLSearchParams();
    if (filters.status) query.set("status", filters.status);
    if (filters.repository) query.set("repository", filters.repository);
    if (filters.severity) query.set("severity", filters.severity);
    const suffix = query.size > 0 ? `?${query}` : "";
    return jobListResponseSchema.parse(await request(`/jobs${suffix}`, { signal })).jobs;
  },
  async job(id: string, signal?: AbortSignal): Promise<ReviewJob> {
    return jobDetailResponseSchema.parse(await request(`/jobs/${encodeURIComponent(id)}`, { signal })).job;
  },
  async report(id: string, signal?: AbortSignal): Promise<ReviewReport> {
    return reportResponseSchema.parse(await request(`/jobs/${encodeURIComponent(id)}/report`, { signal })).report;
  },
  async jobDiff(id: string, signal?: AbortSignal): Promise<JobDiffResponse> {
    return jobDiffResponseSchema.parse(await request(`/jobs/${encodeURIComponent(id)}/diff`, { signal }));
  },
  async jobNotebook(jobId: string, signal?: AbortSignal): Promise<string | null> {
    return (await request(`/jobs/${encodeURIComponent(jobId)}/notebook`, { signal }) as { notebookId: string | null }).notebookId;
  },
  async recentReports(limit = 10, signal?: AbortSignal): Promise<ReviewReport[]> {
    return recentReportsResponseSchema.parse(await request(`/reports/recent?limit=${limit}`, { signal })).reports;
  },
  async stats(signal?: AbortSignal): Promise<StatsResponse> {
    return statsResponseSchema.parse(await request("/stats", { signal }));
  },
  async health(signal?: AbortSignal): Promise<HealthResponse> {
    return await request("/health", { signal }) as HealthResponse;
  },
  async auditCapabilities(signal?: AbortSignal): Promise<AuditCapabilities> {
    return auditCapabilitiesSchema.parse(await request("/audit/capabilities", { signal }));
  },
  async repositories(signal?: AbortSignal): Promise<Repository[]> {
    const payload = await request("/repositories", { signal }) as { repositories?: unknown };
    return repositorySchema.array().parse(payload.repositories);
  },
  async connectPublicRepository(input: string): Promise<Repository> {
    const payload = await request("/repositories/connect-public", {
      method: "POST",
      body: JSON.stringify({ input })
    }) as { repository?: unknown };
    return repositorySchema.parse(payload.repository);
  },
  async setRepositoryMonitoring(repositoryId: string, enabled: boolean): Promise<Repository> {
    const payload = await request(`/repositories/${encodeURIComponent(repositoryId)}/actions/set-monitoring`, {
      method: "POST",
      body: JSON.stringify({ enabled })
    }) as { repository?: unknown };
    return repositorySchema.parse(payload.repository);
  },
  async repositoryReviews(repositoryId: string, signal?: AbortSignal): Promise<ReviewJob[]> {
    try {
      const payload = repositoryReviewsResponseSchema.parse(await request(
        `/repositories/${encodeURIComponent(repositoryId)}/reviews`,
        { signal }
      ));
      if (payload.repositoryId !== repositoryId) throw new Error("repository review identity mismatch");
      return payload.reviews;
    } catch (error) {
      if (error instanceof ApiRequestError) throw error;
      throw new ApiRequestError(
        "Repository review history response is unavailable",
        "REPOSITORY_REVIEWS_RESPONSE_INVALID",
        502
      );
    }
  },
  async repositoryTimeline(repositoryId: string, signal?: AbortSignal): Promise<{ repositoryEvents: RepositoryEvent[]; repositoryPulses: RepositoryPulse[]; auditRuns: AuditRun[] }> {
    const payload = await request(`/repositories/${encodeURIComponent(repositoryId)}/timeline`, { signal }) as {
      repositoryEvents?: unknown;
      repositoryPulses?: unknown;
      auditRuns?: unknown;
    };
    return {
      repositoryEvents: repositoryEventSchema.array().parse(payload.repositoryEvents),
      repositoryPulses: repositoryPulseSchema.array().parse(payload.repositoryPulses),
      auditRuns: auditRunSchema.array().parse(payload.auditRuns)
    };
  },
  async repositoryMetrics(repositoryId: string, signal?: AbortSignal): Promise<EvolutionSnapshot[]> {
    const payload = await request(`/repositories/${encodeURIComponent(repositoryId)}/metrics`, { signal }) as { evolutionSnapshots?: unknown };
    return evolutionSnapshotSchema.array().parse(payload.evolutionSnapshots);
  },
  async repositoryIssues(repositoryId: string, signal?: AbortSignal): Promise<AuditIssue[]> {
    const payload = await request(`/repositories/${encodeURIComponent(repositoryId)}/issues`, { signal }) as { issues?: unknown };
    return auditIssueSchema.array().parse(payload.issues);
  },
  async repositoryGitStatus(repositoryId: string, signal?: AbortSignal): Promise<RepositoryGitStatusResponse> {
    return repositoryGitStatusResponseSchema.parse(await request(`/repositories/${encodeURIComponent(repositoryId)}/git/status`, { signal }));
  },
  async repositoryCommits(repositoryId: string, depth?: number, signal?: AbortSignal): Promise<RepositoryCommitsResponse> {
    const query = depth ? `?depth=${depth}` : "";
    return repositoryCommitsResponseSchema.parse(await request(`/repositories/${encodeURIComponent(repositoryId)}/git/commits${query}`, { signal }));
  },
  async repositoryPullRequests(repositoryId: string, signal?: AbortSignal): Promise<RepositoryPullRequestsResponse> {
    return repositoryPullRequestsResponseSchema.parse(await request(`/repositories/${encodeURIComponent(repositoryId)}/pull-requests`, { signal }));
  },
  async reviewPreparation(repositoryId: string, signal?: AbortSignal): Promise<ReviewPreparationResponse> {
    return reviewPreparationResponseSchema.parse(await request(`/repositories/${encodeURIComponent(repositoryId)}/review-preparation`, { signal }));
  },
  async automations(signal?: AbortSignal): Promise<Automation[]> {
    const payload = await request("/automations", { signal }) as { automations?: unknown };
    return automationSchema.array().parse(payload.automations);
  },
  async setAutomationEnabled(automationId: string, enabled: boolean): Promise<Automation> {
    const action = enabled ? "resume" : "pause";
    const payload = await request(`/automations/${encodeURIComponent(automationId)}/${action}`, {
      method: "POST",
      body: "{}"
    }) as { automation?: unknown };
    return automationSchema.parse(payload.automation);
  },
  async heartbeat(): Promise<HeartbeatPulse | null> {
    const payload = await request("/heartbeat") as { pulse?: HeartbeatPulse | null };
    return payload.pulse === undefined || payload.pulse === null ? null : heartbeatPulseSchema.parse(payload.pulse);
  },
  async *heartbeatStream(signal?: AbortSignal): AsyncIterable<HeartbeatStreamEvent> {
    const response = await openGetSse("/heartbeat/stream", signal);
    for await (const event of readSse(response)) {
      yield heartbeatStreamEventSchema.parse(event.data);
    }
  },
  async settings(): Promise<SettingsSnapshot> {
    return (await request("/settings") as { settings: SettingsSnapshot }).settings;
  },
  async updateSettings(patch: SettingsPatch): Promise<SettingsSnapshot> {
    return (await request("/settings", { method: "PUT", body: JSON.stringify(patch) }) as { settings: SettingsSnapshot }).settings;
  },
  async testGitHubConnection(signal?: AbortSignal): Promise<GitHubConnectionTestResponse> {
    return githubConnectionTestResponseSchema.parse(await request("/settings/github/test-connection", {
      method: "POST",
      body: "{}",
      signal
    }));
  },
  async analyzePublicPr(url: string, model?: ReviewModelOverride) {
    return publicPrResponseSchema.parse(await request("/reviews/public-pr", {
      method: "POST",
      body: JSON.stringify({ url, ...(model ? { model } : {}) })
    }));
  },
  async triggerLocalReview(input: LocalReviewRequest) {
    return localReviewResponseSchema.parse(await request("/reviews/local", {
      method: "POST",
      body: JSON.stringify(input)
    }));
  },
  async notebook(id: string, signal?: AbortSignal): Promise<Notebook> {
    return notebookResponseSchema.parse(await request(`/notebooks/${encodeURIComponent(id)}`, { signal })).notebook;
  },
  async notebookSources(id: string) {
    return notebookSourcesResponseSchema.parse(await request(`/notebooks/${encodeURIComponent(id)}/sources`)).sources;
  },
  async *streamNotebookMessage(id: string, content: string, sourceJobIds?: string[], signal?: AbortSignal): AsyncIterable<NotebookStreamEvent> {
    const response = await openSse(`/notebooks/${encodeURIComponent(id)}/messages`, { content, sourceJobIds }, signal);
    yield* readSse(response);
  },
  async *streamNotebookCard(id: string, kind: NotebookCardKind, sourceJobIds: string[], signal?: AbortSignal): AsyncIterable<NotebookStreamEvent> {
    const response = await openSse(`/notebooks/${encodeURIComponent(id)}/cards`, { kind, sourceJobIds }, signal);
    yield* readSse(response);
  },
  async workflows(): Promise<WorkflowSummary[]> {
    return workflowListResponseSchema.parse(await request("/workflows")).workflows;
  },
  async workflow(name: string): Promise<WorkflowResponse> {
    return workflowResponseSchema.parse(await request(`/workflows/${encodeURIComponent(name)}`));
  },
  async saveWorkflow(spec: WorkflowSpec): Promise<WorkflowResponse> {
    return workflowResponseSchema.parse(await request(`/workflows/${encodeURIComponent(spec.name)}`, {
      method: "PUT",
      body: JSON.stringify(spec)
    }));
  },
  async deleteWorkflow(name: string): Promise<void> {
    await request(`/workflows/${encodeURIComponent(name)}`, { method: "DELETE" });
  },
  async runtimeRuns(): Promise<RuntimeRunsResponse> {
    return runtimeRunsResponseSchema.parse(await request("/runtime/runs"));
  },
  async runtimeSnapshot(runId: string, signal?: AbortSignal): Promise<RunRuntimeSnapshot> {
    return runRuntimeSnapshotSchema.parse(await request(`/runtime/runs/${encodeURIComponent(runId)}`, { signal }));
  },
  async workflowRuntimeOverview(signal?: AbortSignal): Promise<{ definition: WorkflowRuntimeDefinition; nodeTypes: WorkflowRuntimeNodeType[] }> {
    return request("/workflow-runtime/overview", { signal }) as Promise<{ definition: WorkflowRuntimeDefinition; nodeTypes: WorkflowRuntimeNodeType[] }>;
  },
  async validateWorkflowRuntime(definition: unknown, signal?: AbortSignal): Promise<WorkflowRuntimeValidationResult & { plan?: unknown }> {
    return request("/workflow-runtime/validate", {
      method: "POST",
      body: JSON.stringify({ definition }),
      signal
    }) as Promise<WorkflowRuntimeValidationResult & { plan?: unknown }>;
  },
  async triggerWorkflowRuntime(repositoryId: string, pin?: { definitionId: string; revisionId: string }): Promise<{ runId: string; status: string; revisionId: string }> {
    return request("/workflow-runtime/runs", {
      method: "POST",
      body: JSON.stringify({ repositoryId, ...(pin ?? {}) })
    }) as Promise<{ runId: string; status: string; revisionId: string }>;
  },
  async workflowRuntimeDefinitions(signal?: AbortSignal): Promise<WorkflowRuntimeDefinitionSummary[]> {
    const payload = await request("/workflow-runtime/definitions", { signal }) as { definitions: WorkflowRuntimeDefinitionSummary[] };
    return payload.definitions;
  },
  async saveWorkflowRuntimeDefinition(input: { definitionId?: string; definition: unknown }): Promise<WorkflowRuntimeDefinitionRevision> {
    const payload = await request("/workflow-runtime/definitions", {
      method: "POST",
      body: JSON.stringify(input)
    }) as { revision: WorkflowRuntimeDefinitionRevision };
    return payload.revision;
  },
  async deleteWorkflowRuntimeDefinition(definitionId: string): Promise<void> {
    await request(`/workflow-runtime/definitions/${encodeURIComponent(definitionId)}`, { method: "DELETE" });
  },
  async workflowRuntimeRevision(definitionId: string, revisionId: string, signal?: AbortSignal): Promise<WorkflowRuntimeDefinitionRevision> {
    const payload = await request(
      `/workflow-runtime/definitions/${encodeURIComponent(definitionId)}/revisions/${encodeURIComponent(revisionId)}`,
      { signal }
    ) as { revision: WorkflowRuntimeDefinitionRevision };
    return payload.revision;
  },
  async workflowRuntimeDryLoad(definitionId: string, revisionId: string, signal?: AbortSignal): Promise<WorkflowRuntimeDryLoadResult> {
    return request(
      `/workflow-runtime/definitions/${encodeURIComponent(definitionId)}/revisions/${encodeURIComponent(revisionId)}/dry-load`,
      { signal }
    ) as Promise<WorkflowRuntimeDryLoadResult>;
  },
  async workflowRuntimeRuns(limit = 20, signal?: AbortSignal): Promise<WorkflowRuntimeRunSummary[]> {
    const payload = await request(`/workflow-runtime/runs?limit=${limit}`, { signal }) as { runs: WorkflowRuntimeRunSummary[] };
    return payload.runs;
  },
  async workflowRuntimeRunV2(runId: string, signal?: AbortSignal): Promise<WorkflowRuntimeRunV2> {
    return request(`/workflow-runtime/runs/${encodeURIComponent(runId)}`, { signal }) as Promise<WorkflowRuntimeRunV2>;
  },
  async workflowRuntimeBindings(repositoryId: string, signal?: AbortSignal): Promise<WorkflowRuntimeBinding[]> {
    const payload = await request(
      `/workflow-runtime/repositories/${encodeURIComponent(repositoryId)}/bindings`,
      { signal }
    ) as { bindings: WorkflowRuntimeBinding[] };
    return payload.bindings;
  },
  async setWorkflowRuntimeBinding(
    repositoryId: string,
    definitionId: string,
    enabled: boolean,
    triggerMode?: "manual" | "on_change"
  ): Promise<WorkflowRuntimeBinding> {
    const payload = await request(
      `/workflow-runtime/repositories/${encodeURIComponent(repositoryId)}/bindings/${encodeURIComponent(definitionId)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          enabled,
          ...(triggerMode === undefined ? {} : { triggerMode })
        })
      }
    ) as { binding: WorkflowRuntimeBinding };
    return payload.binding;
  },
  async triggerWorkflowRuntimeForRepository(repositoryId: string, definitionId: string): Promise<{ runId: string; status: string; revisionId: string }> {
    return request(
      `/workflow-runtime/repositories/${encodeURIComponent(repositoryId)}/runs`,
      { method: "POST", body: JSON.stringify({ definitionId }) }
    ) as Promise<{ runId: string; status: string; revisionId: string }>;
  },
  async workflowRuntimeRunsForRepository(repositoryId: string, limit = 20, signal?: AbortSignal): Promise<WorkflowRuntimeRunSummary[]> {
    const payload = await request(
      `/workflow-runtime/repositories/${encodeURIComponent(repositoryId)}/runs?limit=${limit}`,
      { signal }
    ) as { runs: WorkflowRuntimeRunSummary[] };
    return payload.runs;
  },
  async workflowRuntimeRun(runId: string, signal?: AbortSignal): Promise<WorkflowRuntimeRun> {
    return request(`/workflow-runtime/runs/${encodeURIComponent(runId)}`, { signal }) as Promise<WorkflowRuntimeRun>;
  }
};
