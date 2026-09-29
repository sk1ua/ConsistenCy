import { describe, expect, it } from "vitest";
import type { WorkflowRuntimeDefinition } from "@consistency/schema";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { compileWorkflowRuntimeDefinition } from "./compile";
import { WorkflowRuntimeHost } from "./host";
import type { ResolvedSubflowRevision } from "./subflow";
import { WorkflowRuntimeStore } from "./store";

function node(id: string, type = "verifier.persisted-evidence", serviceRef = "persisted-evidence.verifier"): WorkflowRuntimeDefinition["nodes"][number] {
  return { id, type, serviceRef, parameters: {}, failurePolicy: "fail-closed" };
}

function childDefinition(id: string): WorkflowRuntimeDefinition {
  return { id, version: 1, nodes: [node("verify")], edges: [] };
}

function subflowNode(id: string, definitionId: string, revisionId?: string): WorkflowRuntimeDefinition["nodes"][number] {
  return {
    id, type: "control.subflow", serviceRef: "control.subflow",
    parameters: { definitionId, ...(revisionId === undefined ? {} : { revisionId }) },
    failurePolicy: "fail-closed",
  };
}

describe("H19 restricted subflow expansion", () => {
  const revisions = new Map<string, ResolvedSubflowRevision>([
    ["child", { definition: childDefinition("child"), revisionId: "rev-child" }],
  ]);
  const resolve = (definitionId: string, revisionId?: string) => {
    const found = revisions.get(definitionId);
    if (!found || (revisionId !== undefined && found.revisionId !== revisionId)) return undefined;
    return found;
  };

  it("expands a saved revision into the parent plan and pins that revision", () => {
    const parent: WorkflowRuntimeDefinition = {
      id: "parent", version: 1,
      nodes: [
        node("analyze", "analyzer.deterministic-evidence", "deterministic-evidence.analyzer"),
        { id: "include", type: "control.subflow", serviceRef: "control.subflow", parameters: { definitionId: "child" }, failurePolicy: "fail-closed" },
      ],
      edges: [{ from: "analyze", to: "include" }],
    };
    const compiled = compileWorkflowRuntimeDefinition(parent, resolve);
    expect(compiled.ok).toBe(true);
    expect(compiled.plan?.agentSpecs.map((spec) => spec.nodeId)).toEqual(["analyze", "include__verify"]);
    expect(compiled.definition?.nodes.find((entry) => entry.id === "include")?.parameters.revisionId).toBe("rev-child");
    expect(compiled.plan?.agentSpecs.some((spec) => spec.serviceRef === "control.subflow")).toBe(false);
  });

  it("namespaces nested conditions and preserves parent-child dependencies at both boundaries", () => {
    const grandchild: WorkflowRuntimeDefinition = {
      id: "grandchild", version: 1,
      nodes: [node("first"), { ...node("conditional"), when: { source: "first", path: ["ok"], equals: true } }],
      edges: [{ from: "first", to: "conditional" }],
    };
    const child: WorkflowRuntimeDefinition = {
      id: "nested-child", version: 1,
      nodes: [node("start"), subflowNode("nested", "grandchild", "rev-grandchild"), { ...node("finish"), when: { source: "start", path: ["ok"], equals: true } }],
      edges: [{ from: "start", to: "nested" }, { from: "nested", to: "finish" }],
    };
    const parent: WorkflowRuntimeDefinition = {
      id: "parent", version: 1,
      nodes: [node("before"), subflowNode("include", "nested-child", "rev-nested-child"), node("after")],
      edges: [{ from: "before", to: "include" }, { from: "include", to: "after" }],
    };
    const nestedResolve = (id: string, revisionId?: string) => {
      const revisions: Record<string, ResolvedSubflowRevision> = {
        grandchild: { definition: grandchild, revisionId: "rev-grandchild" },
        "nested-child": { definition: child, revisionId: "rev-nested-child" },
      };
      const found = revisions[id];
      return found && (revisionId === undefined || revisionId === found.revisionId) ? found : undefined;
    };
    const compiled = compileWorkflowRuntimeDefinition(parent, nestedResolve);
    expect(compiled.ok).toBe(true);
    expect(compiled.definition?.nodes[1]?.parameters.revisionId).toBe("rev-nested-child");
    expect(compiled.plan?.agentSpecs.map(({ nodeId, dependsOn, when }) => ({ nodeId, dependsOn, source: when?.source }))).toEqual([
      { nodeId: "before", dependsOn: [], source: undefined },
      { nodeId: "include__start", dependsOn: ["before"], source: undefined },
      { nodeId: "include__nested__first", dependsOn: ["include__start"], source: undefined },
      { nodeId: "include__nested__conditional", dependsOn: ["include__nested__first"], source: "include__nested__first" },
      { nodeId: "include__finish", dependsOn: ["include__nested__conditional"], source: "include__start" },
      { nodeId: "after", dependsOn: ["include__finish"], source: undefined },
    ]);
  });

  it("rejects a resolver returning the wrong definition or pinned revision", () => {
    const parent: WorkflowRuntimeDefinition = {
      id: "parent", version: 1, nodes: [subflowNode("include", "child", "rev-original")], edges: [],
    };
    const wrongDefinition = compileWorkflowRuntimeDefinition(parent, () => ({ definition: childDefinition("another-child"), revisionId: "rev-original" }));
    expect(wrongDefinition.ok).toBe(false);
    expect(wrongDefinition.errors.some(({ code }) => code === "subflow_unresolved")).toBe(true);
    const wrongRevision = compileWorkflowRuntimeDefinition(parent, () => ({ definition: childDefinition("child"), revisionId: "rev-new" }));
    expect(wrongRevision.ok).toBe(false);
    expect(wrongRevision.errors.some(({ code }) => code === "subflow_unresolved")).toBe(true);
  });

  it("rejects malformed child-local graph rules rather than dropping dangling edges or reading parent nodes", () => {
    const parent: WorkflowRuntimeDefinition = {
      id: "parent", version: 1,
      nodes: [node("before"), subflowNode("include", "child"), node("after")],
      edges: [{ from: "before", to: "include" }, { from: "include", to: "after" }],
    };
    const dangling = { ...childDefinition("child"), edges: [{ from: "verify", to: "after" }] };
    const invalidEdge = compileWorkflowRuntimeDefinition(parent, () => ({ definition: dangling, revisionId: "rev-child" }));
    expect(invalidEdge.ok).toBe(false);
    expect(invalidEdge.errors.some(({ code }) => code === "unknown_node_reference")).toBe(true);
    const crossBoundary = { ...childDefinition("child"), nodes: [{ ...node("verify"), when: { source: "before", path: ["ok"], equals: true } }] };
    const invalidCondition = compileWorkflowRuntimeDefinition(parent, () => ({ definition: crossBoundary, revisionId: "rev-child" }));
    expect(invalidCondition.ok).toBe(false);
    expect(invalidCondition.errors.some(({ code }) => code === "condition_unknown_source")).toBe(true);
  });

  it("fails closed instead of discarding control-node parameters or conditions during expansion", () => {
    const parent: WorkflowRuntimeDefinition = {
      id: "parent", version: 1,
      nodes: [node("before"), { ...subflowNode("include", "child"), parameters: { definitionId: "child", script: "not executable" }, when: { source: "before", path: ["ok"], equals: true } }],
      edges: [{ from: "before", to: "include" }],
    };
    const invalid = compileWorkflowRuntimeDefinition(parent, resolve);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.some(({ code }) => code === "schema_invalid")).toBe(true);
    expect(compileWorkflowRuntimeDefinition({ ...parent, nodes: [parent.nodes[0]!, { ...subflowNode("include", "child"), when: { source: "before", path: ["ok"], equals: true } }] }, resolve).ok).toBe(false);
    expect(compileWorkflowRuntimeDefinition({ ...parent, nodes: [parent.nodes[0]!, { ...subflowNode("include", "child"), approval: { ttlSeconds: 60 } }] }, resolve).ok).toBe(false);
    expect(compileWorkflowRuntimeDefinition({ ...parent, nodes: [parent.nodes[0]!, { ...subflowNode("include", "child"), retry: { maxAttempts: 2 } }] }, resolve).ok).toBe(false);
  });

  it("rejects wrong control service or non-public revision before the control node disappears", () => {
    const wrongService: WorkflowRuntimeDefinition = {
      id: "parent", version: 1,
      nodes: [{ ...subflowNode("include", "child"), serviceRef: "persisted-evidence.verifier" }], edges: [],
    };
    const mismatched = compileWorkflowRuntimeDefinition(wrongService, resolve);
    expect(mismatched.ok).toBe(false);
    expect(mismatched.errors.some(({ code }) => code === "service_ref_mismatch")).toBe(true);
    const unsafeRevision: WorkflowRuntimeDefinition = {
      ...wrongService, nodes: [subflowNode("include", "child", "C:\\private\\revision")],
    };
    const unsafe = compileWorkflowRuntimeDefinition(unsafeRevision, () => ({ definition: childDefinition("child"), revisionId: "C:\\private\\revision" }));
    expect(unsafe.ok).toBe(false);
    expect(unsafe.errors.some(({ code }) => code === "schema_invalid")).toBe(true);
    const unsafeResolved = compileWorkflowRuntimeDefinition({
      ...unsafeRevision, nodes: [subflowNode("include", "child")],
    }, () => ({ definition: childDefinition("child"), revisionId: "C:\\private\\revision" }));
    expect(unsafeResolved.ok).toBe(false);
    expect(unsafeResolved.errors.some(({ code }) => code === "schema_invalid")).toBe(true);
  });

  it("fails closed for a missing revision, a cycle, and excess depth", () => {
    const missing: WorkflowRuntimeDefinition = {
      id: "parent", version: 1,
      nodes: [{ id: "include", type: "control.subflow", serviceRef: "control.subflow", parameters: { definitionId: "absent" }, failurePolicy: "fail-closed" }],
      edges: [],
    };
    expect(compileWorkflowRuntimeDefinition(missing, resolve).errors.some((issue) => issue.code === "subflow_unresolved")).toBe(true);

    revisions.set("loop", { definition: {
      id: "loop", version: 1,
      nodes: [{ id: "again", type: "control.subflow", serviceRef: "control.subflow", parameters: { definitionId: "loop" }, failurePolicy: "fail-closed" }],
      edges: [],
    }, revisionId: "rev-loop" });
    const cyclic: WorkflowRuntimeDefinition = {
      id: "parent", version: 1,
      nodes: [{ id: "include", type: "control.subflow", serviceRef: "control.subflow", parameters: { definitionId: "loop" }, failurePolicy: "fail-closed" }],
      edges: [],
    };
    expect(compileWorkflowRuntimeDefinition(cyclic, resolve).errors.some((issue) => issue.code === "subflow_cycle")).toBe(true);

    for (let depth = 1; depth <= 4; depth += 1) {
      const id = `d${depth}`;
      const nested = depth === 4 ? [node("leaf")] : [{ id: "down", type: "control.subflow" as const, serviceRef: "control.subflow", parameters: { definitionId: `d${depth + 1}` }, failurePolicy: "fail-closed" as const }];
      revisions.set(id, { definition: { id, version: 1, nodes: nested, edges: [] }, revisionId: `rev-${id}` });
    }
    const deep: WorkflowRuntimeDefinition = {
      id: "parent", version: 1,
      nodes: [{ id: "include", type: "control.subflow", serviceRef: "control.subflow", parameters: { definitionId: "d1" }, failurePolicy: "fail-closed" }],
      edges: [],
    };
    expect(compileWorkflowRuntimeDefinition(deep, resolve).errors.some((issue) => issue.code === "subflow_depth_exceeded")).toBe(true);
  });

  it("pins validated child and grandchild revisions across later edits", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new WorkflowRuntimeStore(database);
      const host = new WorkflowRuntimeHost({ store });
      host.initialize();
      const grandchild = host.saveDefinition({ definition: childDefinition("grandchild") });
      const child = host.saveDefinition({ definition: {
        id: "child", version: 1,
        nodes: [node("start"), subflowNode("nested", "grandchild")],
        edges: [{ from: "start", to: "nested" }],
      } });
      const parent = host.saveDefinition({ definition: {
        id: "parent", version: 1, nodes: [subflowNode("include", "child")], edges: [],
      } });
      expect([grandchild.status, child.status, parent.status]).toEqual(["validated", "validated", "validated"]);
      expect(child.definition.nodes[1]?.parameters.revisionId).toBe(grandchild.revisionId);
      expect(parent.definition.nodes[0]?.parameters.revisionId).toBe(child.revisionId);
      host.saveDefinition({ definitionId: "grandchild", definition: { ...childDefinition("grandchild"), nodes: [node("changed-grandchild")] } });
      host.saveDefinition({ definitionId: "child", definition: { id: "child", version: 1, nodes: [node("changed-child")], edges: [] } });
      const compiled = compileWorkflowRuntimeDefinition(store.getRevision(parent.revisionId)?.definition, (definitionId, revisionId) => {
        const revision = revisionId ? store.getRevision(revisionId) : store.getLatestValidatedRevision(definitionId);
        return revision?.definitionId === definitionId && revision.status === "validated"
          ? { definition: revision.definition, revisionId: revision.revisionId } : undefined;
      });
      expect(compiled.ok).toBe(true);
      expect(compiled.plan?.agentSpecs.map(({ nodeId, dependsOn }) => ({ nodeId, dependsOn }))).toEqual([
        { nodeId: "include__start", dependsOn: [] },
        { nodeId: "include__nested__verify", dependsOn: ["include__start"] },
      ]);
    } finally {
      database.close();
    }
  });

  it("pins the saved child revision so a later child edit cannot change the parent plan", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const store = new WorkflowRuntimeStore(database);
    const host = new WorkflowRuntimeHost({ store, eventStore: undefined, checkpointStore: undefined });
    host.initialize();
    const savedChild = host.saveDefinition({ definition: childDefinition("child-def") });
    const parent = host.saveDefinition({ definition: {
      id: "parent-def", version: 1,
      nodes: [{ id: "include", type: "control.subflow", serviceRef: "control.subflow", parameters: { definitionId: "child-def" }, failurePolicy: "fail-closed" }],
      edges: [],
    } });
    expect(parent.definition.nodes[0]?.parameters.revisionId).toBe(savedChild.revisionId);
    host.saveDefinition({ definitionId: "child-def", definition: {
      ...childDefinition("child-def"),
      nodes: [node("other")],
    } });
    const stored = store.getRevision(parent.revisionId);
    const compiled = compileWorkflowRuntimeDefinition(stored?.definition, (definitionId, revisionId) => {
      const revision = revisionId ? store.getRevision(revisionId) : undefined;
      return revision && revision.definitionId === definitionId ? { definition: revision.definition, revisionId: revision.revisionId } : undefined;
    });
    expect(compiled.ok).toBe(true);
    expect(compiled.plan?.agentSpecs.map((spec) => spec.nodeId)).toEqual(["include__verify"]);
  });
});
