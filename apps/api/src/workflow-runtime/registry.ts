/**
 * Workflow Runtime Node Registry — the runtime-owned truth about which
 * workflow node types can ACTUALLY execute (CKPT3 §9).
 *
 * Rules enforced here:
 *   - Only node types with a real executor service are registered. The UI may
 *     render this list; it must never invent executable node types.
 *   - `capabilityRequirements` name actions from the Kernel syscall registry
 *     (SYSCALL_DEFINITIONS). No capability name is invented for prompt
 *     symmetry; a requirement that is not a registered syscall fails compile.
 *   - `coeffects` name the harness/kernel services the node needs available.
 *     Feasibility against the live runtime is checked at compile time; actual
 *     availability is a Cordis lifecycle concern, never an authorization.
 */

import { getSyscallDefinition } from "@consistency/kernel";
import type { WorkflowRuntimeNodeType } from "@consistency/schema";

export type WorkflowNodeRole = "analyzer" | "verifier";

export interface WorkflowNodeService {
  readonly type: string;
  readonly serviceRef: string;
  readonly role: WorkflowNodeRole;
  readonly description: string;
  /** Kernel syscall actions the executor must issue for this node's agent. */
  readonly capabilityRequirements: readonly string[];
  /** Harness services that must be available for the node to activate. */
  readonly coeffects: readonly string[];
  readonly parameterSchema: WorkflowRuntimeNodeType["parameterSchema"];
}

/**
 * The minimal registry for the VerifiedMiniReview slice: exactly two node
 * types, both backed by real executor services in ./executor.ts.
 */
export const WORKFLOW_NODE_SERVICES: Readonly<Record<string, WorkflowNodeService>> = Object.freeze({
  "analyzer.deterministic-evidence": Object.freeze({
    type: "analyzer.deterministic-evidence",
    serviceRef: "deterministic-evidence.analyzer",
    role: "analyzer",
    description:
      "Deterministic PR-4 analyzers (style + secret, plugins-builtin) over repo.read " +
      "from the pinned snapshot; persists Evidence through evidence.write.",
    capabilityRequirements: ["repo.read", "evidence.write"],
    coeffects: ["admission", "repository-snapshot", "evidence-store"],
    parameterSchema: { fields: [{ name: "analyzers", label: "Analyzers", type: "string[]" as const, required: false, enumValues: ["style", "secret"], default: ["style", "secret"] }] },
  }),
  "verifier.persisted-evidence": Object.freeze({
    type: "verifier.persisted-evidence",
    serviceRef: "persisted-evidence.verifier",
    role: "verifier",
    description:
      "Recomputes deterministic fingerprints over PERSISTED Evidence loaded via " +
      "evidence.read and checks provenance against the pinned snapshot SHA.",
    capabilityRequirements: ["evidence.read"],
    coeffects: ["admission", "evidence-store"],
    parameterSchema: { fields: [] },
  }),
});

/**
 * Harness/kernel services this runtime can provide right now. Compile-time
 * coeffect feasibility is checked against this set — it describes the
 * executor's wiring, not an authorization decision.
 */
export const AVAILABLE_WORKFLOW_SERVICES: ReadonlySet<string> = new Set([
  "admission",
  "repository-snapshot",
  "evidence-store",
]);

export function getWorkflowNodeService(type: string): WorkflowNodeService | undefined {
  return WORKFLOW_NODE_SERVICES[type];
}

export function getWorkflowServiceByRef(serviceRef: string): WorkflowNodeService | undefined {
  return Object.values(WORKFLOW_NODE_SERVICES).find((service) => service.serviceRef === serviceRef);
}

/** Validate only configuration understood by the real deterministic runner. */
export function validateWorkflowNodeParameters(type: string, parameters: Readonly<Record<string, unknown>>): string | undefined {
  const keys = Object.keys(parameters);
  if (type !== "analyzer.deterministic-evidence") {
    return keys.length === 0 ? undefined : "Verifier parameters must be an empty object";
  }
  if (keys.some(key => key !== "analyzers")) {
    return "Analyzer parameters only support the 'analyzers' field";
  }
  const analyzers = parameters.analyzers;
  if (analyzers === undefined) return undefined;
  if (!Array.isArray(analyzers) || analyzers.length === 0 || analyzers.some(value => value !== "style" && value !== "secret")) {
    return "analyzers must be a non-empty array containing only style or secret";
  }
  if (new Set(analyzers).size !== analyzers.length) return "analyzers must not contain duplicates";
  return undefined;
}

/** True when the action is a registered Kernel syscall (requirement is nameable). */
export function isRegisteredSyscallAction(action: string): boolean {
  return getSyscallDefinition(action as never) !== undefined;
}

/** Registry DTO for the API/UI — no internals leak. */
export function listWorkflowNodeTypes(): WorkflowRuntimeNodeType[] {
  return Object.values(WORKFLOW_NODE_SERVICES).map((service) => ({
    type: service.type,
    serviceRef: service.serviceRef,
    role: service.role,
    description: service.description,
    capabilityRequirements: [...service.capabilityRequirements],
    coeffects: [...service.coeffects],
    parameterSchema: { fields: service.parameterSchema.fields.map(field => ({ ...field, ...(field.enumValues ? { enumValues: [...field.enumValues] } : {}) })) },
  }));
}
