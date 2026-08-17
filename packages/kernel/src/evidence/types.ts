/**
 * Evidence — the canonical deterministic grounding record (Kernel side).
 *
 * The Evidence Engine is a protected deterministic subsystem. This module
 * defines the Evidence model, the deterministic fingerprint algorithm, and
 * the in-memory protected EvidenceStore. Analyzers (in plugins-builtin)
 * produce EvidenceInputs; the Kernel store derives the fingerprint and owns
 * the records. Evidence is immutable once created and never grants any
 * capability.
 */

/** Branded, serializable Evidence identifier. */
export type EvidenceId = string & { readonly __brand: "EvidenceId" };

export function asEvidenceId(raw: string): EvidenceId {
  if (!raw || raw.trim() === "") {
    throw new TypeError("EvidenceId must be non-empty");
  }
  return raw as EvidenceId;
}

/** Who/what produced the evidence. */
export type EvidenceSource =
  | "ast"
  | "sast"
  | "git"
  | "lint"
  | "symbol"
  | "test"
  | "agent";

/**
 * Strict JSON value type for evidence payloads. No `any`: unsupported values
 * (undefined, functions, symbols, bigint) are rejected at fingerprint time.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Repository-relative location. Lines are USER-FACING 1-BASED. The path must
 * be repository-relative with `/` separators (validated + normalized on
 * store insertion).
 */
export interface EvidenceLocation {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface EvidenceProvenance {
  readonly repository: string;
  readonly sha: string;
  readonly analyzer: string;
  readonly analyzerVersion: string;
}

/** Analyzer-supplied semantic fields. The Kernel derives fingerprint + id. */
export interface EvidenceInput {
  readonly source: EvidenceSource;
  readonly ruleId?: string;
  readonly location: EvidenceLocation;
  /** 0 <= confidence <= 1, finite. Fail closed otherwise. */
  readonly confidence: number;
  readonly payload: JsonValue;
  readonly provenance: EvidenceProvenance;
}

/** Complete immutable Evidence record as stored by the Kernel. */
export interface Evidence extends EvidenceInput {
  readonly id: EvidenceId;
  /** Deterministic SHA-256 fingerprint (see evidence/fingerprint.ts). */
  readonly fingerprint: string;
}

/** Frozen public view of an Evidence record. */
export type EvidenceSnapshot = Readonly<Evidence>;

export interface EvidenceQuery {
  readonly sha?: string;
  readonly path?: string;
  readonly source?: EvidenceSource;
  readonly ruleId?: string;
}
