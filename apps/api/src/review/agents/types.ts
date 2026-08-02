import type { PRReviewContext, ReviewAccessMode, ReviewAgentName } from "@consistency/schema";
import type { ReviewJobStore } from "../../jobQueue";
import type { LLMProvider } from "../llm/types";

export const REVIEW_AGENT_NAMES = [
  "Security",
  "Correctness",
  "Maintainability",
  "Test",
  "Style"
] as const satisfies readonly ReviewAgentName[];

export type ExecutableReviewAgent = typeof REVIEW_AGENT_NAMES[number];

export type AgentDependencies = {
  provider: LLMProvider;
  jobStore: ReviewJobStore;
};

export type ContextBuilder = (input: {
  jobId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  installationId?: number;
  accessMode?: ReviewAccessMode;
  baseSha: string;
  headSha: string;
}) => Promise<PRReviewContext>;
