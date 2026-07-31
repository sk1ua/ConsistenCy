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

export type RealDataSnapshot = {
  version: 1;
  importedAt: string;
  source: {
    provider: "github"; repository: string; pullRequestNumber: number; url: string; fetchedAt: string; title: string; author: string;
    state: string; createdAt: string; updatedAt: string; mergedAt: string | null; baseSha: string; headSha: string;
    commits: number; changedFiles: number; additions: number; deletions: number; reviewCount: number;
  };
  analysis: {
    reportPath: string; generatedAt: string; method: string; commitCount: number; averageRisk: number; maxRisk: number; riskScale: "0-1";
    commits: Array<{ sha: string; date: string; author: string; message: string; risk_score: number; risk_level: string; files_analyzed: number }>;
    topRiskyFiles: Array<{ file: string; avg_risk: number; max_risk: number; hits: number; churn_lines?: number; complexity?: number; owner?: string }>;
    components: Record<string, number>;
  };
  validation: {
    sourceDataset: string; labelSource: string; needsManualAudit: boolean; sampleCount: number; evaluatedCount: number; k: number;
    precisionAtK: number; recallAtK: number; goldOverallRisk: string; predictedTopFiles: string[]; goldTopFiles: string[];
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
  async settings(): Promise<SettingsSnapshot> {
    return (await request("/settings") as { settings: SettingsSnapshot }).settings;
  },
  async updateSettings(patch: SettingsPatch): Promise<SettingsSnapshot> {
    return (await request("/settings", { method: "PUT", body: JSON.stringify(patch) }) as { settings: SettingsSnapshot }).settings;
  },
  async realData(): Promise<RealDataSnapshot | undefined> {
    return (await request("/real-data") as { realData: RealDataSnapshot | null }).realData ?? undefined;
  },
  async seedDemo(): Promise<{ created: number }> {
    return await request("/demo/seed", { method: "POST", body: "{}" }) as { created: number };
  }
};
