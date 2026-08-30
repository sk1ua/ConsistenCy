/**
 * Workflow Runtime structural validation (schema + graph).
 *
 * Pure function over data: validating a definition NEVER creates a Run, an
 * ACB, a Fiber, or any authorization. Graph checks mirror the engine
 * workflow schema's discipline (unique ids, resolvable references, no
 * self-edges, acyclic) but operate on the edges[] shape of this contract.
 */

import {
  workflowRuntimeDefinitionSchema,
  type WorkflowRuntimeDefinition,
  type WorkflowRuntimeValidationIssue,
} from "@consistency/schema";

type DefinitionValidation =
  | { readonly ok: true; readonly errors: []; readonly definition: WorkflowRuntimeDefinition }
  | { readonly ok: false; readonly errors: WorkflowRuntimeValidationIssue[] };

export function validateWorkflowRuntimeDefinitionInput(input: unknown): DefinitionValidation {
  const parsed = workflowRuntimeDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue): WorkflowRuntimeValidationIssue => ({
        code: "schema_invalid",
        path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
        message: issue.message,
      })),
    };
  }
  const definition = parsed.data;
  const errors = collectGraphIssues(definition);
  return errors.length === 0 ? { ok: true, errors: [], definition } : { ok: false, errors };
}

export function collectGraphIssues(
  definition: WorkflowRuntimeDefinition,
): WorkflowRuntimeValidationIssue[] {
  const issues: WorkflowRuntimeValidationIssue[] = [];
  const known = new Set<string>();

  definition.nodes.forEach((node, index) => {
    if (known.has(node.id)) {
      issues.push({
        code: "duplicate_node_id",
        path: ["nodes", index, "id"],
        message: `Duplicate node id '${node.id}'`,
      });
    }
    known.add(node.id);
  });

  definition.edges.forEach((edge, index) => {
    if (edge.from === edge.to) {
      issues.push({
        code: "self_edge",
        path: ["edges", index],
        message: `Edge '${edge.from}' → '${edge.to}' is a self edge`,
      });
    }
    for (const [key, endpoint] of [["from", edge.from], ["to", edge.to]] as const) {
      if (!known.has(endpoint)) {
        issues.push({
          code: "unknown_node_reference",
          path: ["edges", index, key],
          message: `Edge ${key} references unknown node '${endpoint}'`,
        });
      }
    }
  });

  // The edge set is only unambiguous once ids resolve — same discipline as
  // the engine workflow schema.
  if (issues.length > 0) return issues;

  const indegree = new Map<string, number>(definition.nodes.map((node) => [node.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const edge of definition.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    dependents.set(edge.from, [...(dependents.get(edge.from) ?? []), edge.to]);
  }

  const queue = definition.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  let resolved = 0;
  for (;;) {
    const current = queue.shift();
    if (current === undefined) break;
    resolved += 1;
    for (const dependent of dependents.get(current) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }

  if (resolved < definition.nodes.length) {
    const cyclic = definition.nodes
      .filter((node) => (indegree.get(node.id) ?? 0) > 0)
      .map((node) => node.id);
    issues.push({
      code: "graph_cycle",
      path: ["edges"],
      message: `Workflow graph contains a cycle involving: ${cyclic.join(", ")}`,
    });
  }

  return issues;
}

/** Deterministic topological order (stable for equal-depth nodes by id). */
export function topologicalNodeOrder(definition: WorkflowRuntimeDefinition): string[] {
  const indegree = new Map<string, number>(definition.nodes.map((node) => [node.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const edge of definition.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    dependents.set(edge.from, [...(dependents.get(edge.from) ?? []), edge.to]);
  }
  const ready = definition.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id)
    .sort();
  const order: string[] = [];
  for (;;) {
    const current = ready.shift();
    if (current === undefined) break;
    order.push(current);
    for (const dependent of (dependents.get(current) ?? []).sort()) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
    ready.sort();
  }
  return order;
}
