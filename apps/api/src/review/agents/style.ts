import { createReviewAgentNode } from "./common";
import type { AgentDependencies } from "./types";

export const createStyleAgentNode = (dependencies: AgentDependencies) =>
  createReviewAgentNode("Style", dependencies);
