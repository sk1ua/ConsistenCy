/**
 * VerifiedMiniReview — the fixed built-in WorkflowDefinition for the CKPT3
 * Phase 1 vertical slice (a code constant; not user-editable this round).
 *
 * Semantics: pinned snapshot → deterministic analyzer agent → Evidence
 * (fingerprint + provenance) → deterministic verifier agent → Finding /
 * MiniReport. No LLM anywhere in this workflow.
 */

import type { WorkflowRuntimeDefinition } from "@consistency/schema";

export const VERIFIED_MINI_REVIEW_DEFINITION: WorkflowRuntimeDefinition = Object.freeze({
  id: "verified-mini-review",
  version: 1,
  nodes: [
    Object.freeze({
      id: "analyze",
      type: "analyzer.deterministic-evidence",
      serviceRef: "deterministic-evidence.analyzer",
      parameters: {},
      failurePolicy: "fail-closed",
    }),
    Object.freeze({
      id: "verify",
      type: "verifier.persisted-evidence",
      serviceRef: "persisted-evidence.verifier",
      parameters: {},
      failurePolicy: "fail-closed",
    }),
  ],
  edges: [Object.freeze({ from: "analyze", to: "verify" })],
});
