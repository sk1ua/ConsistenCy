import { RunnableLambda } from "@langchain/core/runnables";
import {
  reviewFindingSchema,
  reviewAgentNameSchema,
  tokenUsageSchema,
  type ReviewFinding,
  type TokenUsage
} from "@consistency/schema";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  FindingGenerationRequest,
  LLMProvider,
  StructuredInvocation,
  StructuredResult
} from "./types";

const summarySchema = z.object({ summary: z.string().trim().min(1) }).strict();

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
  constructor(message: string, public override readonly cause?: unknown) {
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
  protected abstract complete(input: {
    systemPrompt: string;
    userPrompt: string;
    schemaName: string;
    jsonSchema: unknown;
  }): Promise<CompletionResponse>;

  async invokeWithSchema<T>(request: StructuredInvocation<T>): Promise<StructuredResult<T>> {
    const runnable = RunnableLambda.from(async (repairPrompt: string | undefined) => {
      return this.complete({
        systemPrompt: `${request.systemPrompt}\nReturn only valid JSON.`,
        userPrompt: repairPrompt ?? request.userPrompt,
        schemaName: request.schemaName,
        jsonSchema: zodToJsonSchema(request.schema, request.schemaName)
      });
    });

    let previousContent = "";
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const repairPrompt = attempt === 0
          ? undefined
          : `${request.userPrompt}\n\nThe previous JSON failed schema validation. Produce a corrected JSON object only. Previous output:\n${previousContent.slice(0, 12_000)}`;
        const completion = await runnable.invoke(repairPrompt);
        previousContent = completion.content;
        return {
          data: request.schema.parse(extractJson(completion.content)),
          tokenUsage: completion.tokenUsage
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new StructuredOutputError(`Provider ${this.name} failed schema ${request.schemaName} after one repair attempt`, lastError);
  }

  async generateStructuredFinding(request: FindingGenerationRequest): Promise<StructuredResult<ReviewFinding[]>> {
    const result = await this.invokeWithSchema({
      schema: findingsSchemaForAgent(request.agent),
      schemaName: `${request.agent.toLowerCase()}-findings`,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt
    });
    return { data: result.data.findings, tokenUsage: result.tokenUsage };
  }

  async generateAgentRun(request: FindingGenerationRequest): Promise<StructuredResult<{ findings: ReviewFinding[] }>> {
    const result = await this.generateStructuredFinding(request);
    return { data: { findings: result.data }, tokenUsage: result.tokenUsage };
  }

  generateSummary(request: { systemPrompt: string; userPrompt: string }): Promise<StructuredResult<{ summary: string }>> {
    return this.invokeWithSchema({ ...request, schema: summarySchema, schemaName: "review-summary" });
  }
}

export function parseTokenUsage(input: unknown): TokenUsage | undefined {
  const parsed = tokenUsageSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
