import { createReviewAgentNode } from "./common";
import type { AgentDependencies } from "./types";

/**
 * Audits structural consequences of a change: contract breakage, schema drift,
 * and coupling. Distinct from Maintainability, which judges how the code reads;
 * this one judges what the change does to callers.
 */
export const createArchitectureAuditorNode = (dependencies: AgentDependencies) =>
  createReviewAgentNode("ArchitectureAuditor", dependencies);
