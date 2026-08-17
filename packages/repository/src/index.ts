/**
 * @consistency/repository — Git-backed RepositorySnapshot materialization.
 *
 * Dependency direction: repository → kernel (snapshot identity policy + safe
 * path rules). The Kernel never imports this package.
 */

export { GitCommandError, runGit } from "./git/git-runner.js";
export {
  RepositorySnapshot,
  SnapshotPathError,
  SnapshotFileNotFoundError,
  SnapshotDiffUnavailableError,
} from "./snapshot/snapshot.js";
export type {
  CreateRepositorySnapshotOptions,
  SnapshotDiffEntry,
  SnapshotDiffStatus,
  SnapshotFile,
  SnapshotFileEntry,
  SnapshotFileMetadata,
} from "./snapshot/types.js";

// Kernel snapshot identity policy (convenience re-exports — the kernel owns it)
export {
  asRepositorySnapshotId,
  formatSnapshotUri,
  parseSnapshotUri,
  SNAPSHOT_URI_SCHEME,
  SnapshotUriError,
} from "@consistency/kernel";
