import { createReviewAgentNode } from "./common";
import type { AgentDependencies } from "./types";

export const createMaintainabilityAgentNode = (dependencies: AgentDependencies) =>
  createReviewAgentNode("Maintainability", dependencies);
