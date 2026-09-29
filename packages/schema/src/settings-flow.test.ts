import { describe, expect, it } from "vitest";
import {
  effectiveSettingItemViewSchema,
  effectiveSettingsViewSchema,
  llmConnectionTestRequestSchema,
  llmConnectionTestResponseSchema
} from "./settings-flow";

/**
 * H09 — bounded settings-flow contract. The schemas are the sanitizer of
 * last resort: unknown fields (including any credential echo) must fail.
 */
describe("settings-flow schemas", () => {
  it("keeps effective setting items strict and values bounded to primitives", () => {
    const item = effectiveSettingItemViewSchema.parse({
      key: "workerConcurrency",
      envVar: "CONSISTENCY_WORKER_CONCURRENCY",
      source: "env",
      configured: true,
      isSecret: false,
      lockedByEnv: true,
      restartRequired: true,
      value: 2
    });
    expect(item.lockedByEnv).toBe(true);

    expect(() => effectiveSettingItemViewSchema.parse({
      key: "x", envVar: "X", source: "env", configured: true, isSecret: false, lockedByEnv: true, restartRequired: true, value: { nested: true }
    })).toThrow();

    expect(() => effectiveSettingItemViewSchema.parse({
      key: "x", envVar: "X", source: "env", configured: true, isSecret: false, lockedByEnv: true, restartRequired: true, apiKey: "sk-leak"
    })).toThrow();
  });

  it("keeps the grouped view strict", () => {
    expect(() => effectiveSettingsViewSchema.parse({
      items: {}, groups: { llm: [], github: [], runtime: [], general: [] },
      overriddenByEnvironment: [], restartRequiredKeys: [], databasePath: "leak"
    })).toThrow();
  });

  it("never allows a key echo in the LLM connection-test response", () => {
    const ok = llmConnectionTestResponseSchema.safeParse({
      status: "auth_failed", provider: "deepseek", testedAt: "2026-09-26T00:00:00.000Z", httpStatus: 401
    });
    expect(ok.success).toBe(true);

    for (const leak of [
      { status: "connected", provider: "deepseek", testedAt: "2026-09-26T00:00:00.000Z", apiKey: "sk-echo" },
      { status: "connected", provider: "deepseek", testedAt: "2026-09-26T00:00:00.000Z", upstreamError: "invalid key sk-x" }
    ]) {
      expect(llmConnectionTestResponseSchema.safeParse(leak).success).toBe(false);
    }
  });

  it("bounds the probe request and rejects unknown fields", () => {
    expect(llmConnectionTestRequestSchema.safeParse({ provider: "deepseek", apiKey: "sk-draft" }).success).toBe(true);
    expect(llmConnectionTestRequestSchema.safeParse({ provider: "deepseek", apiKey: "" }).success).toBe(false);
    expect(llmConnectionTestRequestSchema.safeParse({ provider: "" }).success).toBe(false);
    expect(llmConnectionTestRequestSchema.safeParse({ provider: "deepseek", save: true }).success).toBe(false);
  });
});
