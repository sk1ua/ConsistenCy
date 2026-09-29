/**
 * H17 — explicit analysis selection, quota, batching, and coverage disclosure
 * for workflow-runtime runs.
 *
 * The host previously sliced the snapshot's analyzable files SILENTLY
 * (`sort().slice(0, MAX_ANALYSIS_FILES)`): files beyond the cap were dropped
 * from analysis without any trace. Selection is now an explicit plan:
 *
 *   - a QUOTA bounds how many files one run analyzes (default 10 — the same
 *     bound as before, now named and disclosed);
 *   - omitted files are EXPLICITLY listed in the run's coverage record
 *     (bounded disclosure list) — never silently dropped;
 *   - the selected files are grouped into deterministic BATCHES the analyzer
 *     executes in order;
 *   - the whole input set (repository + head + selected paths) is folded into
 *     a stable snapshotFingerprint that H14 recovery re-validates before any
 *     historical step result may be reused.
 *
 * Pure functions: no I/O, no authorization — the pinned-snapshot read still
 * goes through Kernel-authorized repo.read syscalls at execution time.
 */

import { createHash } from "node:crypto";
import { detectLanguage } from "@consistency/plugins-builtin";
import {
  WORKFLOW_COVERAGE_MAX_DISCLOSED_PATHS,
  type WorkflowRuntimeRunCoverage,
} from "@consistency/schema";

/** Explicit per-run analysis quota (was the implicit first-10 slice). */
export const ANALYSIS_FILE_QUOTA = 10;
/** Deterministic batch size for the analyzer (quota files split into batches). */
export const ANALYSIS_BATCH_SIZE = 5;

/** Hard clamp so a misconfigured quota can never explode a run. */
export const MAX_ANALYSIS_FILE_QUOTA = 200;
export const MAX_ANALYSIS_BATCH_SIZE = 50;

export interface AnalysisSelectionPlan {
  readonly coverage: WorkflowRuntimeRunCoverage;
  readonly selectedPaths: readonly string[];
  readonly batches: readonly (readonly string[])[];
}

function chunk(paths: readonly string[], size: number): string[][] {
  const batches: string[][] = [];
  for (let offset = 0; offset < paths.length; offset += size) {
    batches.push(paths.slice(offset, offset + size));
  }
  return batches;
}

/**
 * Plan the analysis selection for one run: language-supported files, sorted,
 * capped by the quota, with the remainder EXPLICITLY disclosed as omitted.
 * Deterministic for the same input set, so the fingerprint below is stable
 * across processes (restart-stable for H14 reuse).
 */
export function planAnalysisSelection(
  files: readonly string[],
  options: { readonly quota?: number; readonly batchSize?: number } = {},
): AnalysisSelectionPlan {
  const quota = Math.min(Math.max(Math.trunc(options.quota ?? ANALYSIS_FILE_QUOTA), 1), MAX_ANALYSIS_FILE_QUOTA);
  const batchSize = Math.min(Math.max(Math.trunc(options.batchSize ?? ANALYSIS_BATCH_SIZE), 1), MAX_ANALYSIS_BATCH_SIZE);
  const analyzable = files
    .filter((path) => detectLanguage(path) !== undefined)
    .sort();
  const selectedPaths = analyzable.slice(0, quota);
  const omittedPaths = analyzable.slice(quota);
  const batches = chunk(selectedPaths, batchSize);
  return {
    coverage: {
      totalAnalyzable: analyzable.length,
      quota,
      selectedCount: selectedPaths.length,
      selectedPaths: [...selectedPaths],
      omittedCount: omittedPaths.length,
      omittedPaths: omittedPaths.slice(0, WORKFLOW_COVERAGE_MAX_DISCLOSED_PATHS),
      omittedTruncated: omittedPaths.length > WORKFLOW_COVERAGE_MAX_DISCLOSED_PATHS,
      batchSize,
      batchCount: batches.length,
    },
    selectedPaths,
    batches,
  };
}

/**
 * Stable fingerprint over the EXACT historical input of a run: canonical
 * repository identity + pinned HEAD + the selected analysis paths. H14
 * recovery re-computes it before reusing any checkpointed step result — a
 * changed input set (new HEAD, changed tree, changed selection) refuses
 * reuse instead of silently re-basing historical results onto new history.
 */
export function computeAnalysisFingerprint(input: {
  readonly repository: string;
  readonly headSha: string;
  readonly paths: readonly string[];
}): string {
  const canonical = JSON.stringify({
    repository: input.repository,
    headSha: input.headSha,
    paths: [...input.paths].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
