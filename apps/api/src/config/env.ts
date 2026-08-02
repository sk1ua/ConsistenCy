import { resolve } from "node:path";
import { z } from "zod";

const optionalSecret = z.preprocess(
  value => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional()
);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DATABASE_PATH: z.string().trim().min(1).default(".consistency/consistency.db"),
  CONSISTENCY_WORKSPACE_ROOT: z.string().trim().min(1).default(".consistency/workspaces"),
  CONSISTENCY_PYTHON_PATH: z.string().trim().min(1).default("python"),
  CONSISTENCY_ENGINE_MODULE: z.string().trim().min(1).default("engine"),
  CONSISTENCY_ENGINE_ROOT: z.string().trim().min(1).optional(),
  LLM_PROVIDER: z.enum(["mock", "deepseek", "openai"]).optional(),
  CONSISTENCY_WORKERS_ENABLED: z
    .enum(["true", "false"])
    .transform(value => value === "true")
    .default("true"),
  CONSISTENCY_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  CONSISTENCY_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
  CONSISTENCY_PUBLISH_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  CONSISTENCY_PUBLISH_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
  CONSISTENCY_PUBLISH_LEASE_DURATION_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  CONSISTENCY_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  CONSISTENCY_PUBLISH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  CONSISTENCY_API_TOKEN: optionalSecret,
  CONSISTENCY_ALLOWED_ORIGINS: z.string().trim().default("http://127.0.0.1:5173,http://localhost:5173"),
  CONSISTENCY_WEB_URL: z.string().url().default("http://127.0.0.1:5173"),
  CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED: z.enum(["true", "false"]).default("true"),
  CONSISTENCY_NOTEBOOK_ENABLED: z.enum(["true", "false"]).default("true"),
  CONSISTENCY_NOTEBOOK_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(32).default(8),
  CONSISTENCY_NOTEBOOK_MAX_CONTEXT_TOKENS: z.coerce.number().int().min(1_000).max(64_000).default(16_000),
  CONSISTENCY_NOTEBOOK_INDEX_MAX_BYTES: z.coerce.number().int().min(1_024 * 1_024).max(512 * 1_024 * 1_024).default(64 * 1_024 * 1_024),
  GITHUB_APP_ID: optionalSecret,
  GITHUB_PRIVATE_KEY: optionalSecret,
  GITHUB_WEBHOOK_SECRET: optionalSecret,
  GITHUB_PUBLIC_READ_TOKEN: optionalSecret,
  DEEPSEEK_API_KEY: optionalSecret,
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().trim().min(1).default("deepseek-v4-flash"),
  OPENAI_API_KEY: optionalSecret,
  OPENAI_MODEL: z.string().trim().min(1).default("gpt-4.1-mini")
});

export type RawEnvironment = z.input<typeof envSchema>;

export type AppConfig = Omit<z.output<typeof envSchema>, "DATABASE_PATH" | "CONSISTENCY_WORKSPACE_ROOT" | "CONSISTENCY_ALLOWED_ORIGINS" | "LLM_PROVIDER" | "CONSISTENCY_ENGINE_ROOT"> & {
  databasePath: string;
  workspaceRoot: string;
  engineRoot?: string;
  allowedOrigins: string[];
  LLM_PROVIDER: "mock" | "deepseek" | "openai";
  publicPrAnalysisEnabled: boolean;
  notebookEnabled: boolean;
};

export function loadEnv(input: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(input);
  const hasAppId = Boolean(parsed.GITHUB_APP_ID);
  const hasPrivateKey = Boolean(parsed.GITHUB_PRIVATE_KEY);
  if (hasAppId !== hasPrivateKey) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be configured together");
  }
  const githubAppConfigured = hasAppId && hasPrivateKey;
  if (parsed.NODE_ENV === "production" && !parsed.CONSISTENCY_API_TOKEN) {
    throw new Error("CONSISTENCY_API_TOKEN is required in production");
  }
  if (parsed.NODE_ENV === "production" && githubAppConfigured && !parsed.GITHUB_WEBHOOK_SECRET) {
    throw new Error("GITHUB_WEBHOOK_SECRET is required when GitHub App mode is enabled in production");
  }
  if (parsed.NODE_ENV === "production" && !githubAppConfigured && parsed.GITHUB_WEBHOOK_SECRET) {
    throw new Error("GITHUB_WEBHOOK_SECRET requires GitHub App credentials");
  }
  const llmProvider = parsed.LLM_PROVIDER ?? (parsed.DEEPSEEK_API_KEY ? "deepseek" : "mock");
  if (llmProvider === "deepseek" && !parsed.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required when LLM_PROVIDER=deepseek");
  }
  if (llmProvider === "openai" && !parsed.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
  }
  const allowedOrigins = parsed.CONSISTENCY_ALLOWED_ORIGINS.split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
  if (parsed.NODE_ENV === "production" && (allowedOrigins.length === 0 || allowedOrigins.includes("*"))) {
    throw new Error("CONSISTENCY_ALLOWED_ORIGINS must contain explicit origins in production");
  }
  const publicPrAnalysisEnabled = parsed.NODE_ENV === "production"
    ? input.CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED === "true"
    : parsed.CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED === "true";
  const notebookEnabled = parsed.NODE_ENV === "production"
    ? input.CONSISTENCY_NOTEBOOK_ENABLED === "true"
    : parsed.CONSISTENCY_NOTEBOOK_ENABLED === "true";
  return {
    ...parsed,
    LLM_PROVIDER: llmProvider,
    databasePath: resolve(parsed.DATABASE_PATH),
    workspaceRoot: resolve(parsed.CONSISTENCY_WORKSPACE_ROOT),
    engineRoot: parsed.CONSISTENCY_ENGINE_ROOT ? resolve(parsed.CONSISTENCY_ENGINE_ROOT) : undefined,
    allowedOrigins,
    publicPrAnalysisEnabled,
    notebookEnabled
  };
}
