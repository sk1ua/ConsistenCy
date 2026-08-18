import { describe, expect, it } from "vitest";
import { resolveDatabasePath, resolveWorkspaceRoot, loadEnv } from "./env";
import { findProjectRoot } from "./settings";
import { basename, dirname, join } from "node:path";

describe("loadEnv", () => {
  it("uses local-safe defaults", () => {
    const config = loadEnv({});
    expect(config.HOST).toBe("127.0.0.1");
    expect(config.PORT).toBe(8787);
    expect(config.workspaceRoot).toMatch(/\.consistency[\\/]workspaces$/);
    expect(config.LLM_PROVIDER).toBeUndefined();
    expect(config.CONSISTENCY_WORKER_CONCURRENCY).toBe(1);
    expect(config.CONSISTENCY_AUTOMATION_SCHEDULER_INTERVAL_MS).toBe(15_000);
    expect(config.publicPrAnalysisEnabled).toBe(true);
    expect(config.notebookEnabled).toBe(true);
    expect(config.GITHUB_PUBLIC_READ_TOKEN).toBeUndefined();
  });

  it("enables the heartbeat by default in development and stays opt-in in production", () => {
    expect(loadEnv({}).heartbeatEnabled).toBe(true);
    expect(loadEnv({ NODE_ENV: "test" }).heartbeatEnabled).toBe(true);
    expect(loadEnv({ CONSISTENCY_HEARTBEAT_ENABLED: "false" }).heartbeatEnabled).toBe(false);
    expect(loadEnv({
      NODE_ENV: "production",
      CONSISTENCY_API_TOKEN: "api-token",
      CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED: "true",
      CONSISTENCY_NOTEBOOK_ENABLED: "true"
    }).heartbeatEnabled).toBe(false);
    expect(loadEnv({
      NODE_ENV: "production",
      CONSISTENCY_API_TOKEN: "api-token",
      CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED: "true",
      CONSISTENCY_NOTEBOOK_ENABLED: "true",
      CONSISTENCY_HEARTBEAT_ENABLED: "true"
    }).heartbeatEnabled).toBe(true);
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

  it("selects DeepSeek or OpenAI when configured and leaves LLM_PROVIDER undefined otherwise without mock fallback", () => {
    expect(loadEnv({}).LLM_PROVIDER).toBeUndefined();
    expect(loadEnv({ DEEPSEEK_API_KEY: "configured" }).LLM_PROVIDER).toBe("deepseek");
    expect(loadEnv({ DEEPSEEK_API_KEY: "configured" }).DEEPSEEK_MODEL).toBe("deepseek-v4-flash");
    expect(loadEnv({ OPENAI_API_KEY: "configured" }).LLM_PROVIDER).toBe("openai");
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

  it("keeps the desktop control credential server-only and treats whitespace as unconfigured", () => {
    expect(loadEnv({ CONSISTENCY_DESKTOP_CONTROL_TOKEN: "desktop-control" })
      .CONSISTENCY_DESKTOP_CONTROL_TOKEN).toBe("desktop-control");
    expect(loadEnv({ CONSISTENCY_DESKTOP_CONTROL_TOKEN: "   " })
      .CONSISTENCY_DESKTOP_CONTROL_TOKEN).toBeUndefined();
  });

  it("anchors default and relative DATABASE_PATH to the project root regardless of cwd", () => {
    const root = findProjectRoot();
    const config = loadEnv({});
    expect(config.databasePath).toBe(join(root, ".consistency", "consistency.db"));
    expect(config.workspaceRoot).toBe(join(root, ".consistency", "workspaces"));

    // Relative override is resolved relative to project root
    const relativeConfig = loadEnv({ DATABASE_PATH: "custom/data.db" });
    expect(relativeConfig.databasePath).toBe(join(root, "custom", "data.db"));

    // Absolute override is preserved
    const absolutePath = process.platform === "win32" ? "C:\\data\\test.db" : "/data/test.db";
    const absoluteConfig = loadEnv({ DATABASE_PATH: absolutePath });
    expect(absoluteConfig.databasePath).toBe(absolutePath);

    // Memory DB is preserved
    const memoryConfig = loadEnv({ DATABASE_PATH: ":memory:" });
    expect(memoryConfig.databasePath).toBe(":memory:");
  });

  it("strictly places default database inside .consistency directory with proper separator and never as sibling directory", () => {
    const root = findProjectRoot();
    const resolved = resolveDatabasePath(".consistency/consistency.db", root);

    expect(resolved).toBe(join(root, ".consistency", "consistency.db"));
    expect(dirname(resolved)).toBe(join(root, ".consistency"));
    expect(basename(dirname(resolved))).toBe(".consistency");
    expect(basename(resolved)).toBe("consistency.db");

    // Prove it is NOT a sibling directory like root.consistency
    expect(resolved).not.toBe(`${root}.consistency/consistency.db`);
    expect(resolved).not.toBe(`${root}.consistency\\consistency.db`);

    // Verify resolution from multiple simulated working directories
    const appsApiCwd = join(root, "apps", "api");
    const nestedCwd = join(root, "packages", "schema", "src");
    expect(resolveDatabasePath(".consistency/consistency.db", findProjectRoot(appsApiCwd))).toBe(resolved);
    expect(resolveDatabasePath(".consistency/consistency.db", findProjectRoot(nestedCwd))).toBe(resolved);
  });
});
