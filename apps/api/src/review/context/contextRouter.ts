import { WORKING_TREE_REV, type VcsChangedFile } from "@consistency/schema";
import type { ContextBuilder } from "../workloadRuntime";
import { buildPRContext } from "./buildPRContext";
import { buildLocalContext, type BuildLocalContextDependencies } from "./buildLocalContext";

export type WorkingTreeSurfaceCapture = {
  jobId: string;
  /** HEAD at capture time — the exact base the diff was built against. */
  baseSha: string;
  headSha?: string;
  files: VcsChangedFile[];
  /**
   * Review-time content of changed files (the context loader's redacted,
   * secret-path-free projection). Persisted with the surface so Notebook
   * reads resolve review-time content after drift (audit P1-06③).
   */
  fileContents: Record<string, string>;
  baseFileContents: Record<string, string>;
};

export type ContextRouterDependencies = {
  github: Parameters<typeof buildPRContext>[1];
  local?: BuildLocalContextDependencies;
  /**
   * Fired when a WORKING-TREE review's change surface is captured (audit
   * P1-01). Working-tree reviews have no head commit, so the host persists
   * this surface here — before review execution proceeds — making the
   * review-time diff resolvable after the working tree drifts or the API
   * restarts. Range and GitHub reviews are already SHA-pinned and never fire
   * this hook. A throwing hook fails the review by design: the snapshot is
   * the job's identity guarantee, and silently proceeding without it would
   * recreate the drift this gate exists to prevent.
   */
  onWorkingTreeSurface?: (capture: WorkingTreeSurfaceCapture) => void;
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
      const { context, changedSurface } = await buildLocalContext(
        { jobId: input.jobId, repoPath: input.repoPath, ...range },
        dependencies.local
      );
      dependencies.onWorkingTreeSurface?.({
        jobId: input.jobId,
        baseSha: context.baseSha,
        headSha: input.headSha,
        files: changedSurface,
        fileContents: context.fileContents,
        baseFileContents: context.baseFileContents
      });
      return context;
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
