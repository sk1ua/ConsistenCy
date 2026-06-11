import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

describe("loadEnv", () => {
  it("uses local-safe defaults", () => {
    const config = loadEnv({});
    expect(config.HOST).toBe("127.0.0.1");
    expect(config.PORT).toBe(8787);
    expect(config.LLM_PROVIDER).toBe("mock");
    expect(config.CONSISTENCY_WORKER_CONCURRENCY).toBe(1);
  });

  it("parses origins and rejects invalid ports", () => {
    const config = loadEnv({
      PORT: "9000",
      CONSISTENCY_ALLOWED_ORIGINS: "https://example.com, https://admin.example.com"
    });
    expect(config.allowedOrigins).toEqual(["https://example.com", "https://admin.example.com"]);
    expect(() => loadEnv({ PORT: "70000" })).toThrow();
  });

  it("requires a webhook secret in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/GITHUB_WEBHOOK_SECRET/);
    expect(loadEnv({ NODE_ENV: "production", GITHUB_WEBHOOK_SECRET: "secret" }).NODE_ENV).toBe("production");
  });
});
