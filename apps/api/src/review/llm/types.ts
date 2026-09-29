import type { AgentRun, LLMStreamEvent, LlmRouteRecord, ReviewAgentName, ReviewFinding, TokenUsage } from "@consistency/schema";
import type { z } from "zod";

export type StructuredInvocation<T> = {
  schema: z.ZodType<T>;
  schemaName: string;
  systemPrompt: string;
  userPrompt: string;
  /** Audit P1-07①: run-scoped cancellation — aborts the provider transport. */
  signal?: AbortSignal;
};

export type StructuredResult<T> = {
  data: T;
  tokenUsage?: TokenUsage;
};

export type FindingGenerationRequest = {
  agent: ReviewAgentName;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
};

export type LLMStreamRequest = {
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
};

export interface LLMProvider {
  /** Pi catalog provider id. Isolated tests may use an internal double named "mock". */
  readonly name: string;
  readonly model?: string;
  /**
   * H08 route record: the profile the run SELECTED (what the user asked for)
   * versus the profile ACTUALLY USED (after bounded fallback), plus the
   * run-start configRevision and the bounded attempt trail. Live-updating;
   * present only on routed providers. Carries no credentials or endpoint URLs.
   */
  readonly route?: LlmRouteRecord;
  invokeWithSchema<T>(request: StructuredInvocation<T>): Promise<StructuredResult<T>>;
  generateStructuredFinding(request: FindingGenerationRequest): Promise<StructuredResult<ReviewFinding[]>>;
  generateAgentRun(request: FindingGenerationRequest): Promise<StructuredResult<Pick<AgentRun, "findings">>>;
  generateSummary(request: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }): Promise<StructuredResult<{ summary: string }>>;
  stream?(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent>;
}
