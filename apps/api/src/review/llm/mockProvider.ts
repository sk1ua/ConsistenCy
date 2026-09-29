/**
 * Isolated-test double for LLMProvider. AGENTS.md permits this only for CI
 * and unit orchestration checks. It is never a product runtime: factory.ts
 * and settings never select `mock`, and product reviews require a real Pi
 * provider (DeepSeek, OpenAI, or Anthropic).
 */
import { reviewPlanSchema, type LLMStreamEvent, type ReviewAgentName } from "@consistency/schema";
import { BaseLLMProvider } from "./provider";
import type { LLMStreamRequest } from "./types";

const REVIEW_AGENTS: ReviewAgentName[] = ["Security", "Correctness", "Maintainability", "Test", "Style"];

export class MockLLMProvider extends BaseLLMProvider {
  readonly name = "mock" as const;
  override readonly model = "mock-fixture";

  constructor(private readonly fixtures: Record<string, unknown> = {}) {
    super();
  }

  protected override async complete(input: { schemaName: string }) {
    const fixture = this.fixtures[input.schemaName];
    if (fixture !== undefined) return { content: JSON.stringify(fixture) };
    if (input.schemaName === "review-plan") {
      return {
        content: JSON.stringify(reviewPlanSchema.parse({
          enabledAgents: REVIEW_AGENTS,
          skippedAgents: [],
          riskAreas: ["changed code"],
          reason: "Mock provider enables the deterministic review agent set.",
          focusAreas: []
        }))
      };
    }
    if (input.schemaName === "review-summary") {
      return { content: JSON.stringify({ summary: "No confirmed issues were identified by the enabled review agents." }) };
    }
    return { content: JSON.stringify({ findings: [] }) };
  }

  override async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    if (request.signal?.aborted) {
      throw request.signal.reason ?? new Error("LLM request was cancelled");
    }
    const text = "基于当前 PR 的确定性证据，建议先沿着变更文件与调用关系核对影响范围，再对高风险信号安排针对性测试。具体依据已在下方引用中标出。";
    for (let offset = 0; offset < text.length; offset += 36) {
      if (request.signal?.aborted) {
        throw request.signal.reason ?? new Error("LLM request was cancelled");
      }
      yield { kind: "text_delta", text: text.slice(offset, offset + 36) };
    }
    yield { kind: "completed" };
  }
}
