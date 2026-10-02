import type { PRReviewContext } from "@consistency/schema";

/** Only old-side hunk neighborhoods are needed to assess baseline behavior. */
export const BASELINE_HUNK_PADDING = 40;
/** Includes file/range headers, separators and every omission marker. */
export const BASELINE_SNIPPETS_MAX_CHARS = 8_000;

const TRUNCATED = "[Baseline snippets truncated by per-file character budget; omitted code is unknown.]";
const GLOBAL_OMISSION = "[Baseline snippets omitted/truncated by the global character budget; omitted code is unknown.]";
type Range = { start: number; end: number };

function mergeRanges(ranges: readonly Range[]): Range[] {
  const merged: Range[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function distanceToRanges(line: number, ranges: readonly Range[]): number {
  let left = 0;
  let right = ranges.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (ranges[middle]!.start <= line) left = middle + 1;
    else right = middle;
  }
  const before = ranges[left - 1];
  const after = ranges[left];
  return Math.min(before ? Math.max(0, line - before.end) : Infinity, after ? after.start - line : Infinity);
}

function hunkRanges(patch: string, lineCount: number): { windows: Range[]; edits: Range[] } {
  const hunks: Range[] = [];
  const edits: Range[] = [];
  let oldLine: number | undefined;
  for (const line of patch.split(/\r?\n/)) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (match) {
      oldLine = Number(match[1]);
      hunks.push({ start: oldLine, end: oldLine + Math.max(Number(match[2] ?? 1), 1) - 1 });
    } else if (oldLine !== undefined) {
      if (line.startsWith("-")) {
        edits.push({ start: oldLine, end: oldLine });
        oldLine += 1;
      } else if (line.startsWith("+")) {
        // An insertion has no deleted line; use its old-side insertion anchor.
        const anchor = Math.max(1, Math.min(lineCount, oldLine));
        edits.push({ start: anchor, end: anchor });
      } else if (line.startsWith(" ")) {
        oldLine += 1;
      } else if (!line.startsWith("\\")) {
        oldLine = undefined;
      }
    }
  }
  const windows = hunks.map(hunk => ({
    start: Math.max(1, hunk.start - BASELINE_HUNK_PADDING),
    end: Math.min(lineCount, hunk.end + BASELINE_HUNK_PADDING),
  }));
  return { windows: mergeRanges(windows), edits: mergeRanges(edits.length > 0 ? edits : hunks) };
}

function renderLines(selected: readonly number[], lines: readonly string[]): string {
  const ordered = [...selected].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < ordered.length;) {
    const start = ordered[index]!;
    let endIndex = index;
    while (endIndex + 1 < ordered.length && ordered[endIndex + 1] === ordered[endIndex]! + 1) endIndex += 1;
    parts.push(`[Base lines ${start}-${ordered[endIndex]}]`);
    for (; index <= endIndex; index += 1) {
      const line = ordered[index]!;
      parts.push(`${line}: ${lines[line - 1]}`);
    }
  }
  return parts.join("\n");
}

function fileSnippet(path: string, content: string, patch: string, budget: number): { text: string; omitted: boolean } {
  const lines = content === "" ? [] : content.split(/\r?\n/);
  const { windows, edits } = hunkRanges(patch, lines.length);
  if (windows.length === 0) {
    const text = `BASE FILE ${path}\n[Baseline snippets omitted: no usable old-side diff hunk; full file not supplied.]`;
    return { text: text.length <= budget ? text : "", omitted: true };
  }
  const prefix = `BASE FILE ${path}\n[Only old-side hunk neighborhoods (±40 lines); other baseline lines omitted.]`;
  // Reserve the truncation notice BEFORE admitting code. Whole lines only.
  const bodyBudget = budget - prefix.length - TRUNCATED.length - 2;
  if (bodyBudget < 0) return { text: "", omitted: true };
  const candidates = new Set<number>();
  for (const window of windows) {
    for (let line = window.start; line <= window.end; line += 1) candidates.add(line);
  }
  const ranked = [...candidates].map(line => ({ line, distance: distanceToRanges(line, edits) }))
    .sort((a, b) => a.distance - b.distance || a.line - b.line);
  const selected: number[] = [];
  let body = "";
  for (const { line } of ranked) {
    if (`${line}: ${lines[line - 1]}`.length > bodyBudget) continue;
    const next = renderLines([...selected, line], lines);
    if (next.length <= bodyBudget) {
      selected.push(line);
      body = next;
    }
  }
  const omitted = selected.length < candidates.size;
  return { text: [prefix, body, ...(omitted ? [TRUNCATED] : [])].filter(Boolean).join("\n"), omitted };
}

export function buildBaselineSnippets(context: PRReviewContext, maxChars = BASELINE_SNIPPETS_MAX_CHARS): string {
  const files = context.changedFiles.filter(file => context.baseFileContents?.[file.path] !== undefined)
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) return "";
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.min(BASELINE_SNIPPETS_MAX_CHARS, Math.floor(maxChars))) : BASELINE_SNIPPETS_MAX_CHARS;
  if (limit < GLOBAL_OMISSION.length) return "";
  // Equal shares prevent an early large file from hiding later files. All
  // overhead is charged against the GLOBAL limit, including the final notice.
  const perFileBudget = Math.floor((limit - GLOBAL_OMISSION.length - 2) / files.length) - 2;
  const parts: string[] = [];
  let omitted = false;
  for (const file of files) {
    const snippet = fileSnippet(file.path, context.baseFileContents![file.path]!, file.patch ?? "", perFileBudget);
    if (snippet.text) parts.push(snippet.text);
    omitted ||= snippet.omitted;
  }
  if (omitted) parts.push(GLOBAL_OMISSION);
  return parts.join("\n\n");
}
