import { createReviewAgentNode } from "./common";
import type { AgentDependencies } from "./types";

export const createTestAgentNode = (dependencies: AgentDependencies) =>
  createReviewAgentNode("Test", dependencies);
