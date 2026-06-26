import { createReviewAgentNode } from "./common";
import type { AgentDependencies } from "./types";

export const createSecurityAgentNode = (dependencies: AgentDependencies) =>
  createReviewAgentNode("Security", dependencies);
