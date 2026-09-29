/**
 * Wave 3 / R2 — checkpoint payload validation.
 *
 * A checkpoint row is a REUSE licence: the successor run trusts it instead of
 * re-executing a step (for a model step, instead of re-billing a paid call).
 * The licence therefore has to be validated against the FULL structure the
 * node kind promises — not merely "the JSON parsed" — and it has to be
 * validated when the recovery plan is computed, not lazily while a successor
 * is already being built (where a shape mismatch used to be dropped silently
 * and the step was re-executed).
 *
 * This module is the single validator used by BOTH paths:
 *   - the store's read projection (a row that fails validation is `corrupt`
 *     and can never be reported as reusable);
 *   - the store's write path (a structurally invalid result is refused before
 *     it is persisted as reusable);
 *   - the host's recovery planning (folds `corrupt` into explicit blockers).
 *
 * Boundary: pure data validation. It grants nothing and executes nothing.
 */

import {
  workflowModelVerificationSchema,
  type WorkflowNodeKind,
} from "@consistency/schema";
import type { EvidenceInput } from "@consistency/kernel";
import { getWorkflowServiceByRef } from "./registry";

export type CheckpointResultValidation =
  | {
      readonly ok: true;
      /** Envelope kind actually persisted (matches the node kind's contract). */
      readonly envelope: "evidence-inputs";
      readonly evidenceInputs: readonly EvidenceInput[];
    }
  | {
      readonly ok: true;
      readonly envelope: "model-verdict";
      readonly modelVerdict: unknown;
    }
  | { readonly ok: false; readonly reason: string };

/** Envelope kind each node kind is required to persist. */
function expectedEnvelope(nodeKind: WorkflowNodeKind): "evidence-inputs" | "model-verdict" | undefined {
  switch (nodeKind) {
    case "deterministic-analyzer":
    case "persisted-evidence-verifier":
      return "evidence-inputs";
    case "llm-structured-verifier":
      return "model-verdict";
    // A read-only context tool produces no reusable result: a checkpoint row
    // claiming one is not a fact this runtime can honour.
    case "readonly-tool":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Validate a persisted checkpoint result against its node kind, serviceRef and
 * envelope. Every failure carries a human-readable reason (surfaced in the
 * recovery blocker, never silently swallowed).
 */
export function validateCheckpointResult(
  nodeKind: string,
  serviceRef: string,
  result: unknown,
): CheckpointResultValidation {
  const descriptor = getWorkflowServiceByRef(serviceRef);
  if (!descriptor) {
    return { ok: false, reason: `serviceRef '${serviceRef}' is not registered in the node registry` };
  }
  if (descriptor.kind !== nodeKind) {
    return {
      ok: false,
      reason: `node kind '${nodeKind}' contradicts the registered kind '${descriptor.kind}' for serviceRef '${serviceRef}'`,
    };
  }
  const expected = expectedEnvelope(descriptor.kind);
  if (expected === undefined) {
    return { ok: false, reason: `node kind '${nodeKind}' does not produce reusable checkpoint results` };
  }
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, reason: `result payload is not an object (expected the '${expected}' envelope)` };
  }
  const envelope = result as { kind?: unknown; evidenceInputs?: unknown; modelVerdict?: unknown };
  if (envelope.kind !== expected) {
    return {
      ok: false,
      reason: `result envelope kind '${String(envelope.kind)}' does not match the '${expected}' envelope required by node kind '${nodeKind}'`,
    };
  }
  if (expected === "model-verdict") {
    const parsed = workflowModelVerificationSchema.safeParse(envelope.modelVerdict);
    if (!parsed.success) {
      return { ok: false, reason: `model verdict failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid verdict"}` };
    }
    return { ok: true, envelope: "model-verdict", modelVerdict: parsed.data };
  }
  const inputs = parseEvidenceInputs(envelope.evidenceInputs);
  if (inputs === undefined) {
    return { ok: false, reason: "evidence-inputs envelope carries a malformed evidence input" };
  }
  return { ok: true, envelope: "evidence-inputs", evidenceInputs: inputs };
}

/**
 * Evidence inputs are validated field-by-field (source, location.path,
 * finite confidence, provenance object) — the same contract the executor's
 * evidence facade writes. Returns undefined for any malformed entry.
 */
export function parseEvidenceInputs(candidate: unknown): EvidenceInput[] | undefined {
  if (!Array.isArray(candidate)) return undefined;
  const inputs: EvidenceInput[] = [];
  for (const entry of candidate) {
    if (entry === null || typeof entry !== "object") return undefined;
    const input = entry as Partial<EvidenceInput>;
    const source = input.source as unknown;
    if (
      typeof source !== "string" || source === ""
      || input.location === undefined || input.location === null || typeof input.location !== "object"
      || typeof (input.location as { path?: unknown }).path !== "string"
      || typeof input.confidence !== "number" || !Number.isFinite(input.confidence)
      || input.provenance === undefined || input.provenance === null || typeof input.provenance !== "object"
    ) {
      return undefined;
    }
    inputs.push(entry as EvidenceInput);
  }
  return inputs;
}
