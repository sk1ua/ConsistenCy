import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

describe("loadEnv", () => {
  it("uses local-safe defaults", () => {
    const config = loadEnv({});
    expect(config.HOST).toBe("127.0.0.1");
    expect(config.PORT).toBe(8787);
    expect(config.workspaceRoot).toMatch(/\.consistency[\\/]workspaces$/);
    expect(config.LLM_PROVIDER).toBe("mock");
    expect(config.CONSISTENCY_WORKER_CONCURRENCY).toBe(1);
    expect(config.publicPrAnalysisEnabled).toBe(true);
    expect(config.notebookEnabled).toBe(true);
    expect(config.GITHUB_PUBLIC_READ_TOKEN).toBeUndefined();
  });

  it("parses origins and rejects invalid ports", () => {
    const config = loadEnv({
      PORT: "9000",
      CONSISTENCY_ALLOWED_ORIGINS: "https://example.com, https://admin.example.com"
    });
    expect(config.allowedOrigins).toEqual(["https://example.com", "https://admin.example.com"]);
    expect(() => loadEnv({ PORT: "70000" })).toThrow();
  });

  it("requires production API access and validates GitHub App mode as a complete pair", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/CONSISTENCY_API_TOKEN/);
    expect(() => loadEnv({ NODE_ENV: "production", GITHUB_WEBHOOK_SECRET: "secret" })).toThrow(/CONSISTENCY_API_TOKEN/);
    expect(() => loadEnv({
      NODE_ENV: "production",
      GITHUB_WEBHOOK_SECRET: "secret",
      CONSISTENCY_API_TOKEN: "api-token"
    })).toThrow(/GitHub App credentials/);
    expect(() => loadEnv({
      NODE_ENV: "production",
      CONSISTENCY_API_TOKEN: "api-token",
      GITHUB_APP_ID: "123"
    })).toThrow(/configured together/);
    expect(loadEnv({
      NODE_ENV: "production",
      GITHUB_WEBHOOK_SECRET: "secret",
      CONSISTENCY_API_TOKEN: "api-token",
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "private-key"
    }).NODE_ENV).toBe("production");
    expect(() => loadEnv({
      NODE_ENV: "production",
      GITHUB_WEBHOOK_SECRET: "secret",
      CONSISTENCY_API_TOKEN: "api-token",
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "private-key",
      CONSISTENCY_ALLOWED_ORIGINS: "*"
    })).toThrow(/explicit origins/);
  });

  it("allows production public-read mode without GitHub App credentials", () => {
    const config = loadEnv({
      NODE_ENV: "production",
      CONSISTENCY_API_TOKEN: "api-token",
      CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED: "true",
      CONSISTENCY_NOTEBOOK_ENABLED: "true"
    });
    expect(config.publicPrAnalysisEnabled).toBe(true);
    expect(config.notebookEnabled).toBe(true);
  });

  it("prefers DeepSeek when its key is configured and otherwise uses mock", () => {
    expect(loadEnv({}).LLM_PROVIDER).toBe("mock");
    expect(loadEnv({ DEEPSEEK_API_KEY: "configured" }).LLM_PROVIDER).toBe("deepseek");
    expect(loadEnv({ DEEPSEEK_API_KEY: "configured" }).DEEPSEEK_MODEL).toBe("deepseek-v4-flash");
    expect(() => loadEnv({ LLM_PROVIDER: "deepseek" })).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => loadEnv({ LLM_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
  });

  it("requires explicit public PR and Notebook enablement in production", () => {
    const base = {
      NODE_ENV: "production" as const,
      GITHUB_WEBHOOK_SECRET: "secret",
      CONSISTENCY_API_TOKEN: "api-token",
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "private-key"
    };
    expect(loadEnv(base).publicPrAnalysisEnabled).toBe(false);
    expect(loadEnv({ ...base, CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED: "true", CONSISTENCY_NOTEBOOK_ENABLED: "true" }).notebookEnabled).toBe(true);
  });

  it("accepts a server-only public read token without requiring App credentials in development", () => {
    const config = loadEnv({ GITHUB_PUBLIC_READ_TOKEN: "local-read-token" });
    expect(config.GITHUB_PUBLIC_READ_TOKEN).toBe("local-read-token");
    expect(() => loadEnv({ GITHUB_PUBLIC_READ_TOKEN: "" })).not.toThrow();
  });
});
