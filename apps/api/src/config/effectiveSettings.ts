export type SettingSource = "env" | "file" | "default";

export type SettingCategory = "llm" | "github" | "runtime" | "general";

export type SettingType = "string" | "number" | "boolean";

export interface SettingDefinition<T = unknown> {
  /** Canonical setting identifier (e.g. "workerConcurrency") */
  key: string;
  /** Primary environment variable name (e.g. "CONSISTENCY_WORKER_CONCURRENCY") */
  envVar: string;
  /** Alternative names, dotted paths, or aliases (e.g. ["runtime.workerConcurrency"]) */
  aliases?: string[];
  /** Data type for value coercion */
  type?: SettingType;
  /** Fallback default value when unset in env and file */
  defaultValue?: T;
  /** Whether the field holds sensitive data (API Key, token, private key) */
  isSecret?: boolean;
  /** Whether changing this setting requires a process restart */
  restartRequired?: boolean;
  /** Logical category for grouping */
  category?: SettingCategory;
  /** Human-readable description */
  description?: string;
  /** Custom parser/coercer */
  parse?: (raw: unknown) => T;
}

export interface EffectiveSettingItem<T = unknown> {
  key: string;
  envVar: string;
  source: SettingSource;
  /** Effective value. Intentionally undefined / omitted for secret fields to prevent plaintext leakage. */
  value?: T;
  /** Whether the setting is configured with a valid, non-empty value */
  configured: boolean;
  /** Whether this setting is sensitive (API Key, Token, Private Key) */
  isSecret: boolean;
  /** True when overridden by environment variable (cannot be modified via file in UI) */
  readOnly: boolean;
  /** Opposite of readOnly; false when overridden by environment */
  editable: boolean;
  /** True when the setting was supplied by environment */
  overriddenByEnv: boolean;
  /** Alias for overriddenByEnv/readOnly indicating UI lock */
  lockedByEnv: boolean;
  /** Whether changing this field requires a process restart to take effect */
  restartRequired: boolean;
  /** Setting category */
  category?: SettingCategory;
  /** Setting description */
  description?: string;
}

export interface EffectiveSettingsResult {
  /** All resolved settings indexed by canonical key */
  items: Record<string, EffectiveSettingItem>;
  /** All resolved settings indexed by environment variable name */
  byEnvVar: Record<string, EffectiveSettingItem>;
  /** List of environment variable keys that are overriding file/defaults */
  overriddenByEnvironment: string[];
  /** Keys that require process restart when modified */
  restartRequiredKeys: string[];
  /** Lookup helper by key, envVar, or alias */
  get: (keyOrAlias: string) => EffectiveSettingItem | undefined;
  /** Category-structured view */
  structured: {
    llm: Record<string, EffectiveSettingItem>;
    github: Record<string, EffectiveSettingItem>;
    runtime: Record<string, EffectiveSettingItem>;
    general: Record<string, EffectiveSettingItem>;
  };
}

export interface ResolveEffectiveSettingsOptions {
  /** Process environment to inspect (defaults to process.env) */
  env?: NodeJS.ProcessEnv;
  /** File-based saved settings (plain record or object with savedEnvironment) */
  file?: Record<string, unknown> | { savedEnvironment?: () => NodeJS.ProcessEnv };
  /** SettingsStore instance or store-like provider */
  store?: { savedEnvironment?: () => NodeJS.ProcessEnv };
  /** Custom default values overriding built-in defaults */
  defaults?: Record<string, unknown>;
  /** Additional or overriding setting definitions */
  definitions?: SettingDefinition[];
}

/** Set of known sensitive keys (both env var and canonical property names) */
const SECRET_KEY_NAMES = new Set<string>([
  "LLM_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_PUBLIC_READ_TOKEN",
  "CONSISTENCY_API_TOKEN",
  "CONSISTENCY_DESKTOP_CONTROL_TOKEN",
  "CONSISTENCY_DESKTOP_OAUTH_CLIENT_SECRET",
  "llmApiKey",
  "anthropicApiKey",
  "deepseekApiKey",
  "openaiApiKey",
  "privateKey",
  "githubPrivateKey",
  "webhookSecret",
  "githubWebhookSecret",
  "publicReadToken",
  "githubPublicReadToken",
  "apiToken"
]);

/** Pattern matching any sensitive credential key names */
const SECRET_PATTERN = /(_api_key|_token|_secret|_private_key|apikey|token|secret|privatekey|password|credential)/i;

/** Known keys requiring process restart when modified */
const RESTART_REQUIRED_KEY_NAMES = new Set<string>([
  "workerConcurrency",
  "CONSISTENCY_WORKER_CONCURRENCY",
  "workerPollIntervalMs",
  "CONSISTENCY_WORKER_POLL_INTERVAL_MS",
  "webUrl",
  "CONSISTENCY_WEB_URL",
  "databasePath",
  "DATABASE_PATH",
  "workspaceRoot",
  "CONSISTENCY_WORKSPACE_ROOT",
  "localReviewRoots",
  "CONSISTENCY_LOCAL_REVIEW_ROOTS",
  "host",
  "HOST",
  "port",
  "PORT",
  "nodeEnv",
  "NODE_ENV",
  "apiToken",
  "CONSISTENCY_API_TOKEN",
  "provider",
  "llmProvider",
  "LLM_PROVIDER",
  "llmApiKey",
  "LLM_API_KEY",
  "llmModel",
  "LLM_MODEL",
  "anthropicModel",
  "ANTHROPIC_MODEL",
  "anthropicApiKey",
  "ANTHROPIC_API_KEY",
  "deepseekBaseUrl",
  "DEEPSEEK_BASE_URL",
  "deepseekModel",
  "DEEPSEEK_MODEL",
  "deepseekApiKey",
  "DEEPSEEK_API_KEY",
  "openaiModel",
  "OPENAI_MODEL",
  "openaiApiKey",
  "OPENAI_API_KEY",
  "appId",
  "githubAppId",
  "GITHUB_APP_ID",
  "privateKey",
  "githubPrivateKey",
  "GITHUB_PRIVATE_KEY",
  "webhookSecret",
  "githubWebhookSecret",
  "GITHUB_WEBHOOK_SECRET",
  "publicReadToken",
  "githubPublicReadToken",
  "GITHUB_PUBLIC_READ_TOKEN"
]);

/** Known keys that do NOT require restart (dynamic / hot-reloaded) */
const NON_RESTART_KEY_NAMES = new Set<string>([
  "reportLanguage",
  "CONSISTENCY_REPORT_LANGUAGE",
  "theme",
  "uiMode"
]);

export function isSecretSetting(key: string): boolean {
  if (SECRET_KEY_NAMES.has(key)) return true;
  return SECRET_PATTERN.test(key);
}

export function isRestartRequired(key: string): boolean {
  if (NON_RESTART_KEY_NAMES.has(key)) return false;
  if (RESTART_REQUIRED_KEY_NAMES.has(key)) return true;
  const canonical = key.replace(/^(runtime|llm|github)\./, "");
  if (RESTART_REQUIRED_KEY_NAMES.has(canonical)) return true;
  return false;
}

/** Built-in catalog of standard ConsistenCy settings */
export const STANDARD_SETTING_DEFINITIONS: SettingDefinition[] = [
  // LLM settings
  {
    key: "provider",
    envVar: "LLM_PROVIDER",
    aliases: ["llmProvider", "llm.provider", "LLM_PROVIDER"],
    type: "string",
    defaultValue: "none",
    isSecret: false,
    restartRequired: true,
    category: "llm",
    description: "Configured LLM inference provider (deepseek, openai, anthropic, or pi catalog id)"
  },
  {
    key: "llmModel",
    envVar: "LLM_MODEL",
    aliases: ["llm.llmModel", "llm.model", "LLM_MODEL"],
    type: "string",
    defaultValue: "",
    isSecret: false,
    restartRequired: true,
    category: "llm",
    description: "Generic LLM provider model identifier"
  },
  {
    key: "llmApiKey",
    envVar: "LLM_API_KEY",
    aliases: ["llm.llmApiKey", "llm.apiKey", "LLM_API_KEY"],
    type: "string",
    defaultValue: "",
    isSecret: true,
    restartRequired: true,
    category: "llm",
    description: "Generic LLM provider API key"
  },
  {
    key: "anthropicModel",
    envVar: "ANTHROPIC_MODEL",
    aliases: ["llm.anthropicModel", "ANTHROPIC_MODEL"],
    type: "string",
    defaultValue: "",
    isSecret: false,
    restartRequired: true,
    category: "llm",
    description: "Anthropic model identifier"
  },
  {
    key: "anthropicApiKey",
    envVar: "ANTHROPIC_API_KEY",
    aliases: ["llm.anthropicApiKey", "ANTHROPIC_API_KEY"],
    type: "string",
    defaultValue: "",
    isSecret: true,
    restartRequired: true,
    category: "llm",
    description: "Anthropic API key"
  },
  {
    key: "deepseekBaseUrl",
    envVar: "DEEPSEEK_BASE_URL",
    aliases: ["llm.deepseekBaseUrl", "DEEPSEEK_BASE_URL"],
    type: "string",
    defaultValue: "https://api.deepseek.com",
    isSecret: false,
    restartRequired: true,
    category: "llm",
    description: "DeepSeek API base endpoint"
  },
  {
    key: "deepseekModel",
    envVar: "DEEPSEEK_MODEL",
    aliases: ["llm.deepseekModel", "DEEPSEEK_MODEL"],
    type: "string",
    defaultValue: "deepseek-v4-flash",
    isSecret: false,
    restartRequired: true,
    category: "llm",
    description: "DeepSeek model identifier"
  },
  {
    key: "deepseekApiKey",
    envVar: "DEEPSEEK_API_KEY",
    aliases: ["llm.deepseekApiKey", "DEEPSEEK_API_KEY"],
    type: "string",
    defaultValue: "",
    isSecret: true,
    restartRequired: true,
    category: "llm",
    description: "DeepSeek API authentication key"
  },
  {
    key: "openaiModel",
    envVar: "OPENAI_MODEL",
    aliases: ["llm.openaiModel", "OPENAI_MODEL"],
    type: "string",
    defaultValue: "gpt-4.1-mini",
    isSecret: false,
    restartRequired: true,
    category: "llm",
    description: "OpenAI model identifier"
  },
  {
    key: "openaiApiKey",
    envVar: "OPENAI_API_KEY",
    aliases: ["llm.openaiApiKey", "OPENAI_API_KEY"],
    type: "string",
    defaultValue: "",
    isSecret: true,
    restartRequired: true,
    category: "llm",
    description: "OpenAI API authentication key"
  },

  // GitHub settings
  {
    key: "appId",
    envVar: "GITHUB_APP_ID",
    aliases: ["githubAppId", "github.appId", "GITHUB_APP_ID"],
    type: "string",
    defaultValue: "",
    isSecret: false,
    restartRequired: true,
    category: "github",
    description: "GitHub App ID for webhook automation"
  },
  {
    key: "privateKey",
    envVar: "GITHUB_PRIVATE_KEY",
    aliases: ["githubPrivateKey", "github.privateKey", "GITHUB_PRIVATE_KEY"],
    type: "string",
    defaultValue: "",
    isSecret: true,
    restartRequired: true,
    category: "github",
    description: "GitHub App PEM private key"
  },
  {
    key: "webhookSecret",
    envVar: "GITHUB_WEBHOOK_SECRET",
    aliases: ["githubWebhookSecret", "github.webhookSecret", "GITHUB_WEBHOOK_SECRET"],
    type: "string",
    defaultValue: "",
    isSecret: true,
    restartRequired: true,
    category: "github",
    description: "HMAC webhook verification secret"
  },
  {
    key: "publicReadToken",
    envVar: "GITHUB_PUBLIC_READ_TOKEN",
    aliases: ["githubPublicReadToken", "github.publicReadToken", "GITHUB_PUBLIC_READ_TOKEN"],
    type: "string",
    defaultValue: "",
    isSecret: true,
    restartRequired: true,
    category: "github",
    description: "GitHub personal access token for elevated API rate limits"
  },

  // Runtime settings (critical restart items)
  {
    key: "workerConcurrency",
    envVar: "CONSISTENCY_WORKER_CONCURRENCY",
    aliases: ["runtime.workerConcurrency", "CONSISTENCY_WORKER_CONCURRENCY"],
    type: "number",
    defaultValue: 1,
    isSecret: false,
    restartRequired: true,
    category: "runtime",
    description: "Number of concurrent review jobs executed by the background worker"
  },
  {
    key: "workerPollIntervalMs",
    envVar: "CONSISTENCY_WORKER_POLL_INTERVAL_MS",
    aliases: ["runtime.workerPollIntervalMs", "runtime.workerPollMs", "CONSISTENCY_WORKER_POLL_INTERVAL_MS"],
    type: "number",
    defaultValue: 1000,
    isSecret: false,
    restartRequired: true,
    category: "runtime",
    description: "Interval in milliseconds between job queue polls"
  },
  {
    key: "webUrl",
    envVar: "CONSISTENCY_WEB_URL",
    aliases: ["runtime.webUrl", "CONSISTENCY_WEB_URL"],
    type: "string",
    defaultValue: "http://127.0.0.1:5173",
    isSecret: false,
    restartRequired: true,
    category: "runtime",
    description: "Base Web URL used in callbacks, links, and CORS headers"
  },
  {
    key: "databasePath",
    envVar: "DATABASE_PATH",
    aliases: ["runtime.databasePath", "DATABASE_PATH"],
    type: "string",
    defaultValue: ".consistency/consistency.db",
    isSecret: false,
    restartRequired: true,
    category: "runtime",
    description: "Path to the SQLite database file or :memory:"
  },
  {
    key: "workspaceRoot",
    envVar: "CONSISTENCY_WORKSPACE_ROOT",
    aliases: ["runtime.workspaceRoot", "CONSISTENCY_WORKSPACE_ROOT"],
    type: "string",
    defaultValue: ".consistency/workspaces",
    isSecret: false,
    restartRequired: true,
    category: "runtime",
    description: "Root directory for temporary review workspaces"
  },
  {
    key: "localReviewRoots",
    envVar: "CONSISTENCY_LOCAL_REVIEW_ROOTS",
    aliases: ["runtime.localReviewRoots", "CONSISTENCY_LOCAL_REVIEW_ROOTS"],
    type: "string",
    defaultValue: "",
    isSecret: false,
    restartRequired: true,
    category: "runtime",
    description: "Comma-separated roots under which local repositories may be reviewed"
  },
  {
    key: "apiToken",
    envVar: "CONSISTENCY_API_TOKEN",
    aliases: ["runtime.apiToken", "CONSISTENCY_API_TOKEN"],
    type: "string",
    defaultValue: "",
    isSecret: true,
    restartRequired: true,
    category: "runtime",
    description: "Bearer authentication token for protecting the HTTP API"
  },

  // General server settings
  {
    key: "host",
    envVar: "HOST",
    aliases: ["HOST"],
    type: "string",
    defaultValue: "127.0.0.1",
    isSecret: false,
    restartRequired: true,
    category: "general",
    description: "Bind host address for the HTTP server"
  },
  {
    key: "port",
    envVar: "PORT",
    aliases: ["PORT"],
    type: "number",
    defaultValue: 8787,
    isSecret: false,
    restartRequired: true,
    category: "general",
    description: "Port for the HTTP server"
  },
  {
    key: "nodeEnv",
    envVar: "NODE_ENV",
    aliases: ["NODE_ENV"],
    type: "string",
    defaultValue: "development",
    isSecret: false,
    restartRequired: true,
    category: "general",
    description: "Node execution environment (development, test, production)"
  },
  {
    key: "reportLanguage",
    envVar: "CONSISTENCY_REPORT_LANGUAGE",
    aliases: ["reportLanguage", "CONSISTENCY_REPORT_LANGUAGE"],
    type: "string",
    defaultValue: "zh-CN",
    isSecret: false,
    restartRequired: false,
    category: "general",
    description: "Language used for generated review reports (zh-CN or en-US)"
  }
];

/** Check if a raw value is present (non-empty string, number, boolean, etc.) */
function isConfiguredValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/** Retrieve nested property by dotted path (e.g. "runtime.workerConcurrency") */
function getDottedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Extract value from a file settings object or store */
function extractFromFileSource(
  fileSource: Record<string, unknown> | undefined,
  definition: SettingDefinition
): unknown {
  if (!fileSource || typeof fileSource !== "object") return undefined;

  // 1. Direct envVar name check
  if (isConfiguredValue(fileSource[definition.envVar])) {
    return fileSource[definition.envVar];
  }
  // 2. Direct canonical key check
  if (isConfiguredValue(fileSource[definition.key])) {
    return fileSource[definition.key];
  }
  // 3. Aliases and dotted paths
  if (definition.aliases) {
    for (const alias of definition.aliases) {
      if (alias.includes(".")) {
        const dotted = getDottedValue(fileSource, alias);
        if (isConfiguredValue(dotted)) return dotted;
      } else if (isConfiguredValue(fileSource[alias])) {
        return fileSource[alias];
      }
    }
  }
  return undefined;
}

/** Extract value from environment variables */
function extractFromEnv(
  env: NodeJS.ProcessEnv,
  definition: SettingDefinition
): unknown {
  // 1. Primary envVar
  if (isConfiguredValue(env[definition.envVar])) {
    return env[definition.envVar];
  }
  // 2. Aliases that look like env vars
  if (definition.aliases) {
    for (const alias of definition.aliases) {
      if (isConfiguredValue(env[alias])) {
        return env[alias];
      }
    }
  }
  return undefined;
}

/** Parse and coerce non-secret values according to setting definition type */
function coerceValue(raw: unknown, definition: SettingDefinition): unknown {
  if (definition.parse) {
    return definition.parse(raw);
  }
  if (definition.type === "number") {
    if (typeof raw === "number") return raw;
    const num = Number(raw);
    return isNaN(num) ? definition.defaultValue : num;
  }
  if (definition.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    return raw === "true" || raw === "1" || raw === 1;
  }
  if (definition.type === "string") {
    return raw !== undefined && raw !== null ? String(raw) : (definition.defaultValue ?? "");
  }
  return raw;
}

/** Build or normalize a definition for an ad-hoc or custom key */
function synthesizeDefinition(
  key: string,
  options?: ResolveEffectiveSettingsOptions
): SettingDefinition {
  const isSecret = isSecretSetting(key);
  const restartRequired = isRestartRequired(key);
  const customDefault = options?.defaults?.[key];

  // Try to find matching standard definition by key, envVar, or alias
  const existing = (options?.definitions ?? STANDARD_SETTING_DEFINITIONS).find(
    d => d.key === key || d.envVar === key || d.aliases?.includes(key)
  );
  if (existing) {
    return existing;
  }

  // Synthesize for unknown key
  const envVar = key.includes("_") ? key : key.replace(/([A-Z])/g, "_$1").toUpperCase();
  return {
    key,
    envVar,
    aliases: [key, envVar],
    type: "string",
    defaultValue: customDefault !== undefined ? customDefault : (isSecret ? "" : ""),
    isSecret,
    restartRequired,
    category: "general"
  };
}

/**
 * Resolve effective configuration for a single setting.
 * Precedence: env > file > default
 */
export function resolveEffectiveSetting<T = unknown>(
  key: string,
  options: ResolveEffectiveSettingsOptions = {}
): EffectiveSettingItem<T> {
  const env = options.env ?? process.env;
  let fileSource: Record<string, unknown> | undefined;

  if (options.store && typeof options.store.savedEnvironment === "function") {
    fileSource = options.store.savedEnvironment();
  } else if (options.file && typeof (options.file as { savedEnvironment?: () => NodeJS.ProcessEnv }).savedEnvironment === "function") {
    fileSource = (options.file as { savedEnvironment: () => NodeJS.ProcessEnv }).savedEnvironment();
  } else if (options.file && typeof options.file === "object") {
    fileSource = options.file as Record<string, unknown>;
  }

  const definition = synthesizeDefinition(key, options);
  const isSecret = definition.isSecret ?? isSecretSetting(definition.key);
  const restartRequired = definition.restartRequired ?? isRestartRequired(definition.key);

  const envValue = extractFromEnv(env, definition);
  const fileValue = extractFromFileSource(fileSource, definition);
  const defaultCandidate = options.defaults?.[definition.key]
    ?? options.defaults?.[definition.envVar]
    ?? definition.defaultValue;

  let source: SettingSource;
  let rawValue: unknown;

  if (isConfiguredValue(envValue)) {
    source = "env";
    rawValue = envValue;
  } else if (isConfiguredValue(fileValue)) {
    source = "file";
    rawValue = fileValue;
  } else {
    source = "default";
    rawValue = defaultCandidate;
  }

  const configured = isConfiguredValue(rawValue);
  const overriddenByEnv = source === "env";
  const readOnly = overriddenByEnv;
  const editable = !overriddenByEnv;

  const item: EffectiveSettingItem<T> = {
    key: definition.key,
    envVar: definition.envVar,
    source,
    configured,
    isSecret,
    readOnly,
    editable,
    overriddenByEnv,
    lockedByEnv: overriddenByEnv,
    restartRequired,
    category: definition.category,
    description: definition.description
  };

  // SENSITIVE FIELDS: MUST NOT expose plaintext value!
  if (!isSecret) {
    item.value = coerceValue(rawValue, definition) as T;
  }

  return item;
}

/**
 * Resolve effective configuration for all known and specified settings.
 * Precedence: env > file > default
 */
export function resolveEffectiveSettings(
  options: ResolveEffectiveSettingsOptions = {}
): EffectiveSettingsResult {
  const env = options.env ?? process.env;
  let fileSource: Record<string, unknown> | undefined;

  if (options.store && typeof options.store.savedEnvironment === "function") {
    fileSource = options.store.savedEnvironment();
  } else if (options.file && typeof (options.file as { savedEnvironment?: () => NodeJS.ProcessEnv }).savedEnvironment === "function") {
    fileSource = (options.file as { savedEnvironment: () => NodeJS.ProcessEnv }).savedEnvironment();
  } else if (options.file && typeof options.file === "object") {
    fileSource = options.file as Record<string, unknown>;
  }

  const definitions = options.definitions ?? STANDARD_SETTING_DEFINITIONS;
  const items: Record<string, EffectiveSettingItem> = {};
  const byEnvVar: Record<string, EffectiveSettingItem> = {};
  const overriddenByEnvironmentSet = new Set<string>();
  const restartRequiredKeysSet = new Set<string>();

  const structured = {
    llm: {} as Record<string, EffectiveSettingItem>,
    github: {} as Record<string, EffectiveSettingItem>,
    runtime: {} as Record<string, EffectiveSettingItem>,
    general: {} as Record<string, EffectiveSettingItem>
  };

  // Also collect any extra keys in fileSource that might not be in standard definitions
  const allDefinitions = [...definitions];
  const knownKeys = new Set(definitions.flatMap(d => [d.key, d.envVar, ...(d.aliases ?? [])]));

  if (fileSource) {
    for (const fileKey of Object.keys(fileSource)) {
      if (!knownKeys.has(fileKey) && isConfiguredValue(fileSource[fileKey])) {
        allDefinitions.push(synthesizeDefinition(fileKey, options));
        knownKeys.add(fileKey);
      }
    }
  }

  for (const definition of allDefinitions) {
    const item = resolveEffectiveSetting(definition.key, {
      ...options,
      env,
      file: fileSource,
      definitions: allDefinitions
    });

    items[item.key] = item;
    byEnvVar[item.envVar] = item;

    if (item.overriddenByEnv) {
      overriddenByEnvironmentSet.add(item.envVar);
    }

    if (item.restartRequired) {
      restartRequiredKeysSet.add(item.key);
    }

    const category = item.category ?? "general";
    if (category in structured) {
      structured[category as keyof typeof structured][item.key] = item;
    } else {
      structured.general[item.key] = item;
    }
  }

  const overriddenByEnvironment = Array.from(overriddenByEnvironmentSet).sort();
  const restartRequiredKeys = Array.from(restartRequiredKeysSet).sort();

  const get = (keyOrAlias: string): EffectiveSettingItem | undefined => {
    if (items[keyOrAlias]) return items[keyOrAlias];
    if (byEnvVar[keyOrAlias]) return byEnvVar[keyOrAlias];
    for (const item of Object.values(items)) {
      const def = allDefinitions.find(d => d.key === item.key);
      if (def?.aliases?.includes(keyOrAlias)) return item;
    }
    return undefined;
  };

  return {
    items,
    byEnvVar,
    overriddenByEnvironment,
    restartRequiredKeys,
    get,
    structured
  };
}
