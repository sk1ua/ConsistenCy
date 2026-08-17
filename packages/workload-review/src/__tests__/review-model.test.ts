/**
 * Model layer tests (§42) — the legacy-provider adapter and OFFLINE driver
 * behavior. No real network calls anywhere.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { reviewPlanSchema } from "@consistency/schema";
import type { ReviewFinding } from "@consistency/schema";
import {
  legacyProviderModelDriver,
  type LegacyProviderLike,
} from "../index.js";
import { securityFinding } from "./fixtures.js";

function makeLegacyProvider(): LegacyProviderLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "mock",
    model: "legacy-fixture",
    calls,
    invokeWithSchema: async (request) => {
      calls.push(`structured:${request.schemaName}`);
      const fixture =
        request.schemaName === "review-plan"
          ? { enabledAgents: ["Security"], skippedAgents: [], riskAreas: ["r"], reason: "ok" }
          : { findings: [] };
      return { data: request.schema.parse(fixture), tokenUsage: { totalTokens: 11 } };
    },
    generateAgentRun: async (request) => {
      calls.push(`findings:${request.agent}`);
      return { data: { findings: [securityFinding()] }, tokenUsage: { totalTokens: 22 } };
    },
    generateSummary: async () => {
      calls.push("summary");
      return { data: { summary: "legacy summary" }, tokenUsage: { totalTokens: 3 } };
    },
  };
}

describe("ModelDriver compatibility adapter (§42)", () => {
  it("adapts invokeWithSchema → invokeStructured with schema validation", async () => {
    const legacy = makeLegacyProvider();
    const driver = legacyProviderModelDriver(legacy);

    expect(driver.provider).toBe("mock");
    expect(driver.model).toBe("legacy-fixture");

    const result = await driver.invokeStructured({
      schema: reviewPlanSchema,
      schemaName: "review-plan",
      systemPrompt: "sys",
      userPrompt: "usr",
    });
    expect(result.data.enabledAgents).toEqual(["Security"]);
    expect(result.tokenUsage?.totalTokens).toBe(11);
    expect(legacy.calls).toEqual(["structured:review-plan"]);
  });

  it("adapts generateAgentRun → invokeAgentFindings", async () => {
    const legacy = makeLegacyProvider();
    const driver = legacyProviderModelDriver(legacy);

    const result = await driver.invokeAgentFindings({
      agent: "Security",
      systemPrompt: "sys",
      userPrompt: "usr",
    });
    expect(result.data).toEqual([securityFinding()]);
    expect(result.tokenUsage?.totalTokens).toBe(22);
    expect(legacy.calls).toEqual(["findings:Security"]);
  });

  it("adapts generateSummary → invokeSummary", async () => {
    const legacy = makeLegacyProvider();
    const driver = legacyProviderModelDriver(legacy);

    const result = await driver.invokeSummary({ systemPrompt: "sys", userPrompt: "usr" });
    expect(result.data.summary).toBe("legacy summary");
    expect(legacy.calls).toEqual(["summary"]);
  });

  it("adapter is fully offline and type-safe over structured schemas", async () => {
    const schema = z.object({ findings: z.array(z.unknown()).default([]) }).strict();
    const legacy = makeLegacyProvider();
    const driver = legacyProviderModelDriver(legacy);

    // A non-plan schemaName flows through the generic structured path.
    const out = await driver.invokeStructured({
      schema,
      schemaName: "custom",
      systemPrompt: "sys",
      userPrompt: "usr",
    });
    expect(out.data).toHaveProperty("findings");
    expect(legacy.calls).toEqual(["structured:custom"]);
  });
});
