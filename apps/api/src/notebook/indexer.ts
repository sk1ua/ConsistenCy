import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";
import { clonePullRequestWorkspace, workspacePathForJob } from "../github/clone";
import { isSecretPath } from "../review/context/fileLoader";
import { redactSensitiveText, sanitizePublicError } from "../security/redact";
import type { GitHubAppAuthenticator } from "../github/auth";
import type { ReviewJob } from "../jobQueue";
import type { NotebookSource } from "@consistency/schema";
import type { NotebookStore, SnapshotIndex, SnapshotManifestEntry } from "./store";

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
  demoWorkspacePath?: string;
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
  return buffer.includes(0);
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
    const key = `${job.repository}@${source.headSha}`;
    const existing = this.options.store.getSnapshotIndex(job.repository, source.headSha);
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
    const key = `${job.repository}@${source.headSha}`;
    this.options.store.updateSourceStatus(source.id, "indexing");
    this.options.store.upsertSnapshotIndex({
      id: existing?.id,
      repository: job.repository,
      headSha: source.headSha,
      status: "indexing",
      workspacePath: existing?.workspacePath,
      manifest: existing?.manifest ?? []
    });

    try {
      const workspacePath = await this.resolveWorkspace(job, source);
      const manifest = this.scan(workspacePath);
      const indexedAt = new Date().toISOString();
      const index = this.options.store.upsertSnapshotIndex({
        id: existing?.id,
        repository: job.repository,
        headSha: source.headSha,
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
        headSha: source.headSha,
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
    if (job.action === "demo" && this.options.demoWorkspacePath && existsSync(this.options.demoWorkspacePath)) {
      return resolve(this.options.demoWorkspacePath);
    }
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

  private scan(workspacePath: string): SnapshotIndex["manifest"] {
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
          preview: content.slice(0, 2_048)
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
  if (!absolute.startsWith(rootWithSep) || !existsSync(absolute) || !lstatSync(absolute).isFile()) {
    throw new Error("File path escapes the indexed repository snapshot");
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
