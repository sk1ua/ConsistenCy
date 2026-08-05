import { describe, expect, it } from "vitest";
import { reviewAgentNameSchema, type PRReviewContext } from "@consistency/schema";
import { buildAgentPrompt } from "./prompt";
import { REVIEW_AGENT_NAMES } from "./types";

const context: PRReviewContext = {
  jobId: "job-1",
  source: "github_pr",
  repositoryFullName: "sk1ua/ConsistenCy",
  pullRequestNumber: 34,
  baseSha: "base123",
  headSha: "head456",
  changedFiles: [{
    path: "packages/schema/src/job.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    patch: "@@ -1,2 +1,3 @@"
  }],
  diff: "diff --git a/packages/schema/src/job.ts b/packages/schema/src/job.ts",
  fileContents: { "packages/schema/src/job.ts": "export type Job = {};\n" },
  baseFileContents: {},
  projectMetadata: {},
  workspacePath: "C:/workspace/job-1"
};

describe("review agent registry", () => {
  it("keeps every executable agent inside the shared agent-name enum", () => {
    for (const agent of REVIEW_AGENT_NAMES) {
      expect(() => reviewAgentNameSchema.parse(agent)).not.toThrow();
    }
  });

  it("includes the architecture auditor", () => {
    expect(REVIEW_AGENT_NAMES).toContain("ArchitectureAuditor");
  });

  it("builds a distinct, non-empty prompt for every registered agent", () => {
    // A half-registered agent would otherwise ship with an empty focus section.
    const userPrompts = new Set<string>();
    for (const agent of REVIEW_AGENT_NAMES) {
      const { systemPrompt, userPrompt } = buildAgentPrompt(agent, context, undefined, "en-US");
      expect(systemPrompt.length, agent).toBeGreaterThan(0);
      expect(userPrompt.length, agent).toBeGreaterThan(0);
      userPrompts.add(systemPrompt);
    }
    expect(userPrompts.size).toBe(REVIEW_AGENT_NAMES.length);
  });

  it("gives the auditor a contract-and-schema focus, not a style focus", () => {
    const { systemPrompt } = buildAgentPrompt("ArchitectureAuditor", context, undefined, "en-US");
    expect(systemPrompt).toMatch(/contract|schema|coupling/i);
  });
});
