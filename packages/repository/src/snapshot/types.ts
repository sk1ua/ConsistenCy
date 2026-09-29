/**
 * Repository snapshot types — the materialization-side contract.
 */

import type { RepositorySnapshotId, SnapshotIdentity } from "@consistency/kernel";

export type { RepositorySnapshotId, SnapshotIdentity };

/** One file entry in the immutable snapshot tree. */
export interface SnapshotFileEntry {
  /** Repository-relative path with `/` separators. */
  readonly path: string;
  /** Git blob object id for the file at the snapshot SHA. */
  readonly blobSha: string;
}

/** A file read from the snapshot (content is a snapshot-fixed string). */
export interface SnapshotFile {
  readonly path: string;
  readonly content: string;
  /** SHA-256 hex digest of `content` (utf8). */
  readonly contentHash: string;
}

export interface SnapshotFileMetadata {
  readonly path: string;
  readonly blobSha: string;
}

export type SnapshotDiffStatus = "added" | "modified" | "deleted";

/** Path-level diff entry between baseSha and headSha. */
export interface SnapshotDiffEntry {
  readonly path: string;
  readonly status: SnapshotDiffStatus;
}

export interface CreateRepositorySnapshotOptions {
  /** Local Git repository path (read-only access). */
  readonly repositoryPath: string;
  /** Canonical `owner/name` identity of the repository. */
  readonly repository: string;
  /** The pinned head commit. Must exist in the repository. */
  readonly headSha: string;
  readonly baseSha?: string;
  /** Instance-specific snapshot id; generated when omitted. */
  readonly snapshotId?: RepositorySnapshotId;
}
