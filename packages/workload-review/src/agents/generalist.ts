/**
 * Opt-in lean generalist. Two identical samples; only findings that agree
 * survive. A failed sample contributes nothing and never fails the review.
 */

import type { ReviewFinding, TokenUsage } from "@consistency/schema";
import { mergeTokenUsage, tokenUsageFromError } from "@consistency/schema";
import { REVIEW_DIFF_MAX_CHARS } from "../context/review-context.js";
import { redactModelVisibleText } from "../context/content-policy.js";

export const GENERALIST_SYSTEM_PROMPT = [
  "You are an experienced maintainer of this repository reviewing a pull request. You see only the unified diff.",
  "List the concrete changes you would ask the author to make before merging: incorrect or risky behavior, unhandled inputs or error paths, API or backward-compatibility breaks, documentation or comments that are wrong, misleading or now outdated, missing or weak tests for the changed behavior, unclear names for new public APIs, and design problems in the new code.",
  "Each item must point at specific added or modified lines. Do not include praise, generic advice, or purely cosmetic formatting.",
  "Return only JSON: {\"findings\":[{\"file\":\"<path as in +++ b/>\",\"line_start\":<int>,\"line_end\":<int>,\"title\":\"<short>\",\"message\":\"<one or two sentences>\"}]}.",
  "Line numbers refer to the new version of the file. At most 8 findings; an empty list is allowed."
].join(" ");

/** Agreement rule. "range" is the default; "title" is the alternate the evaluator may pin. Not an env switch. */
export const GENERALIST_AGREEMENT_RULE: "range" | "title" = "range";

export type GeneralistRawFinding = {
  file: string;
  line_start?: number;
  line_end?: number;
  title: string;
  message: string;
};

export type GeneralistAgreement = {
  findings: ReviewFinding[];
  summary: string;
  nA: number;
  nB: number;
  nAgreed: number;
  jaccard: number;
  tokenUsage?: TokenUsage;
  failed: boolean;
};

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

export function parseGeneralistFindings(content: string): GeneralistRawFinding[] {
  const decoded = extractJson(content);
  const list = decoded !== null && typeof decoded === "object" && "findings" in decoded
    ? (decoded as { findings?: unknown }).findings
    : decoded;
  if (!Array.isArray(list)) return [];
  const parsed: GeneralistRawFinding[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const file = typeof value.file === "string" ? value.file.trim() : "";
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const message = typeof value.message === "string" ? value.message.trim() : "";
    if (!file || !title || !message) continue;
    const lineStart = typeof value.line_start === "number" ? value.line_start : undefined;
    const lineEnd = typeof value.line_end === "number" ? value.line_end : undefined;
    parsed.push({
      file,
      title,
      message,
      ...(Number.isInteger(lineStart) && lineStart! > 0 ? { line_start: lineStart } : {}),
      ...(Number.isInteger(lineEnd) && lineEnd! > 0 ? { line_end: lineEnd } : {})
    });
  }
  return parsed.slice(0, 8);
}

function titleTokens(title: string): Set<string> {
  return new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 0));
}

function titleJaccard(left: string, right: string): number {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function rangesAgree(left: GeneralistRawFinding, right: GeneralistRawFinding): boolean {
  if (left.file !== right.file) return false;
  if (left.line_start === undefined || left.line_end === undefined || right.line_start === undefined || right.line_end === undefined) return false;
  return left.line_start <= right.line_end + 3 && right.line_start <= left.line_end + 3;
}

function titlesAgree(left: GeneralistRawFinding, right: GeneralistRawFinding): boolean {
  return left.file === right.file && titleJaccard(left.title, right.title) >= 0.5;
}

export function agreeFindings(first: readonly GeneralistRawFinding[], second: readonly GeneralistRawFinding[], rule = GENERALIST_AGREEMENT_RULE): ReviewFinding[] {
  const used = new Set<number>();
  const agreed: ReviewFinding[] = [];
  first.forEach((finding, index) => {
    const match = second.findIndex((candidate, candidateIndex) => {
      if (used.has(candidateIndex)) return false;
      return rule === "title" ? titlesAgree(finding, candidate) : rangesAgree(finding, candidate);
    });
    if (match < 0) return;
    used.add(match);
    const start = finding.line_start;
    const end = finding.line_end;
    agreed.push({
      id: `generalist-${index + 1}`,
      agent: "Generalist" as ReviewFinding["agent"],
      title: finding.title,
      severity: "medium",
      confidence: "likely",
      file: finding.file,
      ...(start !== undefined && end !== undefined && end >= start ? { startLine: start, endLine: end } : {}),
      evidence: finding.message,
      reasoning: finding.message,
      recommendation: finding.message,
      source: "generalist",
      support: 2
    });
  });
  return agreed;
}

export function generalistJaccard(nA: number, nB: number, nAgreed: number): number {
  const denominator = nA + nB - nAgreed;
  return denominator === 0 ? 0 : nAgreed / denominator;
}

/** User message is the diff only, truncated the same way specialist diff sections are. */
export function buildGeneralistPrompt(diff: string): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: GENERALIST_SYSTEM_PROMPT,
    userPrompt: redactModelVisibleText(`DIFF\n${diff.slice(0, REVIEW_DIFF_MAX_CHARS)}`)
  };
}

export type GeneralistInvoker = (request: {
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}) => Promise<{ content: string; tokenUsage?: TokenUsage }>;

export async function runGeneralistAgreement(
  diff: string,
  invoke: GeneralistInvoker,
  signal?: AbortSignal
): Promise<GeneralistAgreement> {
  const prompt = buildGeneralistPrompt(diff);
  const call = () => invoke({ systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt, signal });
  try {
    const [left, right] = await Promise.all([call(), call()]);
    const a = parseGeneralistFindings(left.content);
    const b = parseGeneralistFindings(right.content);
    const findings = agreeFindings(a, b);
    const jaccard = generalistJaccard(a.length, b.length, findings.length);
    return {
      findings,
      nA: a.length,
      nB: b.length,
      nAgreed: findings.length,
      jaccard,
      failed: false,
      tokenUsage: mergeTokenUsage(left.tokenUsage, right.tokenUsage),
      summary: `generalist: a=${a.length} b=${b.length} agreed=${findings.length} J=${jaccard.toFixed(2)}`
    };
  } catch (error) {
    const usage = tokenUsageFromError(error);
    return {
      findings: [],
      nA: 0,
      nB: 0,
      nAgreed: 0,
      jaccard: 0,
      failed: true,
      tokenUsage: usage,
      summary: "generalist sample failed"
    };
  }
}
