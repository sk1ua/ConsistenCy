import {
  findingScoreSchema,
  normalizeFindingScore,
  recoverFindingScores,
  type FindingScore,
  reviewFindingSchema,
  reviewAgentNameSchema,
  tokenUsageSchema,
  tokenUsageFromError,
  recordTokenUsageOnError,
  type LLMStreamEvent,
  type ReviewFinding,
  type TokenUsage
} from "@consistency/schema";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { logger } from "../../config/logger";
import { sanitizeExecutionError } from "../../security/redact";
import type {
  FindingGenerationRequest,
  LLMProvider,
  LLMStreamRequest,
  StructuredInvocation,
  StructuredResult
} from "./types";

/**
 * The synthesizer's single call returns BOTH the prose summary and the
 * per-finding relevance scores, so scoring never costs a second request.
 */
const summarySchema = z.object({
  summary: z.string().trim().min(1),
  scores: z.array(z.preprocess(normalizeFindingScore, findingScoreSchema)).optional()
}).strict();

function findingsSchemaForAgent(agent: z.infer<typeof reviewAgentNameSchema>) {
  return z.object({
    findings: z.array(reviewFindingSchema)
  }).strict().superRefine((value, context) => {
    value.findings.forEach((finding, index) => {
      if (finding.agent !== agent) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Finding agent must be ${agent}`,
          path: ["findings", index, "agent"]
        });
      }
    });
  });
}

export class StructuredOutputError extends Error {
  constructor(message: string, public override readonly cause?: unknown, public readonly tokenUsage?: TokenUsage, public readonly findingScores?: readonly FindingScore[]) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

type CompletionResponse = {
  content: string;
  tokenUsage?: TokenUsage;
};

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

export abstract class BaseLLMProvider implements LLMProvider {
  abstract readonly name: LLMProvider["name"];
  readonly model?: string;
  protected abstract complete(input: {
    systemPrompt: string;
    userPrompt: string;
    schemaName: string;
    jsonSchema: unknown;
    signal?: AbortSignal;
  }): Promise<CompletionResponse>;

  async invokeWithSchema<T>(request: StructuredInvocation<T>): Promise<StructuredResult<T>> {
    const completeCall = async (repairPrompt: string | undefined) => {
      return this.complete({
        systemPrompt: `${request.systemPrompt}\nReturn only valid JSON.`,
        userPrompt: repairPrompt ?? request.userPrompt,
        schemaName: request.schemaName,
        jsonSchema: zodToJsonSchema(request.schema, request.schemaName),
        signal: request.signal
      });
    };

    let previousContent = "";
    let lastError: unknown;
    let accumulatedUsage: TokenUsage | undefined;
    const recoveredScores = new Map<string, FindingScore>();
    const agent = request.agent ?? (request.schemaName === "review-plan" ? "Planner" : request.schemaName === "review-summary" ? "Synthesizer" : request.schemaName);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // A cancelled run must not spend its repair attempt on a doomed call.
      if (request.signal?.aborted) {
        const reason = request.signal.reason ?? new Error("LLM request was cancelled before dispatch");
        recordTokenUsageOnError(reason, accumulatedUsage);
        throw reason;
      }
      let attemptUsage: TokenUsage | undefined;
      let attemptError: unknown;
      try {
        const repairPrompt = attempt === 0
          ? undefined
          : `${request.userPrompt}\n\nThe previous JSON failed schema validation. Produce a corrected JSON object only. Previous output:\n${previousContent.slice(0, 12_000)}`;
        const completion = await completeCall(repairPrompt);
        attemptUsage = parseTokenUsage(completion.tokenUsage);
        if (attemptUsage) accumulatedUsage = sumTokenUsage(accumulatedUsage, attemptUsage);
        if (request.signal?.aborted) {
          throw request.signal.reason ?? new Error("LLM request was cancelled during dispatch");
        }
        previousContent = completion.content;
        const decoded = extractJson(completion.content);
        if (request.schemaName === "review-summary" && decoded !== null && typeof decoded === "object" && "scores" in decoded) {
          for (const entry of recoverFindingScores(decoded.scores)) recoveredScores.set(entry.id, entry);
        }
        return { data: request.schema.parse(decoded), tokenUsage: accumulatedUsage };
      } catch (error) {
        attemptError = error;
        lastError = error;
        // Transport failures may carry paid usage even without a completion.
        // JSON/schema failures already counted the returned completion above.
        if (!attemptUsage) {
          attemptUsage = tokenUsageFromError(error);
          if (attemptUsage) accumulatedUsage = sumTokenUsage(accumulatedUsage, attemptUsage);
        }
        if (request.signal?.aborted) break;
      } finally {
        logger.info({
          operation: "structured", schemaName: request.schemaName, agent, attempt: attempt + 1,
          status: attemptError === undefined ? "completed" : "failed",
          ...(attemptError === undefined ? {} : { reason: sanitizeExecutionError(attemptError instanceof Error ? attemptError.message : String(attemptError)) }),
          inputTokens: attemptUsage?.inputTokens ?? null,
          outputTokens: attemptUsage?.outputTokens ?? null,
          cachedTokens: attemptUsage?.cachedTokens ?? 0,
          promptTokens: attemptUsage?.inputTokens !== undefined ? attemptUsage.inputTokens + (attemptUsage.cachedTokens ?? 0) : null,
          cacheReadStatus: attemptUsage?.cacheReadStatus ?? "unavailable_or_zero"
        }, "llm.invoke");
      }
    }
    if (request.signal?.aborted) {
      const reason = request.signal.reason ?? lastError ?? new Error("LLM request was cancelled");
      recordTokenUsageOnError(reason, accumulatedUsage);
      throw reason;
    }
    const detail = sanitizeExecutionError(lastError instanceof Error ? lastError.message : String(lastError));
    throw new StructuredOutputError(
      `Provider ${this.name} failed schema ${request.schemaName} after one repair attempt: ${detail.slice(0, 800)}`,
      lastError,
      accumulatedUsage,
      [...recoveredScores.values()]
    );
  }

  async generateStructuredFinding(request: FindingGenerationRequest): Promise<StructuredResult<ReviewFinding[]>> {
    const result = await this.invokeWithSchema({
      schema: findingsSchemaForAgent(request.agent),
      schemaName: "review-findings",
      agent: request.agent,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      signal: request.signal
    });
    return { data: result.data.findings, tokenUsage: result.tokenUsage };
  }

  async generateAgentRun(request: FindingGenerationRequest): Promise<StructuredResult<{ findings: ReviewFinding[] }>> {
    const result = await this.generateStructuredFinding(request);
    return { data: { findings: result.data }, tokenUsage: result.tokenUsage };
  }

  generateSummary(request: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }): Promise<StructuredResult<{ summary: string }>> {
    return this.invokeWithSchema({ ...request, schema: summarySchema, schemaName: "review-summary" });
  }

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    try {
      const completion = await this.complete({
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        schemaName: "notebook-response",
        jsonSchema: undefined
      });
      const chunkSize = 160;
      for (let offset = 0; offset < completion.content.length; offset += chunkSize) {
        if (request.signal?.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
        yield { kind: "text_delta", text: completion.content.slice(offset, offset + chunkSize) };
      }
      if (completion.tokenUsage) yield { kind: "usage", usage: completion.tokenUsage };
      yield { kind: "completed" };
    } catch (error) {
      yield { kind: "failed", error: error instanceof Error ? error.message : "LLM stream failed" };
    }
  }
}

function sumTokenUsage(left: TokenUsage | undefined, right: TokenUsage): TokenUsage {
  const result: TokenUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedTokens", "promptTokens"] as const) {
    if (left?.[key] !== undefined || right[key] !== undefined) result[key] = (left?.[key] ?? 0) + (right[key] ?? 0);
  }
  result.cacheReadStatus = left?.cacheReadStatus === "reported" || right.cacheReadStatus === "reported" ? "reported" : "unavailable_or_zero";
  return result;
}

export function parseTokenUsage(input: unknown): TokenUsage | undefined {
  const parsed = tokenUsageSchema.safeParse(input);
  if (!parsed.success || !Object.values(parsed.data).some(value => value !== undefined)) return undefined;
  return parsed.data;
}
