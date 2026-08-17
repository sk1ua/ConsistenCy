import { WORKING_TREE_REV } from "@consistency/schema";
import type { ContextBuilder } from "../workloadRuntime";
import { buildPRContext } from "./buildPRContext";
import { buildLocalContext, type BuildLocalContextDependencies } from "./buildLocalContext";

export type ContextRouterDependencies = {
  github: Parameters<typeof buildPRContext>[1];
  local?: BuildLocalContextDependencies;
};

/**
 * Selects a context source from the job's access mode, so the review workflow
 * stays unaware of where a diff came from.
 */
export function createContextBuilder(dependencies: ContextRouterDependencies): ContextBuilder {
  return async (input) => {
    if (input.accessMode === "local_git") {
      if (input.repoPath === undefined) {
        throw new Error("A local review requires repoPath");
      }
      // A working-tree review has no head commit; anything else is a committed
      // range and is diffed from its merge base.
      const range = input.headSha === WORKING_TREE_REV
        ? {}
        : { baseRef: input.baseSha, headRef: input.headSha };
      return buildLocalContext(
        { jobId: input.jobId, repoPath: input.repoPath, ...range },
        dependencies.local
      );
    }

    if (input.pullRequestNumber === undefined) {
      throw new Error(`A ${input.accessMode ?? "github_app"} review requires pullRequestNumber`);
    }
    return buildPRContext(
      {
        jobId: input.jobId,
        repositoryFullName: input.repositoryFullName,
        pullRequestNumber: input.pullRequestNumber,
        installationId: input.installationId,
        accessMode: input.accessMode,
        baseSha: input.baseSha,
        headSha: input.headSha
      },
      dependencies.github
    );
  };
}
