/**
 * RepositorySnapshot identity policy (Kernel side).
 *
 * The Kernel owns snapshot IDENTITY and REFERENCE semantics. The
 * @consistency/repository package implements Git-backed materialization and
 * read adapters against this contract (dependency direction: repository →
 * kernel, never the reverse).
 *
 * SECURITY: a snapshot URI/reference is an IDENTIFIER, not an authorization
 * credential. Possessing `snapshot://…` grants nothing — repository access
 * stays a CapabilityBroker/syscall concern.
 */

/** Branded, serializable RepositorySnapshot identifier. */
export type RepositorySnapshotId = string & { readonly __brand: "RepositorySnapshotId" };

/** Cast a plain string to a RepositorySnapshotId after validating it is non-empty. */
export function asRepositorySnapshotId(raw: string): RepositorySnapshotId {
  if (!raw || raw.trim() === "") {
    throw new TypeError("RepositorySnapshotId must be non-empty");
  }
  return raw as RepositorySnapshotId;
}

/**
 * The semantic identity of a snapshot: what makes two snapshots equivalent.
 * Snapshot IDs are instance-specific; THIS shape is the semantic state.
 */
export interface SnapshotIdentity {
  /** Canonical `owner/name`, e.g. `sk1ua/ConsistenCy`. */
  readonly repository: string;
  readonly headSha: string;
  readonly baseSha?: string;
}

export const SNAPSHOT_URI_SCHEME = "snapshot://";

export class SnapshotUriError extends Error {
  constructor(message: string) {
    super(`Invalid snapshot URI: ${message}`);
    this.name = "SnapshotUriError";
  }
}

function assertUriSegment(segment: string | undefined, label: string): string {
  if (!segment || segment.trim() === "" || segment.includes(" ") || segment.includes("\\")) {
    throw new SnapshotUriError(`${label} must be a non-empty segment`);
  }
  return segment;
}

/**
 * Canonical snapshot reference: `snapshot://<owner>/<repo>/<snapshotId>`.
 * Contains no secrets and no credentials.
 */
export function formatSnapshotUri(repository: string, snapshotId: RepositorySnapshotId): string {
  assertUriSegment(repository, "repository");
  assertUriSegment(snapshotId, "snapshotId");
  if (repository.split("/").length !== 2) {
    throw new SnapshotUriError(`repository must be owner/name, got ${JSON.stringify(repository)}`);
  }
  if (snapshotId.includes("/")) {
    throw new SnapshotUriError("snapshotId must not contain '/'");
  }
  return `${SNAPSHOT_URI_SCHEME}${repository}/${snapshotId}`;
}

/** Parse a snapshot URI back into its parts. Fails closed on malformed input. */
export function parseSnapshotUri(uri: string): {
  readonly repository: string;
  readonly snapshotId: RepositorySnapshotId;
} {
  if (typeof uri !== "string" || !uri.startsWith(SNAPSHOT_URI_SCHEME)) {
    throw new SnapshotUriError(`expected scheme ${SNAPSHOT_URI_SCHEME}`);
  }
  const rest = uri.slice(SNAPSHOT_URI_SCHEME.length);
  const lastSlash = rest.lastIndexOf("/");
  if (lastSlash <= 0 || lastSlash === rest.length - 1) {
    throw new SnapshotUriError("expected repository/snapshotId");
  }
  const repository = assertUriSegment(rest.slice(0, lastSlash), "repository");
  const snapshotId = asRepositorySnapshotId(assertUriSegment(rest.slice(lastSlash + 1), "snapshotId"));
  if (repository.split("/").length !== 2) {
    throw new SnapshotUriError(`repository must be owner/name, got ${JSON.stringify(repository)}`);
  }
  return { repository, snapshotId };
}
