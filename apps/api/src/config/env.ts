import { resolve } from "node:path";
import { z } from "zod";

const optionalSecret = z.string().trim().min(1).optional();

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DATABASE_PATH: z.string().trim().min(1).default(".consistency/consistency.db"),
  LLM_PROVIDER: z.enum(["mock", "deepseek", "openai"]).optional(),
  CONSISTENCY_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  CONSISTENCY_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
  CONSISTENCY_API_TOKEN: optionalSecret,
  CONSISTENCY_ALLOWED_ORIGINS: z.string().trim().default("http://127.0.0.1:5173,http://localhost:5173"),
  CONSISTENCY_WEB_URL: z.string().url().default("http://127.0.0.1:5173"),
  GITHUB_APP_ID: optionalSecret,
  GITHUB_PRIVATE_KEY: optionalSecret,
  GITHUB_WEBHOOK_SECRET: optionalSecret,
  DEEPSEEK_API_KEY: optionalSecret,
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().trim().min(1).default("deepseek-v4-flash"),
  OPENAI_API_KEY: optionalSecret,
  OPENAI_MODEL: z.string().trim().min(1).default("gpt-4.1-mini")
});

export type RawEnvironment = z.input<typeof envSchema>;

export type AppConfig = Omit<z.output<typeof envSchema>, "DATABASE_PATH" | "CONSISTENCY_ALLOWED_ORIGINS" | "LLM_PROVIDER"> & {
  databasePath: string;
  allowedOrigins: string[];
  LLM_PROVIDER: "mock" | "deepseek" | "openai";
};

export function loadEnv(input: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(input);
  if (parsed.NODE_ENV === "production" && !parsed.GITHUB_WEBHOOK_SECRET) {
    throw new Error("GITHUB_WEBHOOK_SECRET is required in production");
  }
  if (parsed.NODE_ENV === "production" && !parsed.CONSISTENCY_API_TOKEN) {
    throw new Error("CONSISTENCY_API_TOKEN is required in production");
  }
  const llmProvider = parsed.LLM_PROVIDER ?? (parsed.DEEPSEEK_API_KEY ? "deepseek" : "mock");
  if (llmProvider === "deepseek" && !parsed.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required when LLM_PROVIDER=deepseek");
  }
  if (llmProvider === "openai" && !parsed.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
  }
  return {
    ...parsed,
    LLM_PROVIDER: llmProvider,
    databasePath: resolve(parsed.DATABASE_PATH),
    allowedOrigins: parsed.CONSISTENCY_ALLOWED_ORIGINS.split(",")
      .map(origin => origin.trim())
      .filter(Boolean)
  };
}
