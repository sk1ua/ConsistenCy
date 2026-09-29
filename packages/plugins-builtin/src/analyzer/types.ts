/**
 * Analyzer contract — deterministic infrastructure consumers.
 *
 * Analyzers depend on NOTHING but snapshot content + TreeSitterService
 * (both infrastructure). No Agent, no Cordis fiber, no LLM, no ReviewJob.
 * Every analyzer carries an explicit version — Evidence provenance records
 * it, and rule-semantic changes must bump it (reproducibility).
 */

import type { EvidenceInput } from "@consistency/kernel";
import type { TreeSitterService } from "../tree-sitter/service.js";

/** A snapshot file's content, as read by the caller's snapshot adapter. */
export interface SnapshotFileContent {
  readonly path: string;
  readonly content: string;
}

/** What the harness/snapshot layer provides to analyzers. */
export interface AnalyzerDeps {
  readonly readFile: (path: string) => Promise<SnapshotFileContent>;
  readonly treeSitter: TreeSitterService;
}

/** Immutable input identity: repository + snapshot SHA + files to analyze. */
export interface AnalyzerInput {
  readonly repository: string;
  readonly headSha: string;
  readonly baseSha?: string;
  /** Repository-relative paths with `/` separators. */
  readonly files: readonly string[];
}

export interface Analyzer<C = undefined> {
  readonly id: string;
  readonly version: string;
  analyze(input: AnalyzerInput, deps: AnalyzerDeps, config?: C): Promise<EvidenceInput[]>;
}

/** Deterministic evidence ordering used by all built-in analyzers. */
export function orderEvidence(evidence: readonly EvidenceInput[]): EvidenceInput[] {
  return [...evidence].sort((a, b) => {
    if (a.location.path !== b.location.path) {
      return a.location.path < b.location.path ? -1 : 1;
    }
    const aStart = a.location.startLine ?? 0;
    const bStart = b.location.startLine ?? 0;
    if (aStart !== bStart) return aStart - bStart;
    const aEnd = a.location.endLine ?? 0;
    const bEnd = b.location.endLine ?? 0;
    if (aEnd !== bEnd) return aEnd - bEnd;
    const aRule = a.ruleId ?? "";
    const bRule = b.ruleId ?? "";
    return aRule < bRule ? -1 : aRule > bRule ? 1 : 0;
  });
}
