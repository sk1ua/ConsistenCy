import type { PRReviewContext, ReviewFinding } from "@consistency/schema";

export type PrecedentStatus = "verified" | "missing" | "unverified";

function foldWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Lean Consistency citations must name a supplied line and quote it. A quote
 * that only matches the lines under criticism is not a precedent.
 */
export function verifyPrecedent(finding: ReviewFinding, context: PRReviewContext): PrecedentStatus {
  const precedent = finding.precedent;
  if (precedent === undefined) return "missing";
  const quote = foldWhitespace(precedent.quote);
  if (quote.replace(/\s/g, "").length < 8) return "unverified";

  const head = context.fileContents[precedent.file];
  const source = head ?? context.baseFileContents[precedent.file];
  if (source === undefined) return "unverified";
  const lines = source.split(/\r?\n/);
  const start = Math.max(1, precedent.line - 2);
  const end = Math.min(lines.length, precedent.line + 2);
  const hits: number[] = [];
  for (let line = start; line <= end; line += 1) {
    if (foldWhitespace(lines[line - 1] ?? "").includes(quote)) hits.push(line);
  }
  if (hits.length === 0) return "unverified";
  if (head === undefined || precedent.file !== finding.file || finding.startLine === undefined || finding.endLine === undefined) {
    return "verified";
  }
  return hits.some(line => line < finding.startLine! || line > finding.endLine!) ? "verified" : "unverified";
}
