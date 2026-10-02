import { isSecretPath, type PRReviewContext } from "@consistency/schema";
import { redactModelVisibleText } from "../context/content-policy.js";

/** Unchanged same-directory files shown only to lean Consistency. */
export const SIBLING_FILES_PER_CHANGED = 2;
export const SIBLING_FILE_MAX_LINES = 150;
/** Same-directory candidates read per changed file before ranking. */
export const SIBLING_CANDIDATE_READ_LIMIT = 24;
/** Combined sibling blocks stay under this token budget. One token is estimated as 4 characters. */
export const SIBLING_CONTEXT_MAX_TOKENS = 12_000;
export const SIBLING_CONTEXT_MAX_CHARS = SIBLING_CONTEXT_MAX_TOKENS * 4;

export interface SiblingFileReader {
  listFiles(): readonly string[];
  readFile(path: string): { content: string };
}

const QUOTED_IMPORT = /(?:from|import)\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
const PYTHON_IMPORT = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/gm;
const JAVA_IMPORT = /^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/gm;

function directoryOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash < 0 ? "" : filePath.slice(0, slash);
}

function extensionOf(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function stemOf(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot <= 0 ? name : name.slice(0, dot)).toLowerCase();
}

function numbered(content: string, maxLines: number): string {
  return content.split(/\r?\n/).slice(0, maxLines).map((line, index) => `${index + 1}: ${line}`).join("\n");
}

function addMatch(targets: Set<string>, match: RegExpMatchArray, groups: readonly number[]): void {
  for (const group of groups) {
    const target = match[group];
    if (target) targets.add(target);
  }
}

function importTargets(content: string): Set<string> {
  const targets = new Set<string>();
  for (const match of content.matchAll(QUOTED_IMPORT)) addMatch(targets, match, [1, 2]);
  for (const match of content.matchAll(PYTHON_IMPORT)) addMatch(targets, match, [1, 2]);
  for (const match of content.matchAll(JAVA_IMPORT)) addMatch(targets, match, [1]);
  return targets;
}

function sharesImport(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const target of left) {
    if (right.has(target)) return true;
  }
  return false;
}

function sharesPrefix(left: string, right: string): boolean {
  if (left.length < 3 || right.length < 3) return false;
  const limit = Math.min(left.length, right.length);
  let shared = 0;
  while (shared < limit && left[shared] === right[shared]) shared += 1;
  return shared >= 3;
}

function eligibleSiblings(context: PRReviewContext, filePath: string, candidates: readonly string[]): string[] {
  const changed = new Set(context.changedFiles.map(file => file.path));
  const directory = directoryOf(filePath);
  const extension = extensionOf(filePath);
  if (!extension) return [];
  return candidates.filter(path => !changed.has(path) && !isSecretPath(path) && directoryOf(path) === directory && extensionOf(path) === extension);
}

/**
 * Pick at most two unchanged, same-directory, same-extension files for each
 * changed file. Shared imports come first, then a shared filename prefix,
 * then any remaining sibling so a convention file is not dropped.
 */
export function selectSiblingFiles(
  context: PRReviewContext,
  candidates: readonly string[],
  limit = SIBLING_FILES_PER_CHANGED,
): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const file of [...context.changedFiles].sort((left, right) => left.path.localeCompare(right.path))) {
    if (file.status === "removed") continue;
    const pool = eligibleSiblings(context, file.path, candidates);
    const imports = importTargets(context.fileContents[file.path] ?? "");
    const stem = stemOf(file.path);
    const byName = (left: string, right: string) => left.localeCompare(right);
    const tiers = [
      pool.filter(path => sharesImport(imports, importTargets(context.fileContents[path] ?? ""))).sort(byName),
      pool.filter(path => sharesPrefix(stem, stemOf(path))).sort(byName),
      [...pool].sort(byName),
    ];
    let kept = 0;
    for (const tier of tiers) {
      for (const path of tier) {
        if (kept >= limit) break;
        if (seen.has(path)) continue;
        seen.add(path);
        selected.push(path);
        kept += 1;
      }
    }
  }
  return selected.sort((left, right) => left.localeCompare(right));
}

export function readSiblingFileContents(
  context: PRReviewContext,
  reader: SiblingFileReader,
): Record<string, string> {
  let listed: readonly string[] = [];
  try {
    listed = reader.listFiles();
  } catch {
    return {};
  }
  const loaded: Record<string, string> = {};
  for (const file of context.changedFiles) {
    const pool = eligibleSiblings(context, file.path, listed);
    const prefix = pool.filter(path => sharesPrefix(stemOf(file.path), stemOf(path)));
    const rest = pool.filter(path => !prefix.includes(path)).sort((left, right) => left.localeCompare(right));
    for (const path of [...prefix, ...rest].slice(0, SIBLING_CANDIDATE_READ_LIMIT)) {
      if (path in loaded) continue;
      const known = context.fileContents[path];
      if (known !== undefined) {
        loaded[path] = known;
        continue;
      }
      try {
        loaded[path] = redactModelVisibleText(reader.readFile(path).content);
      } catch {
        // A missing or unreadable sibling is not a review failure.
      }
    }
  }
  const selected = selectSiblingFiles({ ...context, fileContents: { ...context.fileContents, ...loaded } }, Object.keys(loaded));
  const contents: Record<string, string> = {};
  for (const path of selected) {
    if (path in context.fileContents || path in context.baseFileContents || loaded[path] === undefined) continue;
    contents[path] = loaded[path];
  }
  return contents;
}

/** Numbered sibling blocks, truncated by the combined character budget. */
export function renderSiblingFileContext(contents: Readonly<Record<string, string>>, maxChars = SIBLING_CONTEXT_MAX_CHARS): string {
  const blocks: string[] = [];
  let used = 0;
  for (const path of Object.keys(contents).sort((left, right) => left.localeCompare(right))) {
    const block = `SIBLING FILE: ${path}\n${numbered(contents[path] ?? "", SIBLING_FILE_MAX_LINES)}`;
    const separator = blocks.length === 0 ? 0 : 2;
    if (used + separator + block.length > maxChars) break;
    blocks.push(block);
    used += separator + block.length;
  }
  return blocks.join("\n\n");
}
