import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { minimatch } from "minimatch";

export const CONSISTENCY_IGNORE_FILE = ".consistencyignore";
export const LOCAL_REVIEW_EXCLUDE_ENV = "CONSISTENCY_LOCAL_REVIEW_EXCLUDE";

/**
 * Parse gitignore-style exclude text: one pattern per line (or comma-separated),
 * `#` starts a full-line comment, blank lines are ignored.
 */
export function parseExcludePatterns(text: string): string[] {
  const patterns: string[] = [];
  for (const rawLine of text.split(/[\n,]+/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    patterns.push(trimmed.replace(/\\/g, "/"));
  }
  return patterns;
}

export function readConsistencyIgnoreFile(repoPath: string): string[] {
  const filePath = join(repoPath, CONSISTENCY_IGNORE_FILE);
  if (!existsSync(filePath)) return [];
  try {
    return parseExcludePatterns(readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

export function readEnvExcludePatterns(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): string[] {
  const raw = env[LOCAL_REVIEW_EXCLUDE_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return parseExcludePatterns(raw);
}

/**
 * Load exclude patterns for a local checkout: `.consistencyignore` at repo root
 * plus optional `CONSISTENCY_LOCAL_REVIEW_EXCLUDE` (comma/newline-separated).
 */
export function loadLocalReviewExcludePatterns(
  repoPath: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): string[] {
  return [...readConsistencyIgnoreFile(repoPath), ...readEnvExcludePatterns(env)];
}

/**
 * Gitignore-ish match against a repo-relative POSIX path.
 * - Patterns ending in `/` match that directory and everything under it.
 * - Patterns without `/` match in any directory (basename or double-star/pattern).
 * - Patterns with `/` are matched from the repository root.
 */
export function matchesExcludePattern(relativePath: string, pattern: string): boolean {
  const path = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || path.includes("\0")) return false;
  let p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p) return false;
  if (p.startsWith("/")) p = p.slice(1);

  if (p.endsWith("/")) {
    const dir = p.slice(0, -1);
    if (!dir) return true;
    return path === dir || path.startsWith(dir + "/") || minimatch(path, dir + "/**", { dot: true });
  }

  if (!p.includes("/")) {
    return minimatch(path, "**/" + p, { dot: true }) || minimatch(path.split("/").pop() ?? path, p, { dot: true });
  }

  return minimatch(path, p, { dot: true }) || minimatch(path, "**/" + p, { dot: true });
}

export function isLocalReviewPathExcluded(relativePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some(pattern => matchesExcludePattern(relativePath, pattern));
}

export function filterLocalReviewPaths<T extends string>(
  paths: readonly T[],
  patterns: readonly string[]
): T[] {
  if (patterns.length === 0) return [...paths];
  return paths.filter(path => !isLocalReviewPathExcluded(path, patterns));
}

export function createLocalReviewExcludeFilter(
  repoPath: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): {
  patterns: string[];
  excludes(path: string): boolean;
  filterPaths<T extends string>(paths: readonly T[]): T[];
} {
  const patterns = loadLocalReviewExcludePatterns(repoPath, env);
  return {
    patterns,
    excludes: (path: string) => isLocalReviewPathExcluded(path, patterns),
    filterPaths: <T extends string>(paths: readonly T[]) => filterLocalReviewPaths(paths, patterns)
  };
}
