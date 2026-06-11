import { createReviewAgentNode } from "./common";
import type { AgentDependencies } from "./types";

export const createCorrectnessAgentNode = (dependencies: AgentDependencies) =>
  createReviewAgentNode("Correctness", dependencies);
