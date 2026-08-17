/**
 * EvidenceStore — the Kernel's protected in-memory Evidence runtime.
 *
 * The store OWNS evidence identity: it validates input, normalizes the
 * location path (reusing the Kernel's path-safety rules), computes the
 * deterministic fingerprint itself (never trusting an analyzer-supplied
 * fingerprint), assigns the id, and deep-freezes every record. Nothing
 * mutable ever leaves the store.
 *
 * In-memory only for PR-4 — SQL persistence arrives later. Writing evidence
 * is protected internal state (EffectClass `revertible`), NOT an external
 * commit.
 */

import { randomUUID } from "node:crypto";
import {
  asEvidenceId,
  type Evidence,
  type EvidenceId,
  type EvidenceInput,
  type EvidenceQuery,
  type EvidenceSnapshot,
  type JsonValue,
} from "./types.js";
import {
  CanonicalizationError,
  EvidenceIdConflictError,
  EvidenceValidationError,
} from "./errors.js";
import { canonicalizeJson, computeEvidenceFingerprint } from "./fingerprint.js";
import { normaliseResourcePath } from "../identity/resource.js";

export class EvidenceStore {
  readonly #records = new Map<EvidenceId, Evidence>();

  /**
   * Create an immutable Evidence record.
   *
   * @throws {EvidenceValidationError} on invalid confidence/location.
   * @throws {CanonicalizationError} on unsupported payload values.
   * @throws {EvidenceIdConflictError} on duplicate id.
   */
  add(input: EvidenceInput, options: { readonly id?: EvidenceId } = {}): EvidenceSnapshot {
    this.#validateInput(input);

    // Canonical repository-relative path: normalize separators, reject
    // absolute paths / traversal / NUL (same rules as repo syscalls).
    let normalizedPath: string;
    try {
      normalizedPath = normaliseResourcePath(input.location.path);
    } catch (err) {
      throw new EvidenceValidationError(
        `invalid evidence location path: ${(err as Error).message}`,
      );
    }

    const normalizedInput: EvidenceInput = {
      source: input.source,
      ruleId: input.ruleId,
      location: {
        path: normalizedPath,
        startLine: input.location.startLine,
        endLine: input.location.endLine,
      },
      confidence: input.confidence,
      payload: input.payload,
      provenance: { ...input.provenance },
    };

    const fingerprint = computeEvidenceFingerprint(normalizedInput);
    const id = options.id ?? asEvidenceId(`evid_${randomUUID()}`);
    if (this.#records.has(id)) {
      throw new EvidenceIdConflictError(id);
    }

    const record: Evidence = Object.freeze({
      ...normalizedInput,
      id,
      fingerprint,
    });
    this.#records.set(id, deepFreeze(record) as Evidence);
    return this.#snapshot(record);
  }

  get(id: EvidenceId): EvidenceSnapshot | undefined {
    const record = this.#records.get(id);
    return record ? this.#snapshot(record) : undefined;
  }

  list(): readonly EvidenceSnapshot[] {
    return [...this.#records.values()].map((record) => this.#snapshot(record));
  }

  /** Deterministic order: (sha, path, startLine, endLine, source, ruleId, id). */
  query(filter: EvidenceQuery = {}): readonly EvidenceSnapshot[] {
    const matches = [...this.#records.values()].filter((record) => {
      if (filter.sha !== undefined && record.provenance.sha !== filter.sha) return false;
      if (filter.path !== undefined && record.location.path !== filter.path) return false;
      if (filter.source !== undefined && record.source !== filter.source) return false;
      if (filter.ruleId !== undefined && record.ruleId !== filter.ruleId) return false;
      return true;
    });
    matches.sort(compareEvidence);
    return matches.map((record) => this.#snapshot(record));
  }

  count(): number {
    return this.#records.size;
  }

  #validateInput(input: EvidenceInput): void {
    const c = input.confidence;
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
      throw new EvidenceValidationError(
        `confidence must be a finite number within [0, 1], got ${String(c)}`,
      );
    }
    const { startLine, endLine } = input.location;
    if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
      throw new EvidenceValidationError(`startLine must be a positive integer, got ${String(startLine)}`);
    }
    if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
      throw new EvidenceValidationError(`endLine must be a positive integer, got ${String(endLine)}`);
    }
    if (
      startLine !== undefined &&
      endLine !== undefined &&
      endLine < startLine
    ) {
      throw new EvidenceValidationError(`endLine (${endLine}) must be >= startLine (${startLine})`);
    }
    if (!input.provenance.repository.trim() || !input.provenance.sha.trim()) {
      throw new EvidenceValidationError("provenance repository and sha must be non-empty");
    }
    if (!input.provenance.analyzer.trim() || !input.provenance.analyzerVersion.trim()) {
      throw new EvidenceValidationError("provenance analyzer and analyzerVersion must be non-empty");
    }
    // Payload must be canonicalizable — fail closed at insertion, not later.
    canonicalizeJson(input.payload);
  }

  #snapshot(record: Evidence): EvidenceSnapshot {
    // Records are already deep-frozen; return them directly (frozen = safe).
    return record;
  }
}

function compareEvidence(a: Evidence, b: Evidence): number {
  const bySha = a.provenance.sha < b.provenance.sha ? -1 : a.provenance.sha > b.provenance.sha ? 1 : 0;
  if (bySha !== 0) return bySha;
  const byPath = a.location.path < b.location.path ? -1 : a.location.path > b.location.path ? 1 : 0;
  if (byPath !== 0) return byPath;
  const aStart = a.location.startLine ?? 0;
  const bStart = b.location.startLine ?? 0;
  if (aStart !== bStart) return aStart - bStart;
  const aEnd = a.location.endLine ?? 0;
  const bEnd = b.location.endLine ?? 0;
  if (aEnd !== bEnd) return aEnd - bEnd;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  const aRule = a.ruleId ?? "";
  const bRule = b.ruleId ?? "";
  if (aRule !== bRule) return aRule < bRule ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function deepFreeze(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    return Object.freeze(value);
  }
  return value;
}

export { canonicalizeJson };
