import type { PRReviewContext } from "@consistency/schema";
import { changedLineRanges } from "./grounding.js";
import { enclosingUnitRange } from "./test-coverage.js";

function numberedSlice(lines: readonly string[], start: number, end: number): string {
  return lines.slice(Math.max(0, start - 1), end)
    .map((line, offset) => `${start + offset}: ${line}`)
    .join("\n");
}

/**
 * Default-off file context: numbered changed hunks plus the whole unit that
 * contains them. Unchanged files are omitted. Line numbers stay original.
 */
export function compactFileContext(context: PRReviewContext, maxChars = 140_000): string {
  const blocks: string[] = [];
  for (const file of [...context.changedFiles].sort((left, right) => left.path.localeCompare(right.path))) {
    const content = context.fileContents[file.path];
    if (content === undefined || file.status === "removed") continue;
    const lines = content.split(/\r?\n/);
    const ranges = file.status === "added" ? [{ start: 1, end: lines.length }] : changedLineRanges(file.patch);
    if (ranges.length === 0) continue;
    const hunk = ranges.map(range => numberedSlice(lines, range.start, range.end)).join("\n");
    const units = new Map<string, { start: number; end: number }>();
    for (const range of ranges) {
      for (let line = range.start; line <= range.end; line += 1) {
        const unit = enclosingUnitRange(lines, file.path, line);
        if (unit) units.set(`${unit.start}-${unit.end}`, unit);
      }
    }
    const unitText = [...units.values()]
      .sort((left, right) => left.start - right.start || left.end - right.end)
      .map(unit => numberedSlice(lines, unit.start, unit.end))
      .join("\n\n");
    blocks.push([`FILE ${file.path}`, `HUNK\n${hunk}`, unitText ? `UNIT\n${unitText}` : ""].filter(Boolean).join("\n"));
  }
  return blocks.join("\n\n").slice(0, maxChars);
}
