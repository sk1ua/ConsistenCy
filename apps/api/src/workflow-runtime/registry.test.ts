/**
 * H16 — Node Registry unit tests.
 *
 * Covers the versioned descriptor registration protocol:
 *   - registration of valid descriptors (register/describe/list);
 *   - registration-time rejection: missing fields, malformed ids, unsupported
 *     schemaVersion, unknown capability requirements, duplicate registry ids
 *     (every rejection leaves the registry unchanged);
 *   - deterministic, stable list ordering;
 *   - builtin compatibility: the two existing node types
 *     (analyzer.deterministic-evidence, verifier.persisted-evidence) keep
 *     byte-identical legacy behavior — same DTO, same lookups, same
 *     parameter rules. Zero behavior change.
 */

import { describe, expect, it } from "vitest";
import { SYSCALL_DEFINITIONS } from "@consistency/kernel";
import {
  WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION,
  type WorkflowRuntimeNodeDescriptor,
} from "@consistency/schema";
import {
  AVAILABLE_WORKFLOW_SERVICES,
  WorkflowNodeRegistryError,
  createWorkflowNodeRegistry,
  describeWorkflowNodeType,
  getWorkflowNodeService,
  getWorkflowServiceByRef,
  isRegisteredSyscallAction,
  listWorkflowNodeDescriptors,
  listWorkflowNodeTypes,
  registerWorkflowNodeDescriptor,
  validateWorkflowNodeParameters,
  workflowNodeRegistry,
  type WorkflowNodeDescriptorRejectionCode,
  type WorkflowNodeRegistry,
} from "./registry";

/** A valid descriptor for registration tests (rejected ids never collide with builtins). */
function syntheticDescriptor(overrides: Partial<WorkflowRuntimeNodeDescriptor> = {}): WorkflowRuntimeNodeDescriptor {
  return {
    schemaVersion: WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION,
    type: "test.probe",
    kind: "deterministic-analyzer",
    serviceRef: "test.probe.service",
    description: "H16 test probe node",
    capabilityRequirements: ["evidence.read"],
    coeffects: [],
    parameterSchema: { fields: [] },
    inputSchema: { name: "kernel.evidence-snapshot", version: 1 },
    outputSchema: { name: "workflow-runtime.finding", version: 1 },
    ...overrides,
  };
}

function omit(descriptor: WorkflowRuntimeNodeDescriptor, key: keyof WorkflowRuntimeNodeDescriptor): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...descriptor };
  delete copy[key];
  return copy;
}

/** Asserts register() fails closed with the expected structured code. */
function expectReject(
  descriptor: unknown,
  code: WorkflowNodeDescriptorRejectionCode,
  registry: WorkflowNodeRegistry = workflowNodeRegistry,
): void {
  let caught: unknown;
  try {
    registry.register(descriptor);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkflowNodeRegistryError);
  expect((caught as WorkflowNodeRegistryError).code).toBe(code);
}

// ---------------------------------------------------------------------------
// Builtin compatibility — zero behavior change
// ---------------------------------------------------------------------------

describe("H16 registry — builtin node compatibility", () => {
  // H17 grew the registry additively: the two original descriptors are
  // unchanged (asserted byte-identically below); the model + read-only tool
  // node types join them under the same versioned contract.
  const EXPECTED_BUILTIN_TYPES = [
    "analyzer.deterministic-evidence",
    "control.subflow",
    "tool.pinned-file-context",
    "verifier.model-structured",
    "verifier.persisted-evidence",
  ];

  it("registers exactly the two original + two H17 node types under the versioned contract", () => {
    const descriptors = listWorkflowNodeDescriptors();
    expect(descriptors.map((descriptor) => descriptor.type)).toEqual(EXPECTED_BUILTIN_TYPES);
    for (const descriptor of descriptors) {
      expect(descriptor.schemaVersion).toBe(WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION);
      expect(describeWorkflowNodeType(descriptor.type)).toBe(descriptor);
    }
    expect(describeWorkflowNodeType("analyzer.deterministic-evidence")?.kind).toBe("deterministic-analyzer");
    expect(describeWorkflowNodeType("verifier.persisted-evidence")?.kind).toBe("persisted-evidence-verifier");
    expect(describeWorkflowNodeType("tool.pinned-file-context")?.kind).toBe("readonly-tool");
    expect(describeWorkflowNodeType("verifier.model-structured")?.kind).toBe("llm-structured-verifier");
  });

  it("keeps the legacy node-type DTO byte-identical (role, description, parameters)", () => {
    const legacyTypes = listWorkflowNodeTypes().filter((nodeType) =>
      nodeType.type === "analyzer.deterministic-evidence" || nodeType.type === "verifier.persisted-evidence",
    );
    expect(legacyTypes).toEqual([
      {
        type: "analyzer.deterministic-evidence",
        serviceRef: "deterministic-evidence.analyzer",
        role: "analyzer",
        description:
          "Deterministic PR-4 analyzers (style + secret, plugins-builtin) over repo.read " +
          "from the pinned snapshot; persists Evidence through evidence.write.",
        capabilityRequirements: ["repo.read", "evidence.write"],
        coeffects: ["admission", "repository-snapshot", "evidence-store"],
        parameterSchema: {
          fields: [
            { name: "analyzers", label: "Analyzers", type: "string[]", required: false, enumValues: ["style", "secret"], default: ["style", "secret"] },
          ],
        },
      },
      {
        type: "verifier.persisted-evidence",
        serviceRef: "persisted-evidence.verifier",
        role: "verifier",
        description:
          "Recomputes deterministic fingerprints over PERSISTED Evidence loaded via " +
          "evidence.read and checks provenance against the pinned snapshot SHA.",
        capabilityRequirements: ["evidence.read"],
        coeffects: ["admission", "evidence-store"],
        parameterSchema: { fields: [] },
      },
    ]);
    // H17: the new DTO entries carry the extended roles and their contracts.
    const tool = listWorkflowNodeTypes().find((nodeType) => nodeType.type === "tool.pinned-file-context");
    const model = listWorkflowNodeTypes().find((nodeType) => nodeType.type === "verifier.model-structured");
    expect(tool?.role).toBe("tool");
    expect(tool?.capabilityRequirements).toEqual(["repo.read"]);
    expect(model?.role).toBe("model-verifier");
    expect(model?.capabilityRequirements).toEqual(["evidence.read", "llm.invoke"]);
  });

  it("keeps legacy lookups working (by type, by serviceRef, unknown → undefined)", () => {
    expect(getWorkflowNodeService("analyzer.deterministic-evidence")?.serviceRef).toBe("deterministic-evidence.analyzer");
    expect(getWorkflowNodeService("verifier.persisted-evidence")?.serviceRef).toBe("persisted-evidence.verifier");
    expect(getWorkflowNodeService("not.a.node")).toBeUndefined();
    expect(getWorkflowServiceByRef("deterministic-evidence.analyzer")?.type).toBe("analyzer.deterministic-evidence");
    expect(getWorkflowServiceByRef("persisted-evidence.verifier")?.type).toBe("verifier.persisted-evidence");
    expect(getWorkflowServiceByRef("no.such.service")).toBeUndefined();
  });

  it("builtin capability requirements are all registered Kernel syscalls", () => {
    const actions = new Set(SYSCALL_DEFINITIONS.map((definition) => definition.action));
    for (const descriptor of listWorkflowNodeDescriptors()) {
      if (descriptor.kind !== "subflow") expect(descriptor.capabilityRequirements.length).toBeGreaterThan(0);
      for (const action of descriptor.capabilityRequirements) {
        expect(actions.has(action as never)).toBe(true);
      }
    }
  });

  it("builtin coeffects stay within the services this runtime provides", () => {
    for (const descriptor of listWorkflowNodeDescriptors()) {
      for (const coeffect of descriptor.coeffects) {
        expect(AVAILABLE_WORKFLOW_SERVICES.has(coeffect)).toBe(true);
      }
    }
  });

  it("registered descriptors are immutable registry truth", () => {
    const descriptor = describeWorkflowNodeType("analyzer.deterministic-evidence")!;
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.capabilityRequirements)).toBe(true);
    expect(Object.isFrozen(descriptor.coeffects)).toBe(true);
  });

  it("keeps legacy parameter validation behavior unchanged", () => {
    expect(validateWorkflowNodeParameters("analyzer.deterministic-evidence", {})).toBeUndefined();
    expect(validateWorkflowNodeParameters("analyzer.deterministic-evidence", { analyzers: ["style"] })).toBeUndefined();
    expect(validateWorkflowNodeParameters("analyzer.deterministic-evidence", { analyzers: ["bogus"] })).toBe(
      "analyzers must be a non-empty array containing only style or secret",
    );
    expect(validateWorkflowNodeParameters("analyzer.deterministic-evidence", { analyzers: ["style", "style"] })).toBe(
      "analyzers must not contain duplicates",
    );
    expect(validateWorkflowNodeParameters("analyzer.deterministic-evidence", { other: 1 })).toBe(
      "Analyzer parameters only support the 'analyzers' field",
    );
    expect(validateWorkflowNodeParameters("verifier.persisted-evidence", {})).toBeUndefined();
    expect(validateWorkflowNodeParameters("verifier.persisted-evidence", { analyzers: ["style"] })).toBe(
      "Verifier parameters must be an empty object",
    );
  });
});

// ---------------------------------------------------------------------------
// Registration protocol
// ---------------------------------------------------------------------------

describe("H16 registry — registration", () => {
  it("a fresh registry is empty and describes nothing", () => {
    const registry = createWorkflowNodeRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.describe("test.probe")).toBeUndefined();
  });

  it("a valid descriptor registers, is described, and appears in the list", () => {
    const registry = createWorkflowNodeRegistry();
    const registered = registry.register(syntheticDescriptor());
    expect(registered).toEqual(syntheticDescriptor());
    expect(registry.describe("test.probe")).toEqual(registered);
    expect(registry.list().map((descriptor) => descriptor.type)).toEqual(["test.probe"]);
    expect(Object.isFrozen(registered)).toBe(true);
  });

  it("the process-wide singleton exposes the same protocol surface", () => {
    expect(typeof registerWorkflowNodeDescriptor).toBe("function");
    expect(typeof describeWorkflowNodeType).toBe("function");
    expect(listWorkflowNodeDescriptors()).toEqual(workflowNodeRegistry.list());
  });
});

// ---------------------------------------------------------------------------
// Registration-time rejection (fail-closed, registry unchanged)
// ---------------------------------------------------------------------------

describe("H16 registry — registration rejection", () => {
  it("rejects a descriptor with missing required fields", () => {
    const registry = createWorkflowNodeRegistry();
    for (const key of ["type", "kind", "serviceRef", "schemaVersion", "capabilityRequirements", "inputSchema", "outputSchema", "parameterSchema"] as const) {
      expectReject(omit(syntheticDescriptor(), key), "descriptor_schema_invalid", registry);
    }
    expect(registry.list()).toEqual([]);
  });

  it("rejects malformed registry ids and non-object payloads", () => {
    const registry = createWorkflowNodeRegistry();
    expectReject(syntheticDescriptor({ type: "nodot" }), "descriptor_schema_invalid", registry);
    expectReject(syntheticDescriptor({ type: "Upper.Case" }), "descriptor_schema_invalid", registry);
    expectReject(syntheticDescriptor({ type: "" }), "descriptor_schema_invalid", registry);
    expectReject(syntheticDescriptor({ kind: "llm-ghost" as never }), "descriptor_schema_invalid", registry);
    expectReject(null, "descriptor_schema_invalid", registry);
    expectReject("analyzer.deterministic-evidence", "descriptor_schema_invalid", registry);
    expect(registry.list()).toEqual([]);
  });

  it("rejects unsupported descriptor schemaVersions", () => {
    const registry = createWorkflowNodeRegistry();
    expectReject(syntheticDescriptor({ schemaVersion: WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION + 1 }), "descriptor_schema_version_unsupported", registry);
    expectReject(syntheticDescriptor({ schemaVersion: 0 }), "descriptor_schema_version_unsupported", registry);
    expect(registry.list()).toEqual([]);
  });

  it("rejects capability requirements that are not registered Kernel syscalls", () => {
    // Guard the guard: the probe capability must genuinely not exist.
    expect(isRegisteredSyscallAction("repo.delete")).toBe(false);
    const registry = createWorkflowNodeRegistry();
    expectReject(syntheticDescriptor({ capabilityRequirements: ["repo.delete"] }), "unknown_capability_requirement", registry);
    expectReject(
      syntheticDescriptor({ capabilityRequirements: ["evidence.read", "repo.delete"] }),
      "unknown_capability_requirement",
      registry,
    );
    expect(registry.list()).toEqual([]);
  });

  it("rejects duplicate registry ids and leaves the first registration intact", () => {
    const registry = createWorkflowNodeRegistry();
    const first = registry.register(syntheticDescriptor());
    expectReject(syntheticDescriptor(), "duplicate_node_type", registry);
    expectReject(
      syntheticDescriptor({ description: "different body, same registry id" }),
      "duplicate_node_type",
      registry,
    );
    expect(registry.list()).toEqual([first]);
    expect(registry.describe("test.probe")).toBe(first);
  });

  it("failed registration through the singleton never mutates builtin truth", () => {
    const before = listWorkflowNodeDescriptors();
    expectReject(syntheticDescriptor({ capabilityRequirements: ["repo.delete"] }), "unknown_capability_requirement");
    expectReject(omit(syntheticDescriptor(), "serviceRef"), "descriptor_schema_invalid");
    expectReject(syntheticDescriptor({ schemaVersion: WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION + 1 }), "descriptor_schema_version_unsupported");
    expect(listWorkflowNodeDescriptors()).toEqual(before);
    expect(before.map((descriptor) => descriptor.type)).toEqual([
      "analyzer.deterministic-evidence",
      "control.subflow",
      "tool.pinned-file-context",
      "verifier.model-structured",
      "verifier.persisted-evidence",
    ]);
  });
});

// ---------------------------------------------------------------------------
// List ordering — deterministic and stable
// ---------------------------------------------------------------------------

describe("H16 registry — list ordering", () => {
  it("lists registered descriptors sorted by registry id regardless of insertion order", () => {
    const registry = createWorkflowNodeRegistry();
    registry.register(syntheticDescriptor({ type: "zprobe.last", serviceRef: "zprobe.last.service" }));
    registry.register(syntheticDescriptor({ type: "aprobe.first", serviceRef: "aprobe.first.service" }));
    registry.register(syntheticDescriptor({ type: "mprobe.middle", serviceRef: "mprobe.middle.service" }));
    expect(registry.list().map((descriptor) => descriptor.type)).toEqual([
      "aprobe.first",
      "mprobe.middle",
      "zprobe.last",
    ]);
  });

  it("repeated list() calls return the identical order", () => {
    const registry = createWorkflowNodeRegistry();
    registry.register(syntheticDescriptor({ type: "zprobe.last", serviceRef: "zprobe.last.service" }));
    registry.register(syntheticDescriptor({ type: "aprobe.first", serviceRef: "aprobe.first.service" }));
    expect(registry.list()).toEqual(registry.list());
    expect(registry.list().map((descriptor) => descriptor.type)).toEqual(registry.list().map((descriptor) => descriptor.type));
  });

  it("the builtin singleton list is stable across calls (analyzer before verifier)", () => {
    const first = listWorkflowNodeDescriptors().map((descriptor) => descriptor.type);
    const second = listWorkflowNodeDescriptors().map((descriptor) => descriptor.type);
    expect(first).toEqual(second);
    expect(first).toContain("control.subflow");
    expect(first).toEqual(second);
  });
});
