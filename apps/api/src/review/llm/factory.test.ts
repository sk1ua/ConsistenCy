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
  OPENAI_MODEL: "gpt-4.1-mini",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_MODEL: "",
  LLM_API_KEY: "",
  LLM_MODEL: "",
  piConfigDir: ".consistency"
} as unknown as AppConfig;

const configWith = (overrides: Partial<AppConfig>): AppConfig => ({ ...baseConfig, ...overrides });

describe("resolveReviewModel", () => {
  it("rejects review execution before it starts when no provider is configured", () => {
    expect(() => resolveReviewModel({ config: configWith({ LLM_PROVIDER: undefined }) }))
      .toThrowError(ReviewModelResolutionError);
  });

  it("accepts any Pi catalog provider id and leaves model selection to the runtime when unpinned", () => {
    expect(resolveReviewModel({ config: configWith({ LLM_PROVIDER: "moonshotai" }) }))
      .toEqual({ provider: "moonshotai", model: "" });
    expect(resolveReviewModel({ config: baseConfig }))
      .toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
  });

  it("uses the provider-specific model pin when configured", () => {
    expect(resolveReviewModel({
      config: configWith({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "configured", ANTHROPIC_MODEL: "claude-opus-4-5" })
    })).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
  });

  it("uses the generic model pin for non-default providers", () => {
    expect(resolveReviewModel({
      config: configWith({ LLM_PROVIDER: "openrouter", LLM_MODEL: "anthropic/claude-sonnet-4.5" })
    })).toEqual({ provider: "openrouter", model: "anthropic/claude-sonnet-4.5" });
  });

  it("resolves a configured override to the trimmed pair and never touches global settings", () => {
    const resolved = resolveReviewModel({ config: baseConfig, override: { provider: "deepseek", model: "  deepseek-v4-turbo  " } });
    expect(resolved).toEqual({ provider: "deepseek", model: "deepseek-v4-turbo" });
  });

  it("lowercases and trims the provider id", () => {
    expect(resolveReviewModel({ config: configWith({ LLM_PROVIDER: "  DeepSeek  " }) }))
      .toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
  });

  it("prefers canonical model over legacy name when both are set", () => {
    expect(resolveReviewModel({
      config: baseConfig,
      override: { provider: "deepseek", name: "legacy-name", model: "canonical-model" }
    })).toEqual({ provider: "deepseek", model: "canonical-model" });
  });

  it("still accepts legacy name when model is omitted", () => {
    expect(resolveReviewModel({
      config: baseConfig,
      override: { provider: "deepseek", name: "legacy-name" }
    })).toEqual({ provider: "deepseek", model: "legacy-name" });
  });
});
