import {
  jobDetailResponseSchema,
  jobListResponseSchema,
  recentReportsResponseSchema,
  reportResponseSchema,
  statsResponseSchema,
  publicPrResponseSchema,
  notebookResponseSchema,
  notebookSourcesResponseSchema,
  workflowListResponseSchema,
  workflowResponseSchema,
  jobDiffResponseSchema,
  heartbeatPulseSchema,
  heartbeatStreamEventSchema,
  type JobStatus,
  type Notebook,
  type NotebookCardKind,
  type ReviewJob,
  type ReviewReport,
  type Severity,
  type StatsResponse,
  type HeartbeatPulse,
  type HeartbeatStreamEvent,
  type WorkflowResponse,
  type WorkflowSpec,
  type WorkflowSummary,
  type JobDiffResponse
} from "@consistency/schema";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8787";
const apiToken = import.meta.env.VITE_API_TOKEN as string | undefined;

export type HealthResponse = {
  ok: boolean;
  service: string;
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

export type SettingsSnapshot = {
  llm: {
    provider: "mock" | "deepseek" | "openai";
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
    databasePath: string;
    workspaceRoot: string;
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
    databasePath?: string;
    workspaceRoot?: string;
    workerConcurrency?: number;
    workerPollIntervalMs?: number;
    webUrl?: string;
    apiToken?: string | null;
  };
};

export type NotebookStreamEvent = { event: string; data: unknown };

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
      ...init?.headers
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload
      ? (payload as { error?: { message?: string } }).error?.message
      : undefined;
    throw new Error(message ?? `API request failed with ${response.status}`);
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

async function openSse(path: string, payload: unknown): Promise<Response> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {})
    },
    body: JSON.stringify(payload)
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
      accept: "text/event-stream",
      ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {})
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
  async jobs(filters: { status?: JobStatus; repository?: string; severity?: Severity } = {}): Promise<ReviewJob[]> {
    const query = new URLSearchParams();
    if (filters.status) query.set("status", filters.status);
    if (filters.repository) query.set("repository", filters.repository);
    if (filters.severity) query.set("severity", filters.severity);
    const suffix = query.size > 0 ? `?${query}` : "";
    return jobListResponseSchema.parse(await request(`/jobs${suffix}`)).jobs;
  },
  async job(id: string): Promise<ReviewJob> {
    return jobDetailResponseSchema.parse(await request(`/jobs/${encodeURIComponent(id)}`)).job;
  },
  async report(id: string): Promise<ReviewReport> {
    return reportResponseSchema.parse(await request(`/jobs/${encodeURIComponent(id)}/report`)).report;
  },
  async jobDiff(id: string): Promise<JobDiffResponse> {
    return jobDiffResponseSchema.parse(await request(`/jobs/${encodeURIComponent(id)}/diff`));
  },
  async jobNotebook(jobId: string): Promise<string | null> {
    return (await request(`/jobs/${encodeURIComponent(jobId)}/notebook`) as { notebookId: string | null }).notebookId;
  },
  async recentReports(limit = 10): Promise<ReviewReport[]> {
    return recentReportsResponseSchema.parse(await request(`/reports/recent?limit=${limit}`)).reports;
  },
  async stats(): Promise<StatsResponse> {
    return statsResponseSchema.parse(await request("/stats"));
  },
  async health(): Promise<HealthResponse> {
    return await request("/health") as HealthResponse;
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
  async seedDemo(): Promise<{ created: number; notebooks?: Array<{ jobId: string; notebookId: string }> }> {
    return await request("/demo/seed", { method: "POST", body: "{}" }) as { created: number; notebooks?: Array<{ jobId: string; notebookId: string }> };
  },
  async analyzePublicPr(url: string) {
    return publicPrResponseSchema.parse(await request("/reviews/public-pr", { method: "POST", body: JSON.stringify({ url }) }));
  },
  async notebook(id: string): Promise<Notebook> {
    return notebookResponseSchema.parse(await request(`/notebooks/${encodeURIComponent(id)}`)).notebook;
  },
  async notebookSources(id: string) {
    return notebookSourcesResponseSchema.parse(await request(`/notebooks/${encodeURIComponent(id)}/sources`)).sources;
  },
  async *streamNotebookMessage(id: string, content: string, sourceJobIds?: string[]): AsyncIterable<NotebookStreamEvent> {
    const response = await openSse(`/notebooks/${encodeURIComponent(id)}/messages`, { content, sourceJobIds });
    yield* readSse(response);
  },
  async *streamNotebookCard(id: string, kind: NotebookCardKind, sourceJobIds: string[]): AsyncIterable<NotebookStreamEvent> {
    const response = await openSse(`/notebooks/${encodeURIComponent(id)}/cards`, { kind, sourceJobIds });
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
  }
};
