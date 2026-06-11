import { reviewPlanSchema, type ReviewAgentName } from "@consistency/schema";
import { BaseLLMProvider } from "./provider";

const REVIEW_AGENTS: ReviewAgentName[] = ["Security", "Correctness", "Maintainability", "Test", "Style"];

export class MockLLMProvider extends BaseLLMProvider {
  readonly name = "mock" as const;

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
          reason: "Mock provider enables the deterministic review agent set."
        }))
      };
    }
    if (input.schemaName === "review-summary") {
      return { content: JSON.stringify({ summary: "No confirmed issues were identified by the enabled review agents." }) };
    }
    return { content: JSON.stringify({ findings: [] }) };
  }
}
