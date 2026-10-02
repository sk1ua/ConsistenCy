import type { PRReviewContext, ReviewFinding } from "@consistency/schema";

/** Absence language in a Consistency title. */
export const ABSENCE_WORDS = /\b(lacks?|omits?|omitted|missing|without|drops?|no longer (has|uses))\b/i;
/** Documentation, comment, and license-header language. */
export const DOC_WORDS = /docstring|doc comment|\bkdoc\b|\bjsdoc\b|javadoc|license|copyright|\bheader\b|\bcomments?\b/i;
/** Annotations, markers, constants, and dependency-list language. */
export const BOILERPLATE_WORDS = /annotation|decorator|marker|type hint|@\w+|\bconstant\b|dependenc/i;

const STOP_IDENTIFIERS = new Set([
  "def", "class", "return", "self", "this", "const", "let", "var", "function",
  "public", "private", "protected", "static", "import", "from", "final", "void",
  "async", "await", "true", "false", "None", "null",
]);

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{3,}/g;

export function classifyConsistencyNoise(finding: ReviewFinding): "doc" | "absence-boilerplate" | "absence" | undefined {
  const title = finding.title;
  if (DOC_WORDS.test(title)) return "doc";
  const absence = ABSENCE_WORDS.test(title);
  const boilerplate = BOILERPLATE_WORDS.test(title);
  if (absence && boilerplate) return "absence-boilerplate";
  if (absence) return "absence";
  return undefined;
}

function firstIdentifier(quote: string | undefined): string | undefined {
  if (!quote) return undefined;
  for (const match of quote.matchAll(IDENTIFIER)) {
    const identifier = match[0];
    if (identifier && !STOP_IDENTIFIERS.has(identifier)) return identifier;
  }
  return undefined;
}

function containsWord(content: string, identifier: string): boolean {
  return new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(content);
}

/** Distinct other files whose content contains the quote's first identifier. */
export function precedentSupport(
  finding: ReviewFinding,
  context: PRReviewContext,
  siblingFileContents: Readonly<Record<string, string>> = {},
): number {
  const identifier = firstIdentifier(finding.precedent?.quote);
  if (!identifier) return 0;
  const files = new Set<string>();
  for (const [path, content] of Object.entries(context.fileContents)) {
    if (path === finding.file) continue;
    if (containsWord(content, identifier)) files.add(path);
  }
  for (const [path, content] of Object.entries(siblingFileContents)) {
    if (path === finding.file || files.has(path)) continue;
    if (containsWord(content, identifier)) files.add(path);
  }
  return files.size;
}

export function filterConsistencyNoise(
  findings: readonly ReviewFinding[],
  context: PRReviewContext,
  siblingFileContents: Readonly<Record<string, string>> = {},
): { kept: ReviewFinding[]; rejected: number } {
  const kept: ReviewFinding[] = [];
  let rejected = 0;
  for (const finding of findings) {
    const kind = classifyConsistencyNoise(finding);
    const drop = kind === "doc"
      || kind === "absence-boilerplate"
      || (kind === "absence" && precedentSupport(finding, context, siblingFileContents) < 2);
    if (drop) rejected += 1;
    else kept.push(finding);
  }
  return { kept, rejected };
}
