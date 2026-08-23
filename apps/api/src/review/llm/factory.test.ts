import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config/env";
import { ReviewModelResolutionError, resolveReviewModel } from "./factory";

// The resolver only checks credential presence; a non-empty marker stands in
// for a configured key without embedding anything secret-shaped in tests.
const baseConfig = {
  LLM_PROVIDER: "deepseek",
  DEEPSEEK_API_KEY: "configured",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  OPENAI_API_KEY: "",
  OPENAI_MODEL: "gpt-4.1-mini"
} as AppConfig;

const configWith = (overrides: Partial<AppConfig>): AppConfig => ({ ...baseConfig, ...overrides });

describe("resolveReviewModel", () => {
  it("rejects review execution before it starts when no provider is configured", () => {
    expect(() => resolveReviewModel({ config: configWith({ LLM_PROVIDER: undefined }) }))
      .toThrowError(ReviewModelResolutionError);
  });

  it("rejects an override provider whose credential is not configured", () => {
    expect(() => resolveReviewModel({ config: baseConfig, override: { provider: "openai", model: "gpt-4.1-mini" } }))
      .toThrowError(ReviewModelResolutionError);
  });

  it("rejects an empty model name before execution", () => {
    expect(() => resolveReviewModel({ config: baseConfig, override: { provider: "deepseek", model: "   " } }))
      .toThrowError(ReviewModelResolutionError);
  });

  it("rejects an unsupported provider with a sanitized error", () => {
    expect(() => resolveReviewModel({ config: baseConfig, override: { provider: "mock" as "deepseek", model: "anything" } }))
      .toThrowError(/Unsupported provider/);
  });

  it("resolves a configured override to the trimmed pair and never touches global settings", () => {
    const resolved = resolveReviewModel({ config: baseConfig, override: { provider: "deepseek", model: "  deepseek-v4-turbo  " } });
    expect(resolved).toEqual({ provider: "deepseek", model: "deepseek-v4-turbo" });
  });

  it("falls back to the active configured model when no override is sent", () => {
    expect(resolveReviewModel({ config: baseConfig })).toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
  });
});
