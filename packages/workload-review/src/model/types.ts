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
import type { FindingScore, ReviewAgentName, ReviewFinding, TokenUsage } from "@consistency/schema";

/**
 * The summary call carries the per-finding relevance scores as well: the
 * synthesizer scores findings through the call it already makes instead of
 * issuing a second one.
 */
export interface SummaryResult {
  readonly summary: string;
  readonly scores?: readonly FindingScore[];
}

export interface ModelStructuredRequest<T> {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly schema: z.ZodType<T>;
  readonly schemaName: string;
  /**
   * Run-scoped cancellation (audit P1-07①). Supplied by the trusted backend —
   * agents never fabricate it — so cancelRun()/shutdown can abort an in-flight
   * provider request at the transport level.
   */
  readonly signal?: AbortSignal;
}

export interface ModelTextRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly signal?: AbortSignal;
}

export interface ModelAgentFindingsRequest {
  readonly agent: ReviewAgentName;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly signal?: AbortSignal;
}

export interface ModelResult<T> {
  readonly data: T;
  readonly tokenUsage?: TokenUsage;
}

/** Generic ModelDriver contract. */
export interface ModelDriver {
  readonly provider: string;
  readonly model?: string;
  invokeStructured<T>(request: ModelStructuredRequest<T>): Promise<ModelResult<T>>;
  invokeAgentFindings(request: ModelAgentFindingsRequest): Promise<ModelResult<ReviewFinding[]>>;
  invokeSummary(request: ModelTextRequest): Promise<ModelResult<SummaryResult>>;
  /**
   * Optional raw completion. Used only by the opt-in lean generalist, whose
   * JSON is not a review-finding tool schema. Unset drivers never see the call.
   */
  invokeRaw?(request: ModelTextRequest): Promise<ModelResult<string>>;
}

/**
 * The legacy apps/api LLMProvider surface (structural — no import from
 * apps/api, so this package stays decoupled).
 */
export interface LegacyProviderLike {
  readonly name: string;
  readonly model?: string;
  invokeWithSchema<T>(request: {
    schema: z.ZodType<T>;
    schemaName: string;
    systemPrompt: string;
    userPrompt: string;
    signal?: AbortSignal;
  }): Promise<{ data: T; tokenUsage?: TokenUsage }>;
  generateAgentRun(request: {
    agent: ReviewAgentName;
    systemPrompt: string;
    userPrompt: string;
    signal?: AbortSignal;
  }): Promise<{ data: { findings: ReviewFinding[] }; tokenUsage?: TokenUsage }>;
  generateSummary(request: {
    systemPrompt: string;
    userPrompt: string;
    signal?: AbortSignal;
  }): Promise<{ data: SummaryResult; tokenUsage?: TokenUsage }>;
  /**
   * Optional raw completion. Absent providers keep the previous adapter
   * surface; only the opt-in generalist asks for it.
   */
  completeRaw?(request: {
    systemPrompt: string;
    userPrompt: string;
    signal?: AbortSignal;
  }): Promise<{ content: string; tokenUsage?: TokenUsage }>;
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
    ...(provider.completeRaw ? {
      invokeRaw: async (request: ModelTextRequest) => {
        const result = await provider.completeRaw!(request);
        return { data: result.content, tokenUsage: result.tokenUsage };
      }
    } : {})
  };
}
