import type { PRReviewContext, ReviewAccessMode, ReviewAgentName } from "@consistency/schema";
import type { ReviewJobStore } from "../../jobQueue";
import type { LLMProvider } from "../llm/types";

export const REVIEW_AGENT_NAMES = [
  "Security",
  "Correctness",
  "Maintainability",
  "Test",
  "Style",
  "ArchitectureAuditor"
] as const satisfies readonly ReviewAgentName[];

export type ExecutableReviewAgent = typeof REVIEW_AGENT_NAMES[number];

export type AgentDependencies = {
  provider: LLMProvider;
  jobStore: ReviewJobStore;
  reportLanguage: "zh-CN" | "en-US";
};

export type ContextBuilder = (input: {
  jobId: string;
  repositoryFullName: string;
  /** Absent for local reviews, which have no pull request. */
  pullRequestNumber?: number;
  /** Absolute checkout path; set only when accessMode is local_git. */
  repoPath?: string;
  installationId?: number;
  accessMode?: ReviewAccessMode;
  baseSha: string;
  headSha: string;
}) => Promise<PRReviewContext>;
