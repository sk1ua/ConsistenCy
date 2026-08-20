import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { findProjectRoot } from "./settings";

export function resolveDatabasePath(inputPath: string, root = findProjectRoot()): string {
  if (inputPath === ":memory:") return ":memory:";
  if (isAbsolute(inputPath)) return inputPath;
  return resolve(root, inputPath);
}

export function resolveWorkspaceRoot(inputPath: string, root = findProjectRoot()): string {
  if (isAbsolute(inputPath)) return inputPath;
  return resolve(root, inputPath);
}

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
  /**
   * Comma-separated directories under which a local checkout may be reviewed.
   * Defaults to the project's parent directory, which makes every sibling
   * repository reviewable — narrow this before exposing the API off localhost.
   */
  CONSISTENCY_LOCAL_REVIEW_ROOTS: z.string().trim().optional(),
  CONSISTENCY_PYTHON_PATH: z.string().trim().min(1).default("python"),
  CONSISTENCY_ENGINE_MODULE: z.string().trim().min(1).default("engine"),
  CONSISTENCY_ENGINE_ROOT: z.string().trim().min(1).optional(),
  LLM_PROVIDER: z.enum(["deepseek", "openai"]).optional(),
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
  /** The daemon reads a live working tree. Defaults to enabled in development; production stays opt-in. */
  CONSISTENCY_HEARTBEAT_ENABLED: z.enum(["true", "false"]).default("false"),
  CONSISTENCY_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
  CONSISTENCY_AUTOMATION_SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  /**
   * Workflow backing the deterministic review stage. Set to "legacy" to fall
   * back to the single-shot `analyze` action.
   */
  CONSISTENCY_REVIEW_WORKFLOW: z.string().trim().min(1).default("pr-review"),
  CONSISTENCY_API_TOKEN: optionalSecret,
  CONSISTENCY_DESKTOP_CONTROL_TOKEN: optionalSecret,
  CONSISTENCY_ALLOWED_ORIGINS: z.string().trim().default("http://127.0.0.1:5173,http://localhost:5173"),
  CONSISTENCY_WEB_URL: z.string().url().default("http://127.0.0.1:5173"),
  CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED: z.enum(["true", "false"]).default("true"),
  CONSISTENCY_REPORT_LANGUAGE: z.enum(["zh-CN", "en-US"]).default("zh-CN"),
  CONSISTENCY_SETTINGS_WRITABLE: z.enum(["true", "false"]).optional(),
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

export type AppConfig = Omit<z.output<typeof envSchema>, "DATABASE_PATH" | "CONSISTENCY_WORKSPACE_ROOT" | "CONSISTENCY_ALLOWED_ORIGINS" | "LLM_PROVIDER" | "CONSISTENCY_ENGINE_ROOT" | "CONSISTENCY_LOCAL_REVIEW_ROOTS"> & {
  databasePath: string;
  workspaceRoot: string;
  engineRoot?: string;
  localReviewRoots: string[];
  localReviewRootsAreDefaulted: boolean;
  allowedOrigins: string[];
  LLM_PROVIDER?: "deepseek" | "openai";
  publicPrAnalysisEnabled: boolean;
  settingsWritable: boolean;
  reportLanguage: "zh-CN" | "en-US";
  notebookEnabled: boolean;
  heartbeatEnabled: boolean;
  /** Repository the heartbeat daemon observes. */
  heartbeatRepoPath: string;
  /** Workflow name, or null for the legacy single-shot analyze action. */
  reviewWorkflow: string | null;
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
  const llmProvider = parsed.LLM_PROVIDER ?? (parsed.DEEPSEEK_API_KEY ? "deepseek" : parsed.OPENAI_API_KEY ? "openai" : undefined);
  if (llmProvider === "deepseek" && !parsed.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required when LLM_PROVIDER=deepseek");
  }
  if (llmProvider === "openai" && !parsed.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
  }
  const allowedOrigins = parsed.CONSISTENCY_ALLOWED_ORIGINS.split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
  const configuredLocalRoots = (parsed.CONSISTENCY_LOCAL_REVIEW_ROOTS ?? "")
    .split(",")
    .map(root => root.trim())
    .filter(Boolean)
    .map(root => resolve(root));
  // Legacy path-based local reviews are fail-closed. Electron repository access
  // is granted by the main-process folder picker and the server-side registry;
  // deployments that still need POST /reviews/local must opt into exact roots.
  const localReviewRootsAreDefaulted = configuredLocalRoots.length === 0;
  const localReviewRoots = configuredLocalRoots.length === 0 ? [dirname(findProjectRoot())] : configuredLocalRoots;
  if (parsed.NODE_ENV === "production" && (allowedOrigins.length === 0 || allowedOrigins.includes("*"))) {
    throw new Error("CONSISTENCY_ALLOWED_ORIGINS must contain explicit origins in production");
  }
  const publicPrAnalysisEnabled = parsed.NODE_ENV === "production"
    ? input.CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED === "true"
    : parsed.CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED === "true";
  const notebookEnabled = parsed.NODE_ENV === "production"
    ? input.CONSISTENCY_NOTEBOOK_ENABLED === "true"
    : parsed.CONSISTENCY_NOTEBOOK_ENABLED === "true";
  const settingsWritable = input.CONSISTENCY_SETTINGS_WRITABLE !== undefined
    ? parsed.CONSISTENCY_SETTINGS_WRITABLE === "true"
    : parsed.NODE_ENV !== "production";
  // Development defaults to enabled so the live dashboard works out of the box;
  // production requires an explicit opt-in because the daemon reads a working tree.
  const heartbeatEnabled = input.CONSISTENCY_HEARTBEAT_ENABLED !== undefined
    ? parsed.CONSISTENCY_HEARTBEAT_ENABLED === "true"
    : parsed.NODE_ENV !== "production";
  return {
    ...parsed,
    LLM_PROVIDER: llmProvider,
    databasePath: resolveDatabasePath(parsed.DATABASE_PATH),
    workspaceRoot: resolveWorkspaceRoot(parsed.CONSISTENCY_WORKSPACE_ROOT),
    engineRoot: parsed.CONSISTENCY_ENGINE_ROOT ? resolve(parsed.CONSISTENCY_ENGINE_ROOT) : undefined,
    localReviewRoots,
    localReviewRootsAreDefaulted,
    allowedOrigins,
    publicPrAnalysisEnabled,
    settingsWritable,
    reportLanguage: parsed.CONSISTENCY_REPORT_LANGUAGE,
    notebookEnabled,
    heartbeatEnabled,
    heartbeatRepoPath: findProjectRoot(),
    reviewWorkflow: parsed.CONSISTENCY_REVIEW_WORKFLOW === "legacy"
      ? null
      : parsed.CONSISTENCY_REVIEW_WORKFLOW
  };
}
