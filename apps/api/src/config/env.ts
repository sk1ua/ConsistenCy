import { resolve } from "node:path";
import { z } from "zod";

const optionalSecret = z.string().trim().min(1).optional();

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DATABASE_PATH: z.string().trim().min(1).default(".consistency/consistency.db"),
  LLM_PROVIDER: z.enum(["mock", "deepseek", "openai"]).default("mock"),
  CONSISTENCY_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  CONSISTENCY_API_TOKEN: optionalSecret,
  CONSISTENCY_ALLOWED_ORIGINS: z.string().trim().default("http://127.0.0.1:5173,http://localhost:5173"),
  GITHUB_APP_ID: optionalSecret,
  GITHUB_PRIVATE_KEY: optionalSecret,
  GITHUB_WEBHOOK_SECRET: optionalSecret,
  DEEPSEEK_API_KEY: optionalSecret,
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  OPENAI_API_KEY: optionalSecret,
  OPENAI_MODEL: z.string().trim().min(1).default("gpt-4.1-mini")
});

export type RawEnvironment = z.input<typeof envSchema>;

export type AppConfig = Omit<z.output<typeof envSchema>, "DATABASE_PATH" | "CONSISTENCY_ALLOWED_ORIGINS"> & {
  databasePath: string;
  allowedOrigins: string[];
};

export function loadEnv(input: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(input);
  return {
    ...parsed,
    databasePath: resolve(parsed.DATABASE_PATH),
    allowedOrigins: parsed.CONSISTENCY_ALLOWED_ORIGINS.split(",")
      .map(origin => origin.trim())
      .filter(Boolean)
  };
}

