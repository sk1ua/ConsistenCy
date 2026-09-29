/**
 * RepositorySnapshot — an immutable, SHA-pinned repository view.
 *
 * All reads go through the Git OBJECT DATABASE at the pinned headSha
 * (`git ls-tree` / `git show <sha>:<path>` / `git rev-parse`), so later
 * working-tree mutations can never change what an existing snapshot
 * observes. Two snapshots of the same repository+SHA expose equivalent
 * semantic state even when their instance ids differ.
 *
 * SECURITY: a snapshot reference is an identifier, never a credential.
 * Repository access authorization stays in the Kernel CapabilityBroker.
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  asRepositorySnapshotId,
  formatSnapshotUri,
  normaliseResourcePath,
  type RepositorySnapshotId,
  type SnapshotIdentity,
} from "@consistency/kernel";
import { GitCommandError, runGit } from "../git/git-runner.js";
import type {
  CreateRepositorySnapshotOptions,
  SnapshotDiffEntry,
  SnapshotDiffStatus,
  SnapshotFile,
  SnapshotFileEntry,
  SnapshotFileMetadata,
} from "./types.js";

export class SnapshotPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotPathError";
  }
}

export class SnapshotFileNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Snapshot file not found: ${path}`);
    this.name = "SnapshotFileNotFoundError";
    this.path = path;
  }
}

export class SnapshotDiffUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotDiffUnavailableError";
  }
}

export class RepositorySnapshot {
  readonly #repositoryPath: string;
  readonly #identity: SnapshotIdentity;
  readonly #id: RepositorySnapshotId;
  #tree: Map<string, string> | null = null; // path → blobSha (lazy)

  private constructor(
    repositoryPath: string,
    identity: SnapshotIdentity,
    id: RepositorySnapshotId,
  ) {
    this.#repositoryPath = repositoryPath;
    this.#identity = Object.freeze({ ...identity });
    this.#id = id;
  }

  /**
   * Create a snapshot pinned to `headSha`. Validates that the SHAs exist in
   * the local repository (fail closed).
   */
  static create(options: CreateRepositorySnapshotOptions): RepositorySnapshot {
    try {
      runGit(options.repositoryPath, ["rev-parse", "--verify", `${options.headSha}^{commit}`]);
    } catch {
      throw new GitCommandError(
        ["rev-parse", "--verify", `${options.headSha}^{commit}`],
        `headSha does not exist: ${options.headSha}`,
      );
    }
    if (options.baseSha !== undefined) {
      try {
        runGit(options.repositoryPath, ["rev-parse", "--verify", `${options.baseSha}^{commit}`]);
      } catch {
        throw new GitCommandError(
          ["rev-parse", "--verify", `${options.baseSha}^{commit}`],
          `baseSha does not exist: ${options.baseSha}`,
        );
      }
    }
    const identity: SnapshotIdentity = {
      repository: options.repository,
      headSha: options.headSha,
      baseSha: options.baseSha,
    };
    const id = options.snapshotId ?? asRepositorySnapshotId(`snap_${randomUUID()}`);
    return new RepositorySnapshot(options.repositoryPath, identity, id);
  }

  get id(): RepositorySnapshotId {
    return this.#id;
  }

  identity(): SnapshotIdentity {
    return this.#identity;
  }

  /** `snapshot://<owner>/<name>/<snapshotId>` — identifier, not a credential. */
  uri(): string {
    return formatSnapshotUri(this.#identity.repository, this.#id);
  }

  /** All tracked file paths at headSha, sorted, `/`-separated. */
  listFiles(): readonly string[] {
    const tree = this.#ensureTree();
    return [...tree.keys()].sort();
  }

  /**
   * Read a file's content at headSha. Path safety: absolute paths,
   * traversal and NUL are rejected; Windows separators are normalized to
   * `/` (same rules as Kernel syscalls).
   */
  readFile(rawPath: string): SnapshotFile {
    const path = this.#safePath(rawPath);
    const tree = this.#ensureTree();
    if (!tree.has(path)) {
      throw new SnapshotFileNotFoundError(path);
    }
    const content = runGit(this.#repositoryPath, ["show", `${this.#identity.headSha}:${path}`]);
    return {
      path,
      content,
      contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    };
  }

  getFileMetadata(rawPath: string): SnapshotFileMetadata {
    const path = this.#safePath(rawPath);
    const tree = this.#ensureTree();
    const blobSha = tree.get(path);
    if (blobSha === undefined) {
      throw new SnapshotFileNotFoundError(path);
    }
    return { path, blobSha };
  }

  /**
   * Path-level base→head diff (`git diff --name-status --no-renames`).
   * Requires baseSha; deterministic ordering by (status, path).
   */
  getDiff(): readonly SnapshotDiffEntry[] {
    if (this.#identity.baseSha === undefined) {
      throw new SnapshotDiffUnavailableError("snapshot has no baseSha");
    }
    const output = runGit(this.#repositoryPath, [
      "diff",
      "--name-status",
      "--no-renames",
      `${this.#identity.baseSha}`,
      this.#identity.headSha,
    ]);
    const entries: SnapshotDiffEntry[] = [];
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const tab = line.indexOf("\t");
      if (tab <= 0) continue; // ignore unexpected lines (fail-open? no: skip only malformed)
      const statusCode = line.slice(0, tab);
      const path = line.slice(tab + 1);
      const status: SnapshotDiffStatus | undefined =
        statusCode === "A" ? "added" : statusCode === "M" ? "modified" : statusCode === "D" ? "deleted" : undefined;
      if (status === undefined) continue;
      entries.push({ path, status });
    }
    return entries.sort((a, b) => (a.status !== b.status ? (a.status < b.status ? -1 : 1) : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  #ensureTree(): Map<string, string> {
    if (this.#tree) return this.#tree;
    const output = runGit(this.#repositoryPath, ["ls-tree", "-r", this.#identity.headSha]);
    const tree = new Map<string, string>();
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      // Format: "<mode> <type> <object>\t<path>"
      const metaTab = line.indexOf("\t");
      if (metaTab <= 0) continue;
      const meta = line.slice(0, metaTab).split(/\s+/);
      const type = meta[1];
      const objectId = meta[2];
      const path = line.slice(metaTab + 1);
      if (type === "blob" && objectId && path) {
        tree.set(path, objectId);
      }
    }
    this.#tree = tree;
    return tree;
  }

  #safePath(rawPath: string): string {
    try {
      return normaliseResourcePath(rawPath);
    } catch (err) {
      throw new SnapshotPathError((err as Error).message);
    }
  }
}

export type { SnapshotFileEntry };
