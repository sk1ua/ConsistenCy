import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { LocalGitAdapter, selectGitHubRemote, type GitRemoteObservation } from "@consistency/vcs-core";
import type { InternalLocalRepositoryRegistrationRequest } from "@consistency/schema";
import { AuditDomainError } from "./store";

export type LocalWorktreeProbe = Pick<LocalGitAdapter, "getRepositoryRoot" | "getRemotes" | "resolveRemoteDefaultBranch">;

export type LocalRepositoryRegistrationDependencies = {
  createProbe?: (root: string) => LocalWorktreeProbe;
};

export type ValidatedLocalRepositoryRegistration = {
  serverLocator: string;
  displayName: string;
  monitoringEnabled: boolean;
  remoteFullName?: string;
  defaultBranch?: string;
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

  const probe = dependencies.createProbe?.(serverLocator)
    ?? new LocalGitAdapter({ root: serverLocator, timeoutMs: 5_000 });
  try {
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

  let remotes: readonly GitRemoteObservation[] = [];
  try {
    remotes = await probe.getRemotes();
  } catch {
    remotes = [];
  }
  const selectedRemote = selectGitHubRemote(remotes);
  const remoteFullName = selectedRemote?.githubFullName;
  let defaultBranch: string | undefined;
  if (selectedRemote !== undefined) {
    try {
      defaultBranch = await probe.resolveRemoteDefaultBranch(selectedRemote.name);
    } catch {
      defaultBranch = undefined;
    }
  }

  return {
    serverLocator,
    displayName: input.displayName ?? basename(serverLocator),
    monitoringEnabled: input.monitoringEnabled ?? true,
    ...(remoteFullName === undefined ? {} : { remoteFullName }),
    ...(defaultBranch === undefined ? {} : { defaultBranch })
  };
}
