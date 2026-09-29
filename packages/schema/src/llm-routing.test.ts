import { describe, expect, it } from "vitest";
import {
  LLM_ROUTE_MAX_FALLBACKS,
  LLM_ROUTE_MAX_PROFILES,
  llmConnectionProfileSchema,
  llmErrorKindSchema,
  llmRouteAttemptSchema,
  llmRouteRecordSchema
} from "./llm-routing";

describe("llm-routing contract", () => {
  it("keeps the fallback bound at two fallbacks across three profiles", () => {
    expect(LLM_ROUTE_MAX_FALLBACKS).toBe(2);
    expect(LLM_ROUTE_MAX_PROFILES).toBe(3);
  });

  it("keeps the error taxonomy closed to the five bounded kinds", () => {
    expect(llmErrorKindSchema.options).toEqual([
      "auth_failed",
      "model_not_found",
      "rate_limited",
      "network",
      "unknown"
    ]);
    expect(llmErrorKindSchema.safeParse("timeout").success).toBe(false);
  });

  it("parses a connection profile with optional model and baseUrl", () => {
    expect(llmConnectionProfileSchema.parse({
      id: "primary",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      enabled: true
    })).toEqual({
      id: "primary",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      enabled: true
    });
    expect(llmConnectionProfileSchema.parse({
      id: "fallback-1",
      provider: "openai",
      enabled: false
    })).toEqual({ id: "fallback-1", provider: "openai", enabled: false });
  });

  it("records quota as unknown and never admits a fabricated value", () => {
    const attempt = llmRouteAttemptSchema.parse({
      profileId: "primary",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      errorKind: "rate_limited",
      httpStatus: 429,
      quota: "unknown",
      at: "2026-09-26T08:00:00.000Z"
    });
    expect(attempt.quota).toBe("unknown");
    expect(llmRouteAttemptSchema.safeParse({
      profileId: "primary",
      provider: "deepseek",
      errorKind: "rate_limited",
      quota: { remaining: 42 },
      at: "2026-09-26T08:00:00.000Z"
    }).success).toBe(false);
  });

  it("rejects HTTP statuses outside the 4xx/5xx error range on attempts", () => {
    expect(llmRouteAttemptSchema.safeParse({
      profileId: "primary",
      provider: "deepseek",
      errorKind: "rate_limited",
      httpStatus: 200,
      quota: "unknown",
      at: "2026-09-26T08:00:00.000Z"
    }).success).toBe(false);
  });

  it("parses a run-level route record with selected and used endpoints", () => {
    const record = llmRouteRecordSchema.parse({
      configRevision: "cfgrev-0123456789abcdef",
      selected: { profileId: "primary", provider: "deepseek", model: "deepseek-v4-flash" },
      used: { profileId: "fallback-1", provider: "openai", model: "gpt-4.1-mini" },
      attempts: [{
        profileId: "primary",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        errorKind: "rate_limited",
        httpStatus: 429,
        quota: "unknown",
        at: "2026-09-26T08:00:00.000Z"
      }],
      fallbackCount: 1,
      quota: "unknown"
    });
    expect(record.selected.provider).toBe("deepseek");
    expect(record.used?.provider).toBe("openai");
    expect(llmRouteRecordSchema.safeParse({
      configRevision: "cfgrev-0123456789abcdef",
      selected: { profileId: "primary", provider: "deepseek" },
      attempts: [],
      fallbackCount: LLM_ROUTE_MAX_FALLBACKS + 1,
      quota: "unknown"
    }).success).toBe(false);
  });
});
