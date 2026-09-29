import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";
import { clonePullRequestWorkspace, workspacePathForJob } from "../github/clone";
import { isSecretPath } from "../review/context/fileLoader";
import { redactSensitiveText, sanitizePublicError } from "../security/redact";
import type { GitHubAppAuthenticator } from "../github/auth";
import type { ReviewJob } from "../jobQueue";
import { WORKING_TREE_REV } from "@consistency/schema";
import type { NotebookSource } from "@consistency/schema";
import { snapshotIndexHeadSha, type NotebookStore, type SnapshotIndex, type SnapshotManifestEntry } from "./store";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".consistency",
  ".cache",
  ".next",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target"
]);

/** Same cap readSelectionText applies: no Notebook read can serve more. */
const PINNED_CONTENT_BYTES = 64 * 1024;

/** Leading window used by the control-byte half of binary detection. */
const BINARY_PROBE_BYTES = 8 * 1024;

/** Whitespace controls that ordinary text files legitimately contain. */
const TEXT_CONTROL_BYTES = new Set([8, 9, 10, 11, 12, 13]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "C",
  ".cpp": "C++",
  ".css": "CSS",
  ".go": "Go",
  ".html": "HTML",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".md": "Markdown",
  ".mjs": "JavaScript",
  ".py": "Python",
  ".pyi": "Python",
  ".rs": "Rust",
  ".sh": "Shell",
  ".sql": "SQL",
  ".swift": "Swift",
  ".tsx": "TypeScript",
  ".ts": "TypeScript",
  ".vue": "Vue",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".json": "JSON",
  ".toml": "TOML"
};

export type SnapshotIndexerOptions = {
  store: NotebookStore;
  authenticator?: Pick<GitHubAppAuthenticator, "getInstallationToken">;
  publicReadToken?: string;
  workspaceRoot?: string;
  cloneWorkspace?: typeof clonePullRequestWorkspace;
  maxBytes?: number;
  maxFileBytes?: number;
};

function languageForPath(path: string): string {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] ?? "Text";
}

function normalisePath(path: string): string {
  return path.split(sep).join("/");
}

function isBinary(buffer: Buffer): boolean {
  // NUL is Git's own binary signal and covers PNG/JPEG/UTF-16 payloads.
  if (buffer.includes(0)) return true;
  // Binary artifacts without a NUL byte (compressed blobs, packed fonts, some
  // image formats) would otherwise be summarized as text. Text files never
  // carry a high density of non-whitespace control bytes, so a bounded leading
  // window decides: never let a binary artifact masquerade as Notebook text.
  const window = buffer.subarray(0, BINARY_PROBE_BYTES);
  if (window.length === 0) return false;
  let control = 0;
  for (const byte of window) {
    if (TEXT_CONTROL_BYTES.has(byte)) continue;
    if (byte < 0x20 || byte === 0x7f) control += 1;
  }
  return control / window.length >= 0.125;
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? sanitizePublicError(error.message).slice(0, 500)
    : "Repository snapshot indexing failed";
}

function uniqueMatches(content: string, pattern: RegExp): string[] {
  const values = new Set<string>();
  for (const match of content.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value) values.add(value);
    if (values.size >= 64) break;
  }
  return [...values];
}

function symbolsForContent(content: string): string[] {
  return uniqueMatches(content, /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|def|fn|struct|trait|const|let|var)\s+([A-Za-z_$][\w$]*)/g);
}

function importsForContent(content: string): string[] {
  return uniqueMatches(content, /\b(?:import|from)\s+["']([^"']+)["']/g)
    .concat(uniqueMatches(content, /\brequire\(\s*["']([^"']+)["']\s*\)/g))
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 64);
}

export class RepositorySnapshotIndexer {
  private readonly inFlight = new Map<string, Promise<SnapshotIndex>>();

  constructor(private readonly options: SnapshotIndexerOptions) {}

  async ensure(job: ReviewJob, source: NotebookSource): Promise<SnapshotIndex> {
    const indexHeadSha = snapshotIndexHeadSha(job, source);
    const key = `${job.repository}@${indexHeadSha}`;
    const existing = this.options.store.getSnapshotIndex(job.repository, indexHeadSha);
    if (existing?.status === "ready" && existing.workspacePath && existsSync(existing.workspacePath)) {
      this.options.store.updateSourceStatus(source.id, "ready", existing.indexedAt);
      return existing;
    }

    const running = this.inFlight.get(key);
    if (running) return running;

    const task = this.build(job, source, existing);
    this.inFlight.set(key, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async build(job: ReviewJob, source: NotebookSource, existing?: SnapshotIndex): Promise<SnapshotIndex> {
    const indexHeadSha = snapshotIndexHeadSha(job, source);
    const key = `${job.repository}@${indexHeadSha}`;
    this.options.store.updateSourceStatus(source.id, "indexing");
    this.options.store.upsertSnapshotIndex({
      id: existing?.id,
      repository: job.repository,
      headSha: indexHeadSha,
      status: "indexing",
      workspacePath: existing?.workspacePath,
      manifest: existing?.manifest ?? []
    });

      try {
        const workspacePath = await this.resolveWorkspace(job, source);
        // A SHA-pinned clone does not need a content pin — its git objects are
        // the snapshot. An index over the developer's own checkout (repoPath)
        // is different: the very same path keeps changing, so the reviewed
        // bytes must be pinned or later reads would serve post-review drift.
        const pinnedWorkspace = source.headSha === WORKING_TREE_REV
          || (job.repoPath !== undefined && resolve(job.repoPath) === workspacePath);
        const manifest = this.scan(workspacePath, pinnedWorkspace);
      const indexedAt = new Date().toISOString();
      const index = this.options.store.upsertSnapshotIndex({
        id: existing?.id,
        repository: job.repository,
        headSha: indexHeadSha,
        status: "ready",
        workspacePath,
        manifest,
        indexedAt
      });
      this.options.store.updateSourceStatus(source.id, "ready", indexedAt);
      return index;
    } catch (error) {
      const message = safeError(error);
      const failed = this.options.store.upsertSnapshotIndex({
        id: existing?.id,
        repository: job.repository,
        headSha: indexHeadSha,
        status: "failed",
        workspacePath: existing?.workspacePath,
        manifest: existing?.manifest ?? [],
        error: message
      });
      this.options.store.updateSourceStatus(source.id, "failed", undefined, message);
      throw new Error(`${key}: ${message}`);
    }
  }

  private async resolveWorkspace(job: ReviewJob, source: NotebookSource): Promise<string> {
    if (job.repoPath && existsSync(job.repoPath) && lstatSync(job.repoPath).isDirectory()) {
      return resolve(job.repoPath);
    }

    const safeJobId = `notebook_${job.repository.replace(/[^A-Za-z0-9_-]/g, "_")}_${source.headSha.slice(0, 16)}`;
    let token: string | undefined;
    if (job.accessMode === "public_read") {
      token = this.options.publicReadToken;
    } else {
      if (!this.options.authenticator || !job.installationId) {
        throw new Error("A GitHub App installation token is required to index this repository snapshot");
      }
      token = (await this.options.authenticator.getInstallationToken(job.installationId)).token;
    }
    return (this.options.cloneWorkspace ?? clonePullRequestWorkspace)({
      repositoryFullName: job.repository,
      headSha: source.headSha,
      baseSha: source.baseSha,
      jobId: safeJobId,
      token,
      workspaceRoot: this.options.workspaceRoot
    });
  }

  /**
   * Working-tree and live-checkout indexes pin the content they served so
   * later reads resolve index-time bytes after the checkout drifts (audit
   * P1-06③). The pin is capped at the largest slice any Notebook read path can
   * serve; SHA-pinned clones need no pin — their git objects already are the
   * snapshot.
   */
  private scan(workspacePath: string, pinContent = false): SnapshotIndex["manifest"] {
    const root = resolve(workspacePath);
    const maxBytes = this.options.maxBytes ?? 64 * 1024 * 1024;
    const maxFileBytes = this.options.maxFileBytes ?? 512 * 1024;
    let indexedBytes = 0;
    const manifest: SnapshotIndex["manifest"] = [];

    const visit = (directory: string): void => {
      if (manifest.length >= 20_000 || indexedBytes >= maxBytes) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (manifest.length >= 20_000 || indexedBytes >= maxBytes) return;
        if (entry.name === "." || entry.name === "..") continue;
        const absolute = resolve(directory, entry.name);
        const relativePath = normalisePath(relative(root, absolute));
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) visit(absolute);
          continue;
        }
        if (!entry.isFile() || isSecretPath(relativePath)) continue;

        let stats;
        try { stats = statSync(absolute); } catch { continue; }
        if (stats.size > maxFileBytes || indexedBytes + stats.size > maxBytes) continue;

        let buffer: Buffer;
        try { buffer = readFileSync(absolute); } catch { continue; }
        if (isBinary(buffer)) continue;
        const content = redactSensitiveText(buffer.toString("utf8"));
        indexedBytes += Buffer.byteLength(content, "utf8");
        const manifestEntry: SnapshotManifestEntry = {
          path: relativePath,
          bytes: Buffer.byteLength(content, "utf8"),
          lines: content.length === 0 ? 0 : content.split("\n").length,
          language: languageForPath(relativePath),
          symbols: symbolsForContent(content),
          imports: importsForContent(content),
          preview: content.slice(0, 2_048),
          ...(pinContent ? { content: content.slice(0, PINNED_CONTENT_BYTES) } : {})
        };
        manifest.push(manifestEntry);
      }
    };

    visit(root);
    return manifest.sort((left, right) => left.path.localeCompare(right.path));
  }
}

export function snapshotPathIsIndexed(index: SnapshotIndex, relativePath: string): boolean {
  return index.manifest.some(item => item.path === normalisePath(relativePath));
}

export function normaliseSnapshotPath(path: string): string {
  return normalisePath(path);
}

export function snapshotRoot(index: SnapshotIndex): string {
  if (!index.workspacePath) throw new Error("Repository snapshot workspace is unavailable");
  return resolve(index.workspacePath);
}

export function readSnapshotText(index: SnapshotIndex, relativePath: string, maxBytes = 64 * 1024): string {
  const path = normalisePath(relativePath);
  if (!snapshotPathIsIndexed(index, path) || isSecretPath(path)) {
    throw new Error("File is not available in the indexed repository snapshot");
  }
  const root = snapshotRoot(index);
  const absolute = resolve(root, path.replaceAll("/", sep));
  const rootWithSep = `${root}${sep}`;
  if (!absolute.startsWith(rootWithSep)) {
    throw new Error("File path escapes the indexed repository snapshot");
  }
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
    // The clone or checkout changed under an index that has no content pin:
    // report the file as gone instead of claiming a containment error.
    throw new Error("File is no longer present in the indexed repository snapshot");
  }
  const buffer = readFileSync(absolute);
  if (isBinary(buffer)) throw new Error("Binary files are not available in Notebook context");
  return redactSensitiveText(buffer.subarray(0, maxBytes).toString("utf8"));
}

export function readSnapshotLines(index: SnapshotIndex, relativePath: string, startLine = 1, endLine = 80): { content: string; startLine: number; endLine: number } {
  const lines = readSnapshotText(index, relativePath).split("\n");
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, Math.max(start, endLine));
  return { content: lines.slice(start - 1, end).join("\n"), startLine: start, endLine: end };
}

export function snapshotFileName(path: string): string {
  return basename(path);
}
