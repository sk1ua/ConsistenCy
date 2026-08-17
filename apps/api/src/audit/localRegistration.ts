import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { LocalGitAdapter } from "@consistency/vcs-core";
import type { InternalLocalRepositoryRegistrationRequest } from "@consistency/schema";
import { AuditDomainError } from "./store";

export type LocalWorktreeProbe = Pick<LocalGitAdapter, "getRepositoryRoot">;

export type LocalRepositoryRegistrationDependencies = {
  createProbe?: (root: string) => LocalWorktreeProbe;
};

export type ValidatedLocalRepositoryRegistration = {
  serverLocator: string;
  displayName: string;
  monitoringEnabled: boolean;
};

/**
 * Resolves and validates a desktop-selected Git worktree without running any
 * repository code. Error messages intentionally omit the submitted path.
 */
export async function validateLocalRepositoryRegistration(
  input: InternalLocalRepositoryRegistrationRequest,
  dependencies: LocalRepositoryRegistrationDependencies = {}
): Promise<ValidatedLocalRepositoryRegistration> {
  if (!isAbsolute(input.path)) {
    throw new AuditDomainError(
      "Local repository path must be absolute",
      "LOCAL_REPOSITORY_PATH_INVALID",
      400
    );
  }

  let serverLocator: string;
  try {
    serverLocator = await realpath(input.path);
    if (!(await stat(serverLocator)).isDirectory()) {
      throw new AuditDomainError(
        "Local repository path must be a directory",
        "LOCAL_REPOSITORY_NOT_A_DIRECTORY",
        400
      );
    }
  } catch (error) {
    if (error instanceof AuditDomainError) throw error;
    throw new AuditDomainError(
      "Local repository directory was not found",
      "LOCAL_REPOSITORY_NOT_FOUND",
      400
    );
  }

  try {
    const probe = dependencies.createProbe?.(serverLocator)
      ?? new LocalGitAdapter({ root: serverLocator, timeoutMs: 5_000 });
    const worktreeRoot = await realpath(await probe.getRepositoryRoot());
    if (worktreeRoot !== serverLocator) {
      throw new AuditDomainError(
        "Select the root directory of the Git worktree",
        "LOCAL_REPOSITORY_ROOT_REQUIRED",
        400
      );
    }
  } catch (error) {
    if (error instanceof AuditDomainError) throw error;
    throw new AuditDomainError(
      "Selected directory is not a readable Git worktree",
      "LOCAL_REPOSITORY_NOT_GIT_WORKTREE",
      400
    );
  }

  return {
    serverLocator,
    displayName: input.displayName ?? basename(serverLocator),
    monitoringEnabled: input.monitoringEnabled ?? true
  };
}
