import { describe, expect, it, vi } from "vitest";
import type { DomainComposeReviewSuccess } from "@consistency/schema";
import { InMemoryJobQueue } from "../../jobQueue";
import { MockLLMProvider } from "../llm/mockProvider";
import { createSynthesizerNode } from "./synthesizer";

const mockComposedReview: DomainComposeReviewSuccess = {
  id: "req_comp_1",
  ok: true,
  overallScore: 42,
  riskLevel: "high",
  summary: "High risk architectural issue in auth module.",
  recommendations: ["Upgrade to signature verification.", "Enable strict CORS."]
};

describe("Synthesizer Node", () => {
  it("throws error when state.composedReview is missing", async () => {
    const store = new InMemoryJobQueue();
    const synthesizer = createSynthesizerNode({ provider: new MockLLMProvider(), jobStore: store, reportLanguage: "en-US" });
    const state: any = {
      jobId: "job-1",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 1,
      baseSha: "base",
      headSha: "head",
      findings: [],
      agentRuns: []
    };

    await expect(synthesizer(state)).rejects.toThrow(/Canonical compose review result is required/);
  });

  it("passes canonical summary, recommendations, score, and riskLevel into LLM provider prompt and fallback summary", async () => {
    const store = new InMemoryJobQueue();
    const generateSummarySpy = vi.fn(async (params: any) => {
      const payload = JSON.parse(params.userPrompt);
      expect(payload.canonicalScore).toBe(42);
      expect(payload.canonicalRiskLevel).toBe("high");
      expect(payload.canonicalSummary).toBe("High risk architectural issue in auth module.");
      expect(payload.recommendations).toEqual(["Upgrade to signature verification.", "Enable strict CORS."]);
      return {
        data: { summary: "LLM Synthesized summary incorporating canonical findings." },
        tokenUsage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }
      };
    });

    const provider: any = {
      name: "mock",
      generateSummary: generateSummarySpy
    };

    const synthesizer = createSynthesizerNode({ provider, jobStore: store, reportLanguage: "en-US" });
    const state: any = {
      jobId: "job-1",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 1,
      baseSha: "base",
      headSha: "head",
      findings: [],
      agentRuns: [],
      composedReview: mockComposedReview
    };

    const result = await synthesizer(state);

    expect(generateSummarySpy).toHaveBeenCalledOnce();
    expect(result.report?.score).toBe(42);
    expect(result.report?.riskLevel).toBe("high");
    expect(result.report?.summary).toContain("High risk architectural issue in auth module.");
    expect(result.report?.summary).toContain("Recommendation: Upgrade to signature verification.");
    expect(result.report?.summary).toContain("Agent Overview: LLM Synthesized summary incorporating canonical findings.");
  });

  it("uses canonical summary and recommendations in fallback summary when LLM fails", async () => {
    const store = new InMemoryJobQueue();
    const provider: any = {
      name: "mock",
      generateSummary: async () => { throw new Error("LLM Rate Limited"); }
    };

    const synthesizer = createSynthesizerNode({ provider, jobStore: store, reportLanguage: "en-US" });
    const state: any = {
      jobId: "job-1",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 1,
      baseSha: "base",
      headSha: "head",
      findings: [],
      agentRuns: [],
      composedReview: mockComposedReview
    };

    const result = await synthesizer(state);

    expect(result.report?.summary).toBe("High risk architectural issue in auth module. Recommendation: Upgrade to signature verification. Recommendation: Enable strict CORS.");
    expect(result.errors).toContain("Synthesizer: LLM Rate Limited");
  });
});
