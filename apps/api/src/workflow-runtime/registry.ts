/**
 * Workflow Runtime Node Registry — the runtime-owned truth about which
 * workflow node types can ACTUALLY execute (CKPT3 §9), backed by the H16
 * versioned node descriptor contract (`workflowRuntimeNodeDescriptorSchema`).
 *
 * Rules enforced here:
 *   - Only node types with a real executor service are registered. The UI may
 *     render this list; it must never invent executable node types.
 *   - Registration validates the descriptor (fail-closed): required fields
 *     (strict schema), supported descriptor `schemaVersion`, every
 *     `capabilityRequirement` names a registered Kernel syscall, and the
 *     registry id (`type`) is unique. Invalid descriptors never enter the
 *     registry — a rejected register() leaves the registry unchanged.
 *   - `capabilityRequirements` name actions from the Kernel syscall registry
 *     (SYSCALL_DEFINITIONS). No capability name is invented for prompt
 *     symmetry; a requirement that is not a registered syscall fails compile.
 *   - `coeffects` name the harness/kernel services the node needs available.
 *     Feasibility against the live runtime is checked at compile time; actual
 *     availability is a Cordis lifecycle concern, never an authorization.
 *
 * H16 boundary: this ticket ships the descriptor contract + registry only.
 * The executor keeps its current per-serviceRef dispatch until H17 moves it
 * to descriptor-driven dispatch (keyed on `kind`); registering new node
 * types here then requires no executor change.
 */

import { getSyscallDefinition } from "@consistency/kernel";
import {
  WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION,
  workflowRuntimeNodeDescriptorSchema,
  type WorkflowNodeKind,
  type WorkflowRuntimeNodeDescriptor,
  type WorkflowRuntimeNodeType,
} from "@consistency/schema";

export type WorkflowNodeRole = "analyzer" | "verifier" | "tool" | "model-verifier" | "control";

/**
 * Legacy DTO projection: descriptor kind → `WorkflowRuntimeNodeType.role`
 * (the shared DTO contract keeps a bounded role enum; H17 extends it
 * additively with the new kinds).
 */
const KIND_TO_LEGACY_ROLE: Readonly<Record<WorkflowNodeKind, WorkflowNodeRole>> = Object.freeze({
  "deterministic-analyzer": "analyzer",
  "persisted-evidence-verifier": "verifier",
  "llm-structured-verifier": "model-verifier",
  "readonly-tool": "tool",
  "subflow": "control",
});

/** A registered node service IS a validated versioned descriptor (H16). */
export type WorkflowNodeService = WorkflowRuntimeNodeDescriptor;

/** Structured, fail-closed registration rejection reasons. */
export type WorkflowNodeDescriptorRejectionCode =
  | "descriptor_schema_invalid"
  | "descriptor_schema_version_unsupported"
  | "unknown_capability_requirement"
  | "duplicate_node_type";

/** Thrown by register() when a descriptor is rejected; the registry is unchanged. */
export class WorkflowNodeRegistryError extends Error {
  readonly code: WorkflowNodeDescriptorRejectionCode;
  /** Structured detail (zod issue text or the offending capability names). */
  readonly details: readonly string[];

  constructor(code: WorkflowNodeDescriptorRejectionCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "WorkflowNodeRegistryError";
    this.code = code;
    this.details = details;
  }
}

export interface WorkflowNodeRegistry {
  /** Validate + register a descriptor; throws WorkflowNodeRegistryError on rejection. */
  register(descriptor: unknown): WorkflowRuntimeNodeDescriptor;
  /** Describe one registered node type, or undefined when unknown. */
  describe(type: string): WorkflowRuntimeNodeDescriptor | undefined;
  /** All registered descriptors in deterministic, stable order (sorted by type). */
  list(): readonly WorkflowRuntimeNodeDescriptor[];
}

/** Registry truth is immutable: descriptors and their arrays are frozen. */
function freezeDescriptor(descriptor: WorkflowRuntimeNodeDescriptor): WorkflowRuntimeNodeDescriptor {
  Object.freeze(descriptor.capabilityRequirements);
  Object.freeze(descriptor.coeffects);
  Object.freeze(descriptor.parameterSchema);
  Object.freeze(descriptor.parameterSchema.fields);
  for (const field of descriptor.parameterSchema.fields) Object.freeze(field);
  return Object.freeze(descriptor);
}

/** Stable registry-id ordering (code-unit compare; independent of insertion order). */
function byTypeOrder(a: WorkflowRuntimeNodeDescriptor, b: WorkflowRuntimeNodeDescriptor): number {
  return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
}

export function createWorkflowNodeRegistry(): WorkflowNodeRegistry {
  const byType = new Map<string, WorkflowRuntimeNodeDescriptor>();
  return {
    register(descriptor: unknown): WorkflowRuntimeNodeDescriptor {
      const parsed = workflowRuntimeNodeDescriptorSchema.safeParse(descriptor);
      if (!parsed.success) {
        const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
        throw new WorkflowNodeRegistryError(
          "descriptor_schema_invalid",
          "node descriptor failed schema validation (" + details.join("; ") + ")",
          details,
        );
      }
      const value = parsed.data;
      if (value.schemaVersion !== WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION) {
        throw new WorkflowNodeRegistryError(
          "descriptor_schema_version_unsupported",
          `descriptor schemaVersion ${value.schemaVersion} is not supported (supported: ${WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION})`,
          [String(value.schemaVersion)],
        );
      }
      const unknownCapabilities = value.capabilityRequirements.filter((action) => !isRegisteredSyscallAction(action));
      if (unknownCapabilities.length > 0) {
        throw new WorkflowNodeRegistryError(
          "unknown_capability_requirement",
          `capability requirement(s) not registered as Kernel syscalls: ${unknownCapabilities.join(", ")}`,
          unknownCapabilities,
        );
      }
      if (byType.has(value.type)) {
        throw new WorkflowNodeRegistryError(
          "duplicate_node_type",
          `node type '${value.type}' is already registered`,
          [value.type],
        );
      }
      const frozen = freezeDescriptor(value);
      byType.set(frozen.type, frozen);
      return frozen;
    },
    describe(type: string): WorkflowRuntimeNodeDescriptor | undefined {
      return byType.get(type);
    },
    list(): readonly WorkflowRuntimeNodeDescriptor[] {
      return [...byType.values()].sort(byTypeOrder);
    },
  };
}

/** Process-wide registry; the builtin node types below register at module load. */
export const workflowNodeRegistry: WorkflowNodeRegistry = createWorkflowNodeRegistry();

// ---------------------------------------------------------------------------
// Builtin node types — re-registered under the versioned descriptor contract
// (H16). Fields that existed pre-H16 are byte-identical to the previous
// static table; `kind` and the I/O schema references are the new contract.
// ---------------------------------------------------------------------------

/** The pinned snapshot read surface the executor hands analyzer agents. */
const PINNED_SNAPSHOT_FILES_SCHEMA_REF = Object.freeze({ name: "workflow-runtime.pinned-snapshot-files", version: 1 });
const EVIDENCE_INPUT_SCHEMA_REF = Object.freeze({ name: "kernel.evidence-input", version: 1 });
const EVIDENCE_SNAPSHOT_SCHEMA_REF = Object.freeze({ name: "kernel.evidence-snapshot", version: 1 });
const FINDING_SCHEMA_REF = Object.freeze({ name: "workflow-runtime.finding", version: 1 });
/** H17 read-only tool output contract (bounded pinned-file context). */
const PINNED_FILE_CONTEXT_SCHEMA_REF = Object.freeze({ name: "workflow-runtime.pinned-file-context", version: 1 });
/** H17 model verification output contract (fingerprint-keyed verdicts). */
const MODEL_VERIFICATION_SCHEMA_REF = Object.freeze({ name: "workflow-runtime.model-verification", version: 1 });
const SUBFLOW_SCHEMA_REF = Object.freeze({ name: "workflow-runtime.subflow", version: 1 });

const DETERMINISTIC_ANALYZER_NODE_DESCRIPTOR: WorkflowRuntimeNodeDescriptor = {
  schemaVersion: WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION,
  type: "analyzer.deterministic-evidence",
  kind: "deterministic-analyzer",
  serviceRef: "deterministic-evidence.analyzer",
  description:
    "Deterministic PR-4 analyzers (style + secret, plugins-builtin) over repo.read " +
    "from the pinned snapshot; persists Evidence through evidence.write.",
  capabilityRequirements: ["repo.read", "evidence.write"],
  coeffects: ["admission", "repository-snapshot", "evidence-store"],
  parameterSchema: { fields: [{ name: "analyzers", label: "Analyzers", type: "string[]", required: false, enumValues: ["style", "secret"], default: ["style", "secret"] }] },
  inputSchema: PINNED_SNAPSHOT_FILES_SCHEMA_REF,
  outputSchema: EVIDENCE_INPUT_SCHEMA_REF,
};

const PERSISTED_EVIDENCE_VERIFIER_NODE_DESCRIPTOR: WorkflowRuntimeNodeDescriptor = {
  schemaVersion: WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION,
  type: "verifier.persisted-evidence",
  kind: "persisted-evidence-verifier",
  serviceRef: "persisted-evidence.verifier",
  description:
    "Recomputes deterministic fingerprints over PERSISTED Evidence loaded via " +
    "evidence.read and checks provenance against the pinned snapshot SHA.",
  capabilityRequirements: ["evidence.read"],
  coeffects: ["admission", "evidence-store"],
  parameterSchema: { fields: [] },
  inputSchema: EVIDENCE_SNAPSHOT_SCHEMA_REF,
  outputSchema: FINDING_SCHEMA_REF,
};

// ---------------------------------------------------------------------------
// H17 — model + read-only tool node types. Registration is the ONLY way a
// node type becomes executable: the executor dispatches on the descriptor's
// `kind`, so these two descriptors are what make the new node bodies
// reachable from definitions (no per-serviceRef hardcoding).
// ---------------------------------------------------------------------------

const PINNED_FILE_CONTEXT_TOOL_NODE_DESCRIPTOR: WorkflowRuntimeNodeDescriptor = {
  schemaVersion: WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION,
  type: "tool.pinned-file-context",
  kind: "readonly-tool",
  serviceRef: "pinned-file-context.tool",
  description:
    "READ-ONLY tool: excerpts a bounded number of files from the pinned snapshot " +
    "through repo.read syscalls (no writes, no network, no side effects) so a " +
    "downstream model node can anchor its verification in real file content.",
  capabilityRequirements: ["repo.read"],
  coeffects: ["admission", "repository-snapshot"],
  parameterSchema: {
    fields: [
      { name: "maxFiles", label: "Max files", type: "number", required: false, default: 4 },
      { name: "maxCharsPerFile", label: "Max chars per file", type: "number", required: false, default: 1200 },
    ],
  },
  inputSchema: PINNED_SNAPSHOT_FILES_SCHEMA_REF,
  outputSchema: PINNED_FILE_CONTEXT_SCHEMA_REF,
};

const MODEL_STRUCTURED_VERIFIER_NODE_DESCRIPTOR: WorkflowRuntimeNodeDescriptor = {
  schemaVersion: WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION,
  type: "verifier.model-structured",
  kind: "llm-structured-verifier",
  serviceRef: "model-structured.verifier",
  description:
    "Structured model verification over PERSISTED Evidence: ONE strict-schema " +
    "model invocation through the unified LLM entry (llm.invoke capability + " +
    "Kernel facade — never a node-local provider). Verdicts key on evidence " +
    "FINGERPRINTS (restart-stable). Bad JSON or a failed invocation yields an " +
    "explainable degraded outcome, never a fabricated verification.",
  capabilityRequirements: ["evidence.read", "llm.invoke"],
  coeffects: ["admission", "evidence-store", "llm-driver"],
  parameterSchema: { fields: [] },
  inputSchema: EVIDENCE_SNAPSHOT_SCHEMA_REF,
  outputSchema: MODEL_VERIFICATION_SCHEMA_REF,
};

const SUBFLOW_NODE_DESCRIPTOR: WorkflowRuntimeNodeDescriptor = {
  schemaVersion: WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION,
  type: "control.subflow",
  kind: "subflow",
  serviceRef: "control.subflow",
  description: "Compile-time inclusion of one saved validated workflow revision. It is expanded before execution and is never dispatched.",
  capabilityRequirements: [],
  coeffects: [],
  parameterSchema: { fields: [
    { name: "definitionId", label: "Definition", type: "string", required: true },
    { name: "revisionId", label: "Revision", type: "string", required: false },
  ] },
  inputSchema: SUBFLOW_SCHEMA_REF,
  outputSchema: SUBFLOW_SCHEMA_REF,
};

/** Builtin descriptors, in their stable registration order (analyzer first). */
const BUILTIN_NODE_DESCRIPTORS: readonly WorkflowRuntimeNodeDescriptor[] = Object.freeze([
  DETERMINISTIC_ANALYZER_NODE_DESCRIPTOR,
  PERSISTED_EVIDENCE_VERIFIER_NODE_DESCRIPTOR,
  PINNED_FILE_CONTEXT_TOOL_NODE_DESCRIPTOR,
  MODEL_STRUCTURED_VERIFIER_NODE_DESCRIPTOR,
  SUBFLOW_NODE_DESCRIPTOR,
]);

for (const descriptor of BUILTIN_NODE_DESCRIPTORS) {
  workflowNodeRegistry.register(descriptor);
}

/**
 * The minimal registry for the VerifiedMiniReview slice: exactly two node
 * types, both backed by real executor services in ./executor.ts. Legacy
 * frozen snapshot of the builtin registrations — the LIVE truth is
 * `workflowNodeRegistry` (lookups below delegate to it).
 */
export const WORKFLOW_NODE_SERVICES: Readonly<Record<string, WorkflowNodeService>> = Object.freeze(
  Object.fromEntries(workflowNodeRegistry.list().map((descriptor) => [descriptor.type, descriptor])),
);

/**
 * Harness/kernel services this runtime can provide right now. Compile-time
 * coeffect feasibility is checked against this set — it describes the
 * executor's wiring, not an authorization decision. `llm-driver` (H17) is
 * provided when the HOST wires the unified-entry model backend; the trigger
 * path refuses runs that need it while no provider is configured.
 */
export const AVAILABLE_WORKFLOW_SERVICES: ReadonlySet<string> = new Set([
  "admission",
  "repository-snapshot",
  "evidence-store",
  "llm-driver",
]);

export function getWorkflowNodeService(type: string): WorkflowNodeService | undefined {
  return workflowNodeRegistry.describe(type);
}

export function getWorkflowServiceByRef(serviceRef: string): WorkflowNodeService | undefined {
  return workflowNodeRegistry.list().find((service) => service.serviceRef === serviceRef);
}

/** Validate only configuration understood by the real executor dispatchers. */
export function validateWorkflowNodeParameters(type: string, parameters: Readonly<Record<string, unknown>>): string | undefined {
  const keys = Object.keys(parameters);
  if (type === "analyzer.deterministic-evidence") {
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
  if (type === "control.subflow") {
    if (keys.some((key) => key !== "definitionId" && key !== "revisionId")) {
      return "Subflow parameters only support definitionId and revisionId";
    }
    if (typeof parameters.definitionId !== "string" || parameters.definitionId.trim() === "") {
      return "Subflow definitionId must be a non-empty string";
    }
    if (parameters.revisionId !== undefined && (typeof parameters.revisionId !== "string" || parameters.revisionId.trim() === "")) {
      return "Subflow revisionId must be a non-empty string when present";
    }
    return undefined;
  }
  if (type === "tool.pinned-file-context") {
    // H17 read-only tool: bounded, positive tuning knobs only.
    if (keys.some(key => key !== "maxFiles" && key !== "maxCharsPerFile")) {
      return "Tool parameters only support 'maxFiles' and 'maxCharsPerFile'";
    }
    for (const key of ["maxFiles", "maxCharsPerFile"] as const) {
      const value = parameters[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 64) {
        return `${key} must be an integer between 1 and 64`;
      }
    }
    return undefined;
  }
  return keys.length === 0 ? undefined : "Verifier parameters must be an empty object";
}

/** True when the action is a registered Kernel syscall (requirement is nameable). */
export function isRegisteredSyscallAction(action: string): boolean {
  return getSyscallDefinition(action as never) !== undefined;
}

/** H16 registration protocol — validate + register into the process registry. */
export function registerWorkflowNodeDescriptor(descriptor: unknown): WorkflowRuntimeNodeDescriptor {
  return workflowNodeRegistry.register(descriptor);
}

/** H16 describe — one registered node type by registry id. */
export function describeWorkflowNodeType(type: string): WorkflowRuntimeNodeDescriptor | undefined {
  return workflowNodeRegistry.describe(type);
}

/** H16 list — deterministic (sorted by registry id) snapshot of the live registry. */
export function listWorkflowNodeDescriptors(): readonly WorkflowRuntimeNodeDescriptor[] {
  return workflowNodeRegistry.list();
}

/** Registry DTO for the API/UI — no internals leak. */
export function listWorkflowNodeTypes(): WorkflowRuntimeNodeType[] {
  return workflowNodeRegistry.list().map((service) => ({
    type: service.type,
    serviceRef: service.serviceRef,
    role: KIND_TO_LEGACY_ROLE[service.kind],
    description: service.description,
    capabilityRequirements: [...service.capabilityRequirements],
    coeffects: [...service.coeffects],
    parameterSchema: { fields: service.parameterSchema.fields.map(field => ({ ...field, ...(field.enumValues ? { enumValues: [...field.enumValues] } : {}) })) },
  }));
}
