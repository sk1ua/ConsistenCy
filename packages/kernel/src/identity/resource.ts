/**
 * Resource — what is being accessed.
 *
 * Resources are the objects over which Capabilities grant access rights.
 * Every resource kind corresponds to a concrete system object that the Kernel
 * can protect.
 */

/** Discriminated union of all resource kinds the Kernel manages. */
export type Resource =
  | RepositoryResource
  | SnapshotResource
  | EvidenceResource
  | AuditResource
  | WorkspaceResource
  | GitHubPublishResource
  | LLMResource
  | ASTResource;

export type ResourceKind = Resource["kind"];

/** A source-code repository (identified by owner/name). */
export interface RepositoryResource {
  readonly kind: "repository";
  /** Canonical `owner/name` format, e.g. `sk1ua/ConsistenCy`. */
  readonly id: string;
}

/**
 * An immutable snapshot of a repository at a specific commit.
 * The Kernel ensures the SHA is resolved and the tree is cached before
 * granting access.
 */
export interface SnapshotResource {
  readonly kind: "snapshot";
  readonly repositoryId: string;
  readonly sha: string;
}

/** The shared Evidence store for a given Run. */
export interface EvidenceResource {
  readonly kind: "evidence";
  readonly runId: string;
}

/** The Kernel's own audit log — access restricted to Ring 0. */
export interface AuditResource {
  readonly kind: "audit";
}

/** A temporary workspace directory for a given Run. */
export interface WorkspaceResource {
  readonly kind: "workspace";
  readonly runId: string;
}

/** GitHub PR / commit status publication endpoint. */
export interface GitHubPublishResource {
  readonly kind: "github.publish";
  readonly repositoryId: string;
  readonly pullNumber?: number;
}

/** An LLM provider invocation slot. */
export interface LLMResource {
  readonly kind: "llm";
  /** Provider name, e.g. `openai`, `anthropic`, `gemini`, `ollama`. */
  readonly provider: string;
}

/** Abstract Syntax Tree query interface over a snapshot. */
export interface ASTResource {
  readonly kind: "ast";
  readonly snapshotId: string;
}

// ---------------------------------------------------------------------------
// Scope — the sub-region within a resource that a Capability covers
// ---------------------------------------------------------------------------

/**
 * A Scope constrains access to a subset of a Resource.
 * Not all resource kinds require a scope; omitting it means "entire resource".
 */
export interface ResourceScope {
  /**
   * For repository / snapshot resources: the specific commit SHA that this
   * Capability is pinned to. The Kernel rejects access to any other SHA even
   * if the repository matches.
   */
  readonly sha?: string;

  /**
   * Glob patterns (minimatch syntax) restricting which paths within a
   * repository / snapshot may be accessed. Empty array means "no paths
   * allowed"; absence means "all paths allowed".
   *
   * Examples: `["src/**"]`, `["src/**", "tests/**"]`
   */
  readonly paths?: readonly string[];
}

/**
 * Normalise a requested path before scope matching to resist traversal attacks.
 *
 * Rules:
 * - Reject absolute paths (Unix `/…`, Windows `C:\…`, UNC `\\…`).
 * - Reject any segment that is `..`.
 * - Normalise Windows backslashes to `/`.
 * - Strip leading `./`.
 * - Reject NUL bytes.
 */
export function normaliseResourcePath(raw: string): string {
  if (!raw || raw.includes("\0")) {
    throw new TypeError(`Invalid resource path: contains NUL or is empty`);
  }

  const slashed = raw.replace(/\\/g, "/");

  // Reject absolute paths
  if (/^(?:[A-Za-z]:\/|\/|\/\/)/u.test(slashed)) {
    throw new TypeError(`Resource path must be relative, got: ${raw}`);
  }

  // Split and inspect segments
  const segments = slashed.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new TypeError(`Resource path must not traverse parent directories, got: ${raw}`);
    }
  }

  // Strip leading ./
  return segments
    .filter((seg, i) => !(i === 0 && seg === "."))
    .join("/");
}
