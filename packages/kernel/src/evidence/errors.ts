/**
 * Evidence errors — typed, fail-closed semantics.
 */

import type { EvidenceId } from "./types.js";

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

/** Invalid semantic input (confidence out of range, bad location…). */
export class EvidenceValidationError extends EvidenceError {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

/** Duplicate EvidenceId at insertion. */
export class EvidenceIdConflictError extends EvidenceError {
  readonly evidenceId: EvidenceId;
  constructor(evidenceId: EvidenceId) {
    super(`Evidence id already exists: ${evidenceId}`);
    this.name = "EvidenceIdConflictError";
    this.evidenceId = evidenceId;
  }
}

/**
 * A payload value cannot be canonicalized deterministically (undefined,
 * function, symbol, bigint, non-plain objects, cycles). Fingerprinting
 * fails closed — nondeterministic fingerprints are never emitted silently.
 */
export class CanonicalizationError extends EvidenceError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}
