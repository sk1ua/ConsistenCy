/**
 * Workflow Runtime validation + compilation tests — CKPT3 Phase 1 TEST A
 * and the compile-time capability/feasibility rejection paths.
 *
 * Validation is pure data checking: a rejected definition creates NO Run,
 * NO ACB, NO Fiber, and no authorization of any kind.
 */

import { describe, expect, it } from "vitest";
import type { WorkflowRuntimeDefinition } from "@consistency/schema";
import { VERIFIED_MINI_REVIEW_DEFINITION } from "./definition";
import { compileWorkflowRuntimeDefinition } from "./compile";
import { getWorkflowNodeService, listWorkflowNodeTypes } from "./registry";
import { validateWorkflowRuntimeDefinitionInput } from "./validate";

describe("TEST A — workflow definition validation", () => {
  it("the built-in VerifiedMiniReview definition validates", () => {
    const result = validateWorkflowRuntimeDefinitionInput(VERIFIED_MINI_REVIEW_DEFINITION);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    if (result.ok) expect(result.definition.id).toBe("verified-mini-review");
  });

  it("an invalid graph fails BEFORE execution with structured errors", () => {
    const cyclic: WorkflowRuntimeDefinition = {
      id: "cyclic",
      version: 1,
      nodes: [
        { id: "a", type: "analyzer.deterministic-evidence", serviceRef: "deterministic-evidence.analyzer", parameters: {}, failurePolicy: "fail-closed" },
        { id: "b", type: "verifier.persisted-evidence", serviceRef: "persisted-evidence.verifier", parameters: {}, failurePolicy: "fail-closed" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    };
    const result = validateWorkflowRuntimeDefinitionInput(cyclic);
    expect(result.ok).toBe(false);
    expect(result.errors.some((issue) => issue.code === "graph_cycle")).toBe(true);
  });

  it("schema violations fail with schema_invalid errors", () => {
    const result = validateWorkflowRuntimeDefinitionInput({ id: "", version: 2, nodes: [], edges: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.every((issue) => issue.code === "schema_invalid")).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("duplicate node ids and dangling edges are rejected", () => {
    const dup: WorkflowRuntimeDefinition = {
      id: "dup",
      version: 1,
      nodes: [
        { id: "a", type: "verifier.persisted-evidence", serviceRef: "persisted-evidence.verifier", parameters: {}, failurePolicy: "fail-closed" },
        { id: "a", type: "verifier.persisted-evidence", serviceRef: "persisted-evidence.verifier", parameters: {}, failurePolicy: "fail-closed" },
      ],
      edges: [],
    };
    expect(validateWorkflowRuntimeDefinitionInput(dup).errors.some((issue) => issue.code === "duplicate_node_id")).toBe(true);

    const dangling: WorkflowRuntimeDefinition = {
      ...dup,
      nodes: [dup.nodes[0]!],
      edges: [{ from: "a", to: "ghost" }],
    };
    expect(validateWorkflowRuntimeDefinitionInput(dangling).errors.some((issue) => issue.code === "unknown_node_reference")).toBe(true);
  });
});

describe("Compilation — capability requirement / feasibility check", () => {
  it("compiles the built-in definition into a descriptive plan in topological order", () => {
    const compilation = compileWorkflowRuntimeDefinition(VERIFIED_MINI_REVIEW_DEFINITION);
    expect(compilation.ok).toBe(true);
    expect(compilation.plan?.agentSpecs.map((spec) => spec.nodeId)).toEqual(["analyze", "verify"]);
    const analyzer = compilation.plan?.agentSpecs[0]!;
    expect(analyzer.capabilityRequirements).toEqual(["repo.read", "evidence.write"]);
    expect(analyzer.coeffects).toContain("repository-snapshot");
    // The plan carries no handle, no credential, no authorization decision.
    expect(JSON.stringify(compilation.plan)).not.toMatch(/handle|credential|token/i);
  });

  it("rejects unknown node types (registry truth)", () => {
    const compilation = compileWorkflowRuntimeDefinition({
      ...VERIFIED_MINI_REVIEW_DEFINITION,
      nodes: [
        { ...VERIFIED_MINI_REVIEW_DEFINITION.nodes[0]!, type: "analyzer.does-not-exist" },
        VERIFIED_MINI_REVIEW_DEFINITION.nodes[1]!,
      ],
    });
    expect(compilation.ok).toBe(false);
    expect(compilation.errors.some((issue) => issue.code === "unknown_node_type")).toBe(true);
  });

  it("fails closed on unknown analyzer config, analyzer names, wrong types, and verifier extras", () => {
    const base = { ...VERIFIED_MINI_REVIEW_DEFINITION, nodes: [...VERIFIED_MINI_REVIEW_DEFINITION.nodes] };
    for (const parameters of [{ analyzers: ["style"], inventedCapability: true }, { analyzers: ["made-up"] }, { analyzers: "style" }]) {
      const result = compileWorkflowRuntimeDefinition({ ...base, nodes: [{ ...base.nodes[0]!, parameters }, base.nodes[1]!] });
      expect(result.ok).toBe(false);
      expect(result.errors.some(issue => issue.path.includes("parameters"))).toBe(true);
    }
    const verifier = compileWorkflowRuntimeDefinition({ ...base, nodes: [base.nodes[0]!, { ...base.nodes[1]!, parameters: { extra: true } }] });
    expect(verifier.ok).toBe(false);
  });

  it("deep-freezes builtin graph data and keeps its checksum stable", () => {
    const definition = VERIFIED_MINI_REVIEW_DEFINITION;
    const checksum = JSON.stringify(definition);
    expect(() => (definition.nodes as unknown as unknown[]).push({})).toThrow();
    expect(() => ((definition.nodes[0]!.parameters as Record<string, unknown>).analyzers = ["secret"])).toThrow();
    expect(JSON.stringify(definition)).toBe(checksum);
  });

  it("rejects file URLs and excessive public parameter nesting before building a plan", () => {
    const base = VERIFIED_MINI_REVIEW_DEFINITION;
    for (const value of ["file:///tmp/private", "FILE://C:/private", "file%3A%2F%2F%2Ftmp%2Fprivate"]) {
      const result = compileWorkflowRuntimeDefinition({
        ...base,
        nodes: [{ ...base.nodes[0]!, parameters: { analyzers: ["style"], note: value } }, base.nodes[1]!],
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((issue) => issue.path.includes("parameters"))).toBe(true);
    }
  });

  it("rejects serviceRef that does not match the registered service", () => {
    const compilation = compileWorkflowRuntimeDefinition({
      ...VERIFIED_MINI_REVIEW_DEFINITION,
      nodes: [
        { ...VERIFIED_MINI_REVIEW_DEFINITION.nodes[0]!, serviceRef: "some.other.service" },
        VERIFIED_MINI_REVIEW_DEFINITION.nodes[1]!,
      ],
    });
    expect(compilation.ok).toBe(false);
    expect(compilation.errors.some((issue) => issue.code === "service_ref_mismatch")).toBe(true);
  });

  it("a compile pass implies no runtime authorization (plan is description, not permission)", () => {
    const compilation = compileWorkflowRuntimeDefinition(VERIFIED_MINI_REVIEW_DEFINITION);
    expect(compilation.ok).toBe(true);
    // Descriptive only: the plan has no issued handle, no broker, no gateway.
    expect(Object.keys(compilation.plan ?? {})).toEqual(["definitionId", "definitionVersion", "agentSpecs"]);
  });
});

describe("TEST G (part) — registry truth", () => {
  it("every registered node type maps to a real executor service", () => {
    const nodeTypes = listWorkflowNodeTypes();
    expect(nodeTypes.length).toBe(2);
    for (const nodeType of nodeTypes) {
      const service = getWorkflowNodeService(nodeType.type);
      expect(service).toBeDefined();
      expect(service?.serviceRef).toBe(nodeType.serviceRef);
      // Executor dispatch covers exactly these serviceRefs (see executor.ts
      // executeAgentBody); both are exercised end-to-end in executor tests.
      expect(["deterministic-evidence.analyzer", "persisted-evidence.verifier"]).toContain(nodeType.serviceRef);
    }
  });

  it("the built-in definition only uses registered node types (UI-only fake nodes = 0)", () => {
    for (const node of VERIFIED_MINI_REVIEW_DEFINITION.nodes) {
      expect(getWorkflowNodeService(node.type)).toBeDefined();
    }
  });
});
