/**
 * Deterministic canonical serialization + Evidence fingerprinting.
 *
 * Canonical form:
 *   - object keys are SORTED (key-insertion-order independent),
 *   - array order is preserved,
 *   - strings are JSON-escaped,
 *   - numbers use their JSON representation (so 0.5 and 0.50 coincide),
 *   - null/boolean are literal.
 * Unsupported values (undefined, function, symbol, bigint, cycles, class
 * instances) throw {@link CanonicalizationError} — we never fingerprint
 * nondeterministically.
 *
 * Evidence fingerprint = SHA-256 hex over the canonical serialization of:
 *
 *   [ source,
 *     ruleId | null,
 *     location.path,
 *     location.startLine | null,
 *     location.endLine | null,
 *     confidence,
 *     payload,
 *     provenance.repository,
 *     provenance.sha,            ← snapshot SHA participates: same rule at a
 *     provenance.analyzer,         different revision never shares identity
 *     provenance.analyzerVersion ]
 */

import { createHash } from "node:crypto";
import { CanonicalizationError } from "./errors.js";
import type { EvidenceInput, JsonValue } from "./types.js";

const MAX_CANONICAL_DEPTH = 64;

export function canonicalizeJson(value: JsonValue, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new CanonicalizationError("payload exceeds maximum nesting depth");
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`non-finite number ${String(value)} cannot be canonicalized`);
      }
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalizeJson(item, depth + 1)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError("non-plain object cannot be canonicalized");
      }
      const keys = Object.keys(value).sort();
      const parts = keys.map((key) => {
        const child = (value as Record<string, JsonValue>)[key];
        if (child === undefined) {
          throw new CanonicalizationError(`property ${JSON.stringify(key)} is undefined`);
        }
        return `${JSON.stringify(key)}:${canonicalizeJson(child, depth + 1)}`;
      });
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalizationError(`unsupported value of type ${typeof value}`);
  }
}

/**
 * Compute the deterministic Evidence fingerprint.
 *
 * Throws {@link CanonicalizationError} on unsupported payload values and
 * {@link RangeError} on invalid confidence — never a silent fingerprint.
 */
export function computeEvidenceFingerprint(input: EvidenceInput): string {
  const { location, provenance } = input;
  if (
    typeof input.confidence !== "number" ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  ) {
    throw new RangeError(`confidence must be a finite number within [0, 1], got ${String(input.confidence)}`);
  }
  const parts: JsonValue = [
    input.source,
    input.ruleId ?? null,
    location.path,
    location.startLine ?? null,
    location.endLine ?? null,
    input.confidence,
    input.payload,
    provenance.repository,
    provenance.sha,
    provenance.analyzer,
    provenance.analyzerVersion,
  ];
  return createHash("sha256").update(canonicalizeJson(parts), "utf8").digest("hex");
}
