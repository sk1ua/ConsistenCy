import {
  jobDetailResponseSchema,
  jobListResponseSchema,
  recentReportsResponseSchema,
  reportResponseSchema,
  statsResponseSchema,
  type JobStatus,
  type ReviewJob,
  type ReviewReport,
  type Severity,
  type StatsResponse
} from "@consistency/schema";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8787";
const apiToken = import.meta.env.VITE_API_TOKEN as string | undefined;

export type HealthResponse = {
  ok: boolean;
  service: string;
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
  async recentReports(limit = 10): Promise<ReviewReport[]> {
    return recentReportsResponseSchema.parse(await request(`/reports/recent?limit=${limit}`)).reports;
  },
  async stats(): Promise<StatsResponse> {
    return statsResponseSchema.parse(await request("/stats"));
  },
  async health(): Promise<HealthResponse> {
    return await request("/health") as HealthResponse;
  },
  async seedDemo(): Promise<{ created: number }> {
    return await request("/demo/seed", { method: "POST", body: "{}" }) as { created: number };
  }
};
