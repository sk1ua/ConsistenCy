/**
 * ModelDriver — the generic, Review-agnostic LLM invocation contract.
 *
 * PR-5A introduces the abstraction plus a compatibility adapter
 * (`legacyProviderModelDriver`) that bridges the existing Review-domain
 * LLMProvider. Future provider work can implement ModelDriver directly;
 * raw API keys and provider objects always stay below the Kernel's
 * SyscallGateway (see facades/llm-facade.ts).
 */

import type { z } from "zod";
import type { ReviewAgentName, ReviewFinding, TokenUsage } from "@consistency/schema";

export interface ModelStructuredRequest<T> {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly schema: z.ZodType<T>;
  readonly schemaName: string;
}

export interface ModelTextRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

export interface ModelAgentFindingsRequest {
  readonly agent: ReviewAgentName;
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

export interface ModelResult<T> {
  readonly data: T;
  readonly tokenUsage?: TokenUsage;
}

/** Generic ModelDriver contract. */
export interface ModelDriver {
  readonly provider: "mock" | "deepseek" | "openai";
  readonly model?: string;
  invokeStructured<T>(request: ModelStructuredRequest<T>): Promise<ModelResult<T>>;
  invokeAgentFindings(request: ModelAgentFindingsRequest): Promise<ModelResult<ReviewFinding[]>>;
  invokeSummary(request: ModelTextRequest): Promise<ModelResult<{ summary: string }>>;
}

/**
 * The legacy apps/api LLMProvider surface (structural — no import from
 * apps/api, so this package stays decoupled).
 */
export interface LegacyProviderLike {
  readonly name: "mock" | "deepseek" | "openai";
  readonly model?: string;
  invokeWithSchema<T>(request: {
    schema: z.ZodType<T>;
    schemaName: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ data: T; tokenUsage?: TokenUsage }>;
  generateAgentRun(request: {
    agent: ReviewAgentName;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ data: { findings: ReviewFinding[] }; tokenUsage?: TokenUsage }>;
  generateSummary(request: {
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ data: { summary: string }; tokenUsage?: TokenUsage }>;
}

/**
 * Compatibility adapter: legacy Review-domain LLMProvider → generic
 * ModelDriver. Preserves provider behavior exactly (fixtures, parsing,
 * structured repair), which is what keeps parity with the old runtime.
 */
export function legacyProviderModelDriver(provider: LegacyProviderLike): ModelDriver {
  return {
    provider: provider.name,
    model: provider.model,
    invokeStructured: (request) => provider.invokeWithSchema(request),
    invokeAgentFindings: async (request) => {
      const result = await provider.generateAgentRun(request);
      return { data: result.data.findings, tokenUsage: result.tokenUsage };
    },
    invokeSummary: (request) => provider.generateSummary(request),
  };
}
