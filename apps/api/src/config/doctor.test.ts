import { describe, expect, it } from "vitest";
import { diagnoseConfiguration } from "./doctor";

const privateKey = "-----BEGIN PRIVATE KEY-----\nconfigured\n-----END PRIVATE KEY-----";

describe("diagnoseConfiguration", () => {
  it("accepts a complete real-review configuration", async () => {
    const result = await diagnoseConfiguration({
      LLM_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "configured",
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: privateKey,
      GITHUB_WEBHOOK_SECRET: "configured",
      CONSISTENCY_ALLOWED_ORIGINS: "http://127.0.0.1:5173",
      CONSISTENCY_WEB_URL: "http://127.0.0.1:5173",
      DATABASE_PATH: ".consistency/test-doctor.db"
    });

    expect(result.ok).toBe(true);
    expect(result.checks.find(check => check.id === "github")?.status).toBe("pass");
    expect(result.checks.find(check => check.id === "llm")?.status).toBe("pass");
  });

  it("reports incomplete provider configuration as a fail on the llm check", async () => {
    const result = await diagnoseConfiguration({ LLM_PROVIDER: "deepseek" });
    expect(result.ok).toBe(false);
    expect(result.checks.find(check => check.id === "llm")?.status).toBe("fail");
  });

  it("warns when real integrations are intentionally absent", async () => {
    const result = await diagnoseConfiguration({});
    expect(result.ok).toBe(true);
    expect(result.checks.find(check => check.id === "llm")?.status).toBe("warn");
    expect(result.checks.find(check => check.id === "github")?.status).toBe("warn");
  });
});
