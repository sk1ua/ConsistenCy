import type { PRReviewContext, ReviewFinding } from "@consistency/schema";

const IDENTIFIER = /`([^`\n]+)`|\b(?:[A-Za-z_$][\w$]*\s*(?=\()|\w*[a-z][A-Z]\w*|\w+_\w+|\w*\d\w*)\b/g;

/** Code names cited by a finding, excluding the finding's own file path. */
export function citedCodeIdentifiers(finding: Pick<ReviewFinding, "title" | "evidence" | "reasoning" | "file">): string[] {
  const text = `${finding.title}\n${finding.evidence}\n${finding.reasoning}`.replace(finding.file, " ");
  const identifiers = new Set<string>();
  for (const match of text.matchAll(IDENTIFIER)) {
    const raw = (match[1] ?? match[0]).trim();
    for (const identifier of raw.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
      if (identifier[0].length > 1) identifiers.add(identifier[0]);
    }
  }
  return [...identifiers];
}

function occurrenceCount(content: string, identifier: string): number {
  const pattern = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  return content.match(pattern)?.length ?? 0;
}

/**
 * A Consistency finding must name a convention that already exists outside
 * the changed lines. A name that appears only in the cited change is not
 * repository precedent.
 */
export function hasRepositoryPrecedent(finding: ReviewFinding, context: PRReviewContext): boolean {
  const identifiers = citedCodeIdentifiers(finding);
  if (identifiers.length === 0) return false;
  const changed = context.fileContents[finding.file] ?? "";
  const changedLines = new Set<number>();
  if (finding.startLine && finding.endLine) {
    for (let line = finding.startLine; line <= finding.endLine; line += 1) changedLines.add(line);
  }
  const changedBody = changed.split(/\r?\n/).filter((_, index) => changedLines.has(index + 1)).join("\n");
  return identifiers.some(identifier => {
    const elsewhere = Object.entries(context.fileContents).some(([path, content]) => {
      if (path === finding.file) return occurrenceCount(content, identifier) > occurrenceCount(changedBody, identifier);
      return occurrenceCount(content, identifier) > 0;
    });
    const baseline = context.baseFileContents[finding.file];
    return elsewhere || (baseline !== undefined && occurrenceCount(baseline, identifier) > 0);
  });
}
