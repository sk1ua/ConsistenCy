/** Runtime-native built-in workflow library. */
import { createHash } from "node:crypto";
import type { WorkflowRuntimeDefinition, WorkflowRuntimeNode } from "@consistency/schema";

export interface RuntimeBuiltinMetadata {
  readonly id: string;
  readonly revision: number;
  readonly revisionId: string;
  readonly checksum: string;
  readonly purpose: string;
  readonly evidenceConstraint: string;
  readonly verifierConstraint: string;
  readonly failureSemantics: string;
  readonly namespace: "workflow-runtime";
  readonly verificationContract: string;
  readonly verificationMatrixVersion: string;
  readonly status: "available";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function freezeDefinition(definition: WorkflowRuntimeDefinition): WorkflowRuntimeDefinition {
  return deepFreeze(definition);
}
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => current && typeof current === "object" && !Array.isArray(current)
    ? Object.fromEntries(Object.entries(current as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : current);
}
export function runtimeBuiltinChecksum(definition: WorkflowRuntimeDefinition): string {
  return createHash("sha256").update(stableJson(definition)).digest("hex");
}

function analyzer(id: string, analyzers: readonly ("style" | "secret")[]): WorkflowRuntimeNode {
  return { id, type: "analyzer.deterministic-evidence", serviceRef: "deterministic-evidence.analyzer", parameters: { analyzers: [...analyzers] }, failurePolicy: "fail-closed" };
}
const verifier: WorkflowRuntimeNode = { id: "verify", type: "verifier.persisted-evidence", serviceRef: "persisted-evidence.verifier", parameters: {}, failurePolicy: "fail-closed" };
function makeDefinition(id: string, nodes: WorkflowRuntimeNode[], edges: WorkflowRuntimeDefinition["edges"]): WorkflowRuntimeDefinition {
  return freezeDefinition({ id, version: 1, nodes, edges });
}

// Compatibility bytes are intentionally kept as the original definition.
export const VERIFIED_MINI_REVIEW_DEFINITION = makeDefinition("verified-mini-review", [
  { id: "analyze", type: "analyzer.deterministic-evidence", serviceRef: "deterministic-evidence.analyzer", parameters: {}, failurePolicy: "fail-closed" }, verifier,
], [{ from: "analyze", to: "verify" }]);

const specs: Readonly<Record<string, { purpose: string; contract: string; nodes: WorkflowRuntimeNode[]; edges: WorkflowRuntimeDefinition["edges"] }>> = Object.assign(Object.create(null), {
  "pr-review": { purpose: "Broad deterministic review of style and secret evidence.", contract: "combined-style-secret", nodes: [analyzer("analyze", ["style", "secret"]), verifier], edges: [{ from: "analyze", to: "verify" }] },
  "pr-sanity-verification": { purpose: "Fast deterministic sanity verification of source style.", contract: "style-only", nodes: [analyzer("analyze", ["style"]), verifier], edges: [{ from: "analyze", to: "verify" }] },
  "security-hardening": { purpose: "Deterministic secret exposure hardening checks.", contract: "secret-only", nodes: [analyzer("analyze", ["secret"]), verifier], edges: [{ from: "analyze", to: "verify" }] },
  "architectural-drift": { purpose: "Independent fan-out style and secret evidence gates.", contract: "fan-out-style-secret", nodes: [analyzer("style", ["style"]), analyzer("secret", ["secret"]), verifier], edges: [{ from: "style", to: "verify" }, { from: "secret", to: "verify" }] },
  "vibe-safety": { purpose: "Sequential deterministic safety gates: style, then secret, then verification.", contract: "sequential-style-secret-verification", nodes: [analyzer("style", ["style"]), analyzer("secret", ["secret"]), verifier], edges: [{ from: "style", to: "secret" }, { from: "secret", to: "verify" }] },
});

export const WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS: Readonly<Record<string, WorkflowRuntimeDefinition>> = Object.freeze(Object.assign(Object.create(null), Object.fromEntries([
  [VERIFIED_MINI_REVIEW_DEFINITION.id, VERIFIED_MINI_REVIEW_DEFINITION],
  ...Object.entries(specs).map(([id, spec]) => [id, makeDefinition(id, spec.nodes, spec.edges)]),
])));
export const WORKFLOW_RUNTIME_BUILTIN_METADATA: Readonly<Record<string, RuntimeBuiltinMetadata>> = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(
  Object.entries(WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS).map(([id, definition]) => {
    const spec = specs[id];
    return [id, Object.freeze({
      id, revision: 1, revisionId: `wfrev_builtin_${id}_v1`, checksum: runtimeBuiltinChecksum(definition),
      purpose: spec?.purpose ?? "Immutable compatibility seed for the workflow-runtime vertical slice.",
      evidenceConstraint: "At least one persisted Evidence record with fingerprint and pinned repository SHA.",
      verifierConstraint: "Only persisted Evidence is re-fingerprinted; every finding must reference verified evidence.",
      failureSemantics: "Fail closed on schema, graph, capability, snapshot, analyzer, evidence, or verifier failure.",
      namespace: "workflow-runtime" as const, verificationContract: spec?.contract ?? "compatibility-style-secret-default",
      verificationMatrixVersion: "ckpt6-phase1-v1", status: "available" as const,
    })];
  }),
)));
export const WORKFLOW_RUNTIME_BUILTIN_IDS = Object.freeze(Object.keys(WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS));
export function getWorkflowRuntimeBuiltinDefinition(id: string): WorkflowRuntimeDefinition | undefined { return WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS[id]; }
export function getWorkflowRuntimeBuiltinMetadata(id: string): RuntimeBuiltinMetadata | undefined { return WORKFLOW_RUNTIME_BUILTIN_METADATA[id]; }
