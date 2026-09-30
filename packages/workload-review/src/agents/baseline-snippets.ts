import type { PRReviewContext } from "@consistency/schema";

/** Only old-side hunk neighborhoods are needed to assess baseline behavior. */
export const BASELINE_HUNK_PADDING = 40;
export const BASELINE_SNIPPETS_MAX_CHARS = 30_000;

export function buildBaselineSnippets(context: PRReviewContext): string {
  const files = context.changedFiles.filter(file => context.baseFileContents?.[file.path] !== undefined)
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) return "";
  // Reserve each file a fair share; a large early file cannot hide later files.
  const perFileBudget = Math.floor(BASELINE_SNIPPETS_MAX_CHARS / files.length);
  return files.map(file => {
    const lines = context.baseFileContents![file.path]!.split(/\r?\n/);
    const ranges: Array<{ start: number; end: number }> = [];
    for (const match of (file.patch ?? "").matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
      const start = Number(match[1]);
      const count = Number(match[2] ?? 1);
      ranges.push({ start: Math.max(1, start - BASELINE_HUNK_PADDING), end: Math.min(lines.length, start + Math.max(count, 1) - 1 + BASELINE_HUNK_PADDING) });
    }
    if (ranges.length === 0) return `BASE FILE ${file.path}\n[Baseline snippets omitted: no usable old-side diff hunk; full file not supplied.]`;
    ranges.sort((a, b) => a.start - b.start);
    const merged: typeof ranges = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
    }
    const rendered: string[] = [];
    let remaining = perFileBudget;
    let truncated = false;
    for (const range of merged) {
      const header = `[Base lines ${range.start}-${range.end}]`;
      if (header.length + 1 > remaining) { truncated = true; break; }
      rendered.push(header);
      remaining -= header.length + 1;
      for (let line = range.start; line <= range.end; line += 1) {
        const text = `${line}: ${lines[line - 1]}`;
        if (text.length + 1 > remaining) { truncated = true; break; }
        rendered.push(text);
        remaining -= text.length + 1;
      }
      if (truncated) break;
    }
    return [`BASE FILE ${file.path}`, "[Only old-side hunk neighborhoods (±40 lines); other baseline lines omitted.]", ...rendered,
      ...(truncated ? ["[Baseline snippets truncated by per-file character budget; omitted code is unknown.]"] : [])].join("\n");
  }).join("\n\n");
}
