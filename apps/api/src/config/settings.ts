import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const publicSettingsSchema = z.object({
  LLM_PROVIDER: z.enum(["deepseek", "openai"]).optional(),
  DEEPSEEK_BASE_URL: z.string().url().optional(),
  DEEPSEEK_MODEL: z.string().trim().min(1).optional(),
  OPENAI_MODEL: z.string().trim().min(1).optional(),
  GITHUB_APP_ID: z.string().trim().min(1).optional(),
  DATABASE_PATH: z.string().trim().min(1).optional(),
  CONSISTENCY_WORKSPACE_ROOT: z.string().trim().min(1).optional(),
  CONSISTENCY_LOCAL_REVIEW_ROOTS: z.string().trim().min(1).optional(),
  CONSISTENCY_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).transform(String).optional(),
  CONSISTENCY_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).transform(String).optional(),
  CONSISTENCY_WEB_URL: z.string().url().optional()
}).strict();

const secretSettingsSchema = z.object({
  GITHUB_PRIVATE_KEY: z.string().trim().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().trim().min(1).optional(),
  GITHUB_PUBLIC_READ_TOKEN: z.string().trim().min(1).optional(),
  DEEPSEEK_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  CONSISTENCY_API_TOKEN: z.string().trim().min(1).optional()
}).strict();

export const settingsPatchSchema = z.object({
  llm: z.object({
    provider: z.enum(["deepseek", "openai"]).optional(),
    deepseekBaseUrl: z.string().url().optional(),
    deepseekModel: z.string().trim().min(1).optional(),
    openaiModel: z.string().trim().min(1).optional(),
    deepseekApiKey: z.string().trim().min(1).nullable().optional(),
    openaiApiKey: z.string().trim().min(1).nullable().optional()
  }).strict().optional(),
  github: z.object({
    appId: z.string().trim().min(1).nullable().optional(),
    privateKey: z.string().trim().min(1).nullable().optional(),
    webhookSecret: z.string().trim().min(1).nullable().optional(),
    publicReadToken: z.string().trim().min(1).nullable().optional()
  }).strict().optional(),
  runtime: z.object({
    databasePath: z.string().trim().min(1).optional(),
    workspaceRoot: z.string().trim().min(1).optional(),
    localReviewRoots: z.string().trim().min(1).optional(),
    workerConcurrency: z.coerce.number().int().min(1).max(16).optional(),
    workerPollIntervalMs: z.coerce.number().int().min(50).max(60_000).optional(),
    webUrl: z.string().url().optional(),
    apiToken: z.string().trim().min(1).nullable().optional()
  }).strict().optional()
}).strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export type SettingsSnapshot = {
  llm: {
    provider: "deepseek" | "openai" | "none";
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
    /** Comma-separated roots under which a local checkout may be reviewed. */
    localReviewRoots: string;
    workerConcurrency: number;
    workerPollIntervalMs: number;
    webUrl: string;
    apiTokenConfigured: boolean;
  };
  overriddenByEnvironment: string[];
  restartRequired: boolean;
};

export type RendererSettingsSnapshot = Omit<SettingsSnapshot, "runtime"> & {
  runtime: {
    storage: { kind: "memory" | "file"; configured: boolean };
    workspace: { configured: boolean };
    localReview: { configured: boolean; rootCount: number };
    workerConcurrency: number;
    workerPollIntervalMs: number;
    webUrl: string;
    apiTokenConfigured: boolean;
  };
};

/** Renderer-facing projection; local filesystem locations remain server-side. */
export function toRendererSettings(snapshot: SettingsSnapshot): RendererSettingsSnapshot {
  const localReviewRoots = snapshot.runtime.localReviewRoots
    .split(",")
    .map(root => root.trim())
    .filter(Boolean);
  return {
    llm: snapshot.llm,
    github: snapshot.github,
    runtime: {
      storage: {
        kind: snapshot.runtime.databasePath === ":memory:" ? "memory" : "file",
        configured: snapshot.runtime.databasePath.trim().length > 0
      },
      workspace: { configured: snapshot.runtime.workspaceRoot.trim().length > 0 },
      localReview: { configured: localReviewRoots.length > 0, rootCount: localReviewRoots.length },
      workerConcurrency: snapshot.runtime.workerConcurrency,
      workerPollIntervalMs: snapshot.runtime.workerPollIntervalMs,
      webUrl: snapshot.runtime.webUrl,
      apiTokenConfigured: snapshot.runtime.apiTokenConfigured
    },
    overriddenByEnvironment: snapshot.overriddenByEnvironment,
    restartRequired: snapshot.restartRequired
  };
}

type PublicSettings = z.infer<typeof publicSettingsSchema>;
type SecretSettings = z.infer<typeof secretSettingsSchema>;
type EncryptedPayload = { version: 1; iv: string; tag: string; data: string };

const SECRET_KEYS = new Set<keyof SecretSettings>([
  "GITHUB_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_PUBLIC_READ_TOKEN",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "CONSISTENCY_API_TOKEN"
]);

function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  renameSync(temporaryPath, path);
  try { chmodSync(path, mode); } catch { /* Windows ACLs are managed by the current user profile. */ }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function findProjectRoot(startDirectory = process.cwd()): string {
  let directory = resolve(startDirectory);
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = readJson(manifestPath) as { name?: string };
        if (manifest.name === "consistency-workspace") return directory;
      } catch { /* Continue walking to the workspace root. */ }
    }
    const parent = dirname(directory);
    if (parent === directory) return resolve(startDirectory);
    directory = parent;
  }
}

export class SettingsStore {
  readonly rootDirectory: string;
  readonly directory: string;
  readonly publicPath: string;
  readonly secretsPath: string;
  readonly keyPath: string;

  constructor(rootDirectory = findProjectRoot()) {
    this.rootDirectory = resolve(rootDirectory);
    this.directory = join(this.rootDirectory, ".consistency");
    this.publicPath = join(this.directory, "config.json");
    this.secretsPath = join(this.directory, "secrets.enc.json");
    this.keyPath = join(this.directory, "config.key");
  }

  private key(): Buffer {
    mkdirSync(this.directory, { recursive: true });
    if (existsSync(this.keyPath)) {
      const key = Buffer.from(readFileSync(this.keyPath, "utf8").trim(), "base64");
      if (key.length !== 32) throw new Error("Configuration encryption key is invalid");
      return key;
    }
    const key = randomBytes(32);
    writeFileSync(this.keyPath, `${key.toString("base64")}\n`, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(this.keyPath, 0o600); } catch { /* Best effort on Windows. */ }
    return key;
  }

  private readPublic(): PublicSettings {
    if (!existsSync(this.publicPath)) return {};
    return publicSettingsSchema.parse(readJson(this.publicPath));
  }

  private readSecrets(): SecretSettings {
    if (!existsSync(this.secretsPath)) return {};
    const payload = readJson(this.secretsPath) as EncryptedPayload;
    if (payload.version !== 1) throw new Error("Unsupported encrypted settings version");
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final()
    ]).toString("utf8");
    return secretSettingsSchema.parse(JSON.parse(plaintext));
  }

  private writeSecrets(settings: SecretSettings): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(settings), "utf8"), cipher.final()]);
    writeJsonAtomic(this.secretsPath, {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64")
    } satisfies EncryptedPayload);
  }

  savedEnvironment(): NodeJS.ProcessEnv {
    return { ...this.readPublic(), ...this.readSecrets() };
  }

  effectiveEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const saved = this.savedEnvironment();
    const definedEnvironment = Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
    return { ...saved, ...definedEnvironment };
  }

  update(input: unknown): SettingsSnapshot {
    const patch = settingsPatchSchema.parse(input);
    const publicSettings = this.readPublic();
    const secretSettings = this.readSecrets();
    const setPublic = (key: keyof PublicSettings, value: string | number | null | undefined) => {
      if (value === undefined) return;
      if (value === null) delete publicSettings[key];
      else (publicSettings as Record<string, string>)[key] = String(value);
    };
    const setSecret = (key: keyof SecretSettings, value: string | null | undefined) => {
      if (value === undefined) return;
      if (value === null) delete secretSettings[key];
      else if (key === "GITHUB_PRIVATE_KEY" && !value.includes("BEGIN") && !isAbsolute(value)) {
        secretSettings[key] = resolve(this.rootDirectory, value);
      } else secretSettings[key] = value;
    };

    setPublic("LLM_PROVIDER", patch.llm?.provider);
    setPublic("DEEPSEEK_BASE_URL", patch.llm?.deepseekBaseUrl);
    setPublic("DEEPSEEK_MODEL", patch.llm?.deepseekModel);
    setPublic("OPENAI_MODEL", patch.llm?.openaiModel);
    setSecret("DEEPSEEK_API_KEY", patch.llm?.deepseekApiKey);
    setSecret("OPENAI_API_KEY", patch.llm?.openaiApiKey);
    setPublic("GITHUB_APP_ID", patch.github?.appId);
    setSecret("GITHUB_PRIVATE_KEY", patch.github?.privateKey);
    setSecret("GITHUB_WEBHOOK_SECRET", patch.github?.webhookSecret);
    setSecret("GITHUB_PUBLIC_READ_TOKEN", patch.github?.publicReadToken);
    setPublic("DATABASE_PATH", patch.runtime?.databasePath);
    setPublic("CONSISTENCY_WORKSPACE_ROOT", patch.runtime?.workspaceRoot);
    setPublic("CONSISTENCY_LOCAL_REVIEW_ROOTS", patch.runtime?.localReviewRoots);
    setPublic("CONSISTENCY_WORKER_CONCURRENCY", patch.runtime?.workerConcurrency);
    setPublic("CONSISTENCY_WORKER_POLL_INTERVAL_MS", patch.runtime?.workerPollIntervalMs);
    setPublic("CONSISTENCY_WEB_URL", patch.runtime?.webUrl);
    setSecret("CONSISTENCY_API_TOKEN", patch.runtime?.apiToken);

    writeJsonAtomic(this.publicPath, publicSettingsSchema.parse(publicSettings));
    this.writeSecrets(secretSettingsSchema.parse(secretSettings));
    return this.snapshot(process.env, true);
  }

  snapshot(environment: NodeJS.ProcessEnv = process.env, restartRequired = false): SettingsSnapshot {
    const saved = this.savedEnvironment();
    const effective = this.effectiveEnvironment(environment);
    const overriddenByEnvironment = Object.keys(saved)
      .filter(key => environment[key] !== undefined && environment[key] !== saved[key])
      .sort();
    const provider = effective.LLM_PROVIDER === "deepseek" || effective.LLM_PROVIDER === "openai"
      ? effective.LLM_PROVIDER
      : effective.DEEPSEEK_API_KEY ? "deepseek" : effective.OPENAI_API_KEY ? "openai" : "none";
    return {
      llm: {
        provider,
        deepseekBaseUrl: effective.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
        deepseekModel: effective.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
        openaiModel: effective.OPENAI_MODEL ?? "gpt-4.1-mini",
        deepseekApiKeyConfigured: Boolean(effective.DEEPSEEK_API_KEY),
        openaiApiKeyConfigured: Boolean(effective.OPENAI_API_KEY)
      },
      github: {
        appId: effective.GITHUB_APP_ID ?? "",
        privateKeyConfigured: Boolean(effective.GITHUB_PRIVATE_KEY),
        webhookSecretConfigured: Boolean(effective.GITHUB_WEBHOOK_SECRET),
        publicReadTokenConfigured: Boolean(effective.GITHUB_PUBLIC_READ_TOKEN)
      },
      runtime: {
        databasePath: effective.DATABASE_PATH ?? ".consistency/consistency.db",
        workspaceRoot: effective.CONSISTENCY_WORKSPACE_ROOT ?? ".consistency/workspaces",
        localReviewRoots: effective.CONSISTENCY_LOCAL_REVIEW_ROOTS ?? dirname(findProjectRoot()),
        workerConcurrency: Number(effective.CONSISTENCY_WORKER_CONCURRENCY ?? 1),
        workerPollIntervalMs: Number(effective.CONSISTENCY_WORKER_POLL_INTERVAL_MS ?? 1_000),
        webUrl: effective.CONSISTENCY_WEB_URL ?? "http://127.0.0.1:5173",
        apiTokenConfigured: Boolean(effective.CONSISTENCY_API_TOKEN)
      },
      overriddenByEnvironment,
      restartRequired
    };
  }
}

export function isSecretSettingKey(key: string): boolean {
  return SECRET_KEYS.has(key as keyof SecretSettings);
}
