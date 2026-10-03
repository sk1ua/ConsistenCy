import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { findProjectRoot, PROVIDER_ID_REGEX } from "./settings";

export function resolveDatabasePath(inputPath: string, root = findProjectRoot()): string {
  if (inputPath === ":memory:") return ":memory:";
  if (isAbsolute(inputPath)) return inputPath;
  return resolve(root, inputPath);
}

export function resolveWorkspaceRoot(inputPath: string, root = findProjectRoot()): string {
  if (isAbsolute(inputPath)) return inputPath;
  return resolve(root, inputPath);
}

/** Treat blank / whitespace-only env values as unset (common in .env templates). */
function emptyAsUnset<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    value => typeof value === "string" && value.trim() === "" ? undefined : value,
    schema
  );
}

const optionalSecret = emptyAsUnset(z.string().trim().min(1).optional());

/** Prefer python3 on non-Windows hosts; Windows installers still expose `python`. */
export function defaultPythonPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "python" : "python3";
}

/**
 * Process environments are intentionally tolerant: PATH, HOME, and other OS
 * keys are expected and ignored by design. Strict validation belongs to the
 * workflow node configuration schema, not to the daemon's process env.
 */
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
  /**
   * Extra gitignore-style patterns excluded from local WORKING_TREE reviews
   * (in addition to repo-root `.consistencyignore`). Comma or newline separated.
   */
  CONSISTENCY_LOCAL_REVIEW_EXCLUDE: z.string().trim().optional(),
  CONSISTENCY_PYTHON_PATH: emptyAsUnset(z.string().trim().min(1).default(defaultPythonPath())),
  CONSISTENCY_ENGINE_MODULE: z.string().trim().min(1).default("engine"),
  CONSISTENCY_ENGINE_ROOT: emptyAsUnset(z.string().trim().min(1).optional()),
  /**
   * Any provider id from the bundled Pi runtime's built-in catalog (e.g.
   * deepseek, openai, anthropic, google, xai, openrouter, groq, moonshotai…).
   * The catalog is the source of truth; an unknown id fails closed at
   * provider creation with a typed error.
   */
  LLM_PROVIDER: emptyAsUnset(z.string().trim().min(2).max(64).regex(PROVIDER_ID_REGEX).optional()),
  // The LLM engine is the bundled Pi runtime (@earendil-works/pi-*). Keys are
  // injected in-memory via setRuntimeApiKey at provider creation; nothing is
  // written to Pi config files and no local Pi installation is required.
  // CONSISTENCY_PI_CONFIG_DIR only isolates the runtime's auth-storage path
  // away from any user-level ~/.pi directory.
  LLM_API_KEY: optionalSecret,
  LLM_MODEL: emptyAsUnset(z.string().trim().min(1).optional()),
  CONSISTENCY_LLM_TEMPERATURE: emptyAsUnset(z.coerce.number().min(0).max(2).optional()),
  CONSISTENCY_LLM_BASE_URL: emptyAsUnset(z.string().url().optional()),
  CONSISTENCY_MAX_FINDINGS_PER_SPECIALIST: z.coerce.number().int().min(1).max(20).default(3),
  CONSISTENCY_MIN_FINDING_SCORE: z.coerce.number().int().min(0).max(10).default(5),
  CONSISTENCY_MAX_REPORTED_FINDINGS: z.coerce.number().int().min(1).max(50).default(8),
  CONSISTENCY_MAX_FINDINGS_PER_FILE: z.coerce.number().int().min(1).max(20).default(3),
  CONSISTENCY_DETERMINISTIC_SCOPE: z.enum(["diff", "all"]).default("diff"),
  /** Exact "1" enables lean review. Unset, "0", and every other value stay full. */
  CONSISTENCY_LEAN: z.string().optional(),
  /** Exact "1" adds a maintainer-review pass only when lean is also enabled. */
  CONSISTENCY_LEAN_REVIEWER: z.string().optional(),
  /** Exact "1" drops Maintainability doc/refactor titles only when lean reviewer is also enabled. */
  CONSISTENCY_LEAN_MAINT_FILTER: z.string().optional(),
  /** Exact "1" records withheld findings for diagnostics. Every other value omits them. */
  CONSISTENCY_REPORT_WITHHELD: z.string().optional(),
  /** Exact "1" enables the v2 scoring rubric. Every other value keeps v1. */
  CONSISTENCY_SCORE_RUBRIC: z.string().optional(),
  /** Exact "1" replaces full file context with numbered hunks and units. */
  CONSISTENCY_COMPACT_CONTEXT: z.string().optional(),
  /** Exact "1" tightens lean Consistency: boilerplate ban and source-only siblings. */
  CONSISTENCY_LEAN_CONSISTENCY_STRICT: z.string().optional(),
  /** Exact "1" stops lean reviews from merging different cross-agent claims. */
  CONSISTENCY_LEAN_STRICT_MERGE: z.string().optional(),
  ANTHROPIC_API_KEY: optionalSecret,
  ANTHROPIC_MODEL: emptyAsUnset(z.string().trim().min(1).optional()),
  CONSISTENCY_PI_CONFIG_DIR: emptyAsUnset(z.string().trim().min(1).optional()),
  CONSISTENCY_PI_MODELS_PATH: emptyAsUnset(z.string().trim().min(1).optional()),
  CONSISTENCY_WORKERS_ENABLED: z
    .enum(["true", "false"])
    .transform(value => value === "true")
    .default("true"),
  CONSISTENCY_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  CONSISTENCY_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
  /**
   * Audit P1-07③ shutdown deadline: how long graceful shutdown waits for an
   * in-flight review before cancelling every live run (aborting their
   * provider calls), then waits the same window again before giving up on
   * the loop entirely.
   */
  CONSISTENCY_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
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
   * CKPT5: automatic execution of enabled on_change workflow bindings from
   * persisted repository change events. Default on — a binding set to
   * on_change is explicit user intent; set to "false" as a kill-switch.
   */
  CONSISTENCY_WORKFLOW_TRIGGERS_ENABLED: z
    .enum(["true", "false"])
    .transform(value => value === "true")
    .default("true"),
  CONSISTENCY_WORKFLOW_TRIGGER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(5_000),
  /**
   * Audit execution bridge (executor slice): automatic execution of durable
   * audit-run drafts whose automation maps a workflow-runtime definition.
   * Default on — mapping an automation to a runtime definition is explicit
   * user intent; set to "false" as a kill-switch (drafts stay durable).
   */
  CONSISTENCY_AUDIT_EXECUTION_ENABLED: z
    .enum(["true", "false"])
    .transform(value => value === "true")
    .default("true"),
  CONSISTENCY_AUDIT_EXECUTION_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(5_000),
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
  CONSISTENCY_SETTINGS_WRITABLE: emptyAsUnset(z.enum(["true", "false"]).optional()),
  CONSISTENCY_NOTEBOOK_ENABLED: z.enum(["true", "false"]).default("true"),
  CONSISTENCY_NOTEBOOK_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(32).default(8),
  CONSISTENCY_NOTEBOOK_MAX_CONTEXT_TOKENS: z.coerce.number().int().min(1_000).max(64_000).default(16_000),
  CONSISTENCY_NOTEBOOK_INDEX_MAX_BYTES: z.coerce.number().int().min(1_024 * 1_024).max(512 * 1_024 * 1_024).default(64 * 1_024 * 1_024),
  GITHUB_APP_ID: optionalSecret,
  GITHUB_PRIVATE_KEY: optionalSecret,
  GITHUB_WEBHOOK_SECRET: optionalSecret,
  GITHUB_PUBLIC_READ_TOKEN: optionalSecret,
  // Public OAuth App client id for the Web Device Flow; public by design.
  GITHUB_OAUTH_CLIENT_ID: optionalSecret,
  // Product-operated desktop broker credentials stay server-side and are never
  // included in renderer-facing settings or desktop helper environments.
  CONSISTENCY_DESKTOP_OAUTH_BROKER_URL: emptyAsUnset(z.string().url().optional()),
  CONSISTENCY_DESKTOP_OAUTH_CLIENT_ID: optionalSecret,
  CONSISTENCY_DESKTOP_OAUTH_CLIENT_SECRET: optionalSecret,
  DEEPSEEK_API_KEY: optionalSecret,
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  // Must stay a model id Pi's built-in catalog actually carries: the managed
  // runtime pins this default and fails closed when the pinned id is absent.
  // Pi 0.87.1 renamed the old `deepseek-v4-flash` to `deepseek-flash`, which is
  // why an upgraded runtime would have rejected the previous default.
  DEEPSEEK_MODEL: z.string().trim().min(1).default("deepseek-flash"),
  OPENAI_API_KEY: optionalSecret,
  OPENAI_MODEL: z.string().trim().min(1).default("gpt-4.1-mini"),
  // H08: user-configured ordered LLM fallback chain (settings UI writes the
  // same key); entries are parsed and bounded by review/llm/profiles.ts.
  LLM_FALLBACK_CHAIN: emptyAsUnset(z.string().trim().min(1).max(512).optional()),
  /**
   * H15 completion reporting: the explicitly configured supervision channel
   * that receives one-shot terminal run summaries. There is NO default
   * destination — unset (or blank) keeps the feature silently off: no outbox
   * writes, no delivery, no timers. Capability reporting always states the
   * effective on/off state.
   */
  CONSISTENCY_COMPLETION_WEBHOOK_URL: emptyAsUnset(z.string().url().optional()),
  // Optional bearer credential for the completion destination. Server-side
  // only: it is never logged, never persisted into the outbox payload, and
  // never included in any DTO.
  CONSISTENCY_COMPLETION_WEBHOOK_TOKEN: optionalSecret,
  /**
   * H26 diagnostics telemetry switch. Unset (or "false") keeps the diagnostics
   * feature silently off: no bundle export, no retention sweep, no artifact
   * writes. The capability projection honestly reports the disabled state
   * (never a fabricated availability fact).
   */
  CONSISTENCY_DIAGNOSTICS_ENABLED: z.enum(["true", "false"]).default("false"),
  /**
   * H26 retention directory for module-owned diagnostic bundle artifacts.
   * Unset resolves to `<database dir>/diagnostics`. Cleanup touches ONLY
   * module-prefixed files inside this directory — user review history and
   * reports live elsewhere and are never scanned.
   */
  CONSISTENCY_DIAGNOSTICS_RETENTION_DIR: emptyAsUnset(z.string().trim().min(1).optional()),
  /** H26 retention 条数上限 — maximum number of retained diagnostics artifacts. */
  CONSISTENCY_DIAGNOSTICS_RETENTION_MAX_FILES: z.coerce.number().int().min(1).max(10_000).default(200),
  /** H26 retention 大小上限 — maximum total retained bytes (64 MiB default). */
  CONSISTENCY_DIAGNOSTICS_RETENTION_MAX_TOTAL_BYTES: z.coerce.number().int().min(1_024).max(1_073_741_824).default(67_108_864),
  /** H26 retention 期限上限 — maximum artifact age in hours (30 days default). */
  CONSISTENCY_DIAGNOSTICS_RETENTION_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(87_600).default(720)
});

export type RawEnvironment = z.input<typeof envSchema>;

export type AppConfig = Omit<z.output<typeof envSchema>, "DATABASE_PATH" | "CONSISTENCY_WORKSPACE_ROOT" | "CONSISTENCY_ALLOWED_ORIGINS" | "LLM_PROVIDER" | "CONSISTENCY_ENGINE_ROOT" | "CONSISTENCY_LOCAL_REVIEW_ROOTS" | "CONSISTENCY_PI_MODELS_PATH"> & {
  databasePath: string;
  workspaceRoot: string;
  engineRoot?: string;
  /** Directory where ConsistenCy writes its managed Pi auth/models files. */
  piConfigDir: string;
  /** Optional operator-supplied Pi model definitions; built-in catalog otherwise. */
  piModelsPath?: string;
  /** Explicit review roots; empty when unset, which disables POST /reviews/local. */
  localReviewRoots: string[];
  /** True when CONSISTENCY_LOCAL_REVIEW_ROOTS was not configured (reviews disabled). */
  localReviewRootsAreDefaulted: boolean;
  allowedOrigins: string[];
  LLM_PROVIDER?: string;
  publicPrAnalysisEnabled: boolean;
  settingsWritable: boolean;
  reportLanguage: "zh-CN" | "en-US";
  notebookEnabled: boolean;
  heartbeatEnabled: boolean;
  /** Repository the heartbeat daemon observes. */
  heartbeatRepoPath: string;
  /** Workflow name, or null for the legacy single-shot analyze action. */
  reviewWorkflow: string | null;
  workflowTriggersEnabled: boolean;
  /** Audit-run executor loop (drafts with a runtime definition mapping). */
  auditExecutionEnabled: boolean;
  /** H26 diagnostics export/retention feature switch (telemetry-related). */
  diagnosticsEnabled: boolean;
  /** H26 directory holding module-owned diagnostics artifacts. */
  diagnosticsRetentionDir: string;
  /** H26 local cleanup limits: count / total bytes / age (ms). */
  diagnosticsRetention: {
    maxFiles: number;
    maxTotalBytes: number;
    maxAgeMs: number;
  };
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
  const desktopOAuthBrokerConfigured = Boolean(parsed.CONSISTENCY_DESKTOP_OAUTH_BROKER_URL)
    || Boolean(parsed.CONSISTENCY_DESKTOP_OAUTH_CLIENT_ID)
    || Boolean(parsed.CONSISTENCY_DESKTOP_OAUTH_CLIENT_SECRET);
  if (desktopOAuthBrokerConfigured && (!parsed.CONSISTENCY_DESKTOP_OAUTH_BROKER_URL
    || !parsed.CONSISTENCY_DESKTOP_OAUTH_CLIENT_ID
    || !parsed.CONSISTENCY_DESKTOP_OAUTH_CLIENT_SECRET)) {
    throw new Error("Desktop OAuth broker URL, client id, and client secret must be configured together");
  }
  if (parsed.NODE_ENV === "production" && desktopOAuthBrokerConfigured && !parsed.CONSISTENCY_DESKTOP_OAUTH_BROKER_URL?.startsWith("https://")) {
    throw new Error("Desktop OAuth broker URL must use HTTPS in production");
  }
  if (parsed.NODE_ENV === "production" && githubAppConfigured && !parsed.GITHUB_WEBHOOK_SECRET) {
    throw new Error("GITHUB_WEBHOOK_SECRET is required when GitHub App mode is enabled in production");
  }
  if (parsed.NODE_ENV === "production" && parsed.CONSISTENCY_COMPLETION_WEBHOOK_URL && !parsed.CONSISTENCY_COMPLETION_WEBHOOK_URL.startsWith("https://")) {
    throw new Error("CONSISTENCY_COMPLETION_WEBHOOK_URL must use HTTPS in production");
  }
  if (parsed.NODE_ENV === "production" && !githubAppConfigured && parsed.GITHUB_WEBHOOK_SECRET) {
    throw new Error("GITHUB_WEBHOOK_SECRET requires GitHub App credentials");
  }
  const llmProvider = parsed.LLM_PROVIDER ?? (parsed.DEEPSEEK_API_KEY ? "deepseek" : parsed.OPENAI_API_KEY ? "openai" : parsed.ANTHROPIC_API_KEY ? "anthropic" : undefined);
  // Provider-id validation happens against the bundled Pi catalog at provider
  // creation (fail-closed typed error); env cannot enumerate 39 provider ids.
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
  // Unset configures nothing — the endpoint stays disabled instead of silently
  // widening to the project's parent directory (matching .env.example).
  const localReviewRootsAreDefaulted = configuredLocalRoots.length === 0;
  const localReviewRoots = configuredLocalRoots;
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
    piConfigDir: parsed.CONSISTENCY_PI_CONFIG_DIR
      ? resolve(parsed.CONSISTENCY_PI_CONFIG_DIR)
      : resolve(dirname(resolveDatabasePath(parsed.DATABASE_PATH)), "pi"),
    piModelsPath: parsed.CONSISTENCY_PI_MODELS_PATH ? resolve(parsed.CONSISTENCY_PI_MODELS_PATH) : undefined,
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
      : parsed.CONSISTENCY_REVIEW_WORKFLOW,
    workflowTriggersEnabled: parsed.CONSISTENCY_WORKFLOW_TRIGGERS_ENABLED,
    auditExecutionEnabled: parsed.CONSISTENCY_AUDIT_EXECUTION_ENABLED,
    diagnosticsEnabled: parsed.CONSISTENCY_DIAGNOSTICS_ENABLED === "true",
    diagnosticsRetentionDir: parsed.CONSISTENCY_DIAGNOSTICS_RETENTION_DIR
      ? resolve(parsed.CONSISTENCY_DIAGNOSTICS_RETENTION_DIR)
      : resolve(dirname(resolveDatabasePath(parsed.DATABASE_PATH)), "diagnostics"),
    diagnosticsRetention: {
      maxFiles: parsed.CONSISTENCY_DIAGNOSTICS_RETENTION_MAX_FILES,
      maxTotalBytes: parsed.CONSISTENCY_DIAGNOSTICS_RETENTION_MAX_TOTAL_BYTES,
      maxAgeMs: parsed.CONSISTENCY_DIAGNOSTICS_RETENTION_MAX_AGE_HOURS * 3_600_000
    }
  };
}
