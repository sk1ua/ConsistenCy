import type { ReviewFinding } from "@consistency/schema";

export const MAINT_DOC_WORDS = /javadoc|kdoc|docstring|doc comment|jsdoc/i;
export const MAINT_REFACTOR_WORDS = /duplicat|factor|helper|extract|unwieldy|parameter list|mixes unrelated|test name/i;
export const MAINT_KEEP_WORDS = /drift|diverg|inconsisten|out of sync|contradict|mismatch/i;

/** Title-only classification. A keep word blocks a refactor match. */
export function classifyMaintainabilityNoise(finding: ReviewFinding): "doc" | "refactor" | undefined {
  if (MAINT_DOC_WORDS.test(finding.title)) return "doc";
  if (MAINT_REFACTOR_WORDS.test(finding.title) && !MAINT_KEEP_WORDS.test(finding.title)) return "refactor";
  return undefined;
}

/** Drop only Maintainability findings whose title is doc or refactor noise. */
export function filterMaintainabilityNoise(findings: readonly ReviewFinding[]): {
  kept: ReviewFinding[];
  rejected: number;
} {
  const kept = findings.filter(finding => finding.agent !== "Maintainability" || classifyMaintainabilityNoise(finding) === undefined);
  return { kept, rejected: findings.length - kept.length };
}
