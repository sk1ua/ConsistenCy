import type { AgentRun, ReviewAgentName, ReviewFinding, TokenUsage } from "@consistency/schema";
import type { z } from "zod";

export type StructuredInvocation<T> = {
  schema: z.ZodType<T>;
  schemaName: string;
  systemPrompt: string;
  userPrompt: string;
};

export type StructuredResult<T> = {
  data: T;
  tokenUsage?: TokenUsage;
};

export type FindingGenerationRequest = {
  agent: ReviewAgentName;
  systemPrompt: string;
  userPrompt: string;
};

export interface LLMProvider {
  readonly name: "mock" | "deepseek" | "openai";
  invokeWithSchema<T>(request: StructuredInvocation<T>): Promise<StructuredResult<T>>;
  generateStructuredFinding(request: FindingGenerationRequest): Promise<StructuredResult<ReviewFinding[]>>;
  generateAgentRun(request: FindingGenerationRequest): Promise<StructuredResult<Pick<AgentRun, "findings">>>;
  generateSummary(request: { systemPrompt: string; userPrompt: string }): Promise<StructuredResult<{ summary: string }>>;
}
