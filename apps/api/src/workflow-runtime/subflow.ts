/**
 * H19: restricted subflow expansion.
 *
 * A subflow is not a runtime script and not a live graph edit. At compile
 * time it is replaced by the nodes of one saved, validated revision. The
 * parent records that revision id, so a later child edit cannot silently
 * change a run. Cycles, depth, node count, and paid-step count fail closed.
 */
import { workflowRuntimePublicParameterSchema, type WorkflowRuntimeDefinition, type WorkflowRuntimeNode, type WorkflowRuntimeValidationIssue } from "@consistency/schema";
import { getWorkflowServiceByRef, validateWorkflowNodeParameters } from "./registry";
import { validateWorkflowRuntimeDefinitionInput } from "./validate";

export const SUBFLOW_LIMITS = { maxDepth: 3, maxNodes: 32, maxPaidSteps: 4 } as const;

export interface ResolvedSubflowRevision {
  readonly definition: WorkflowRuntimeDefinition;
  readonly revisionId: string;
}

export type SubflowResolver = (definitionId: string, revisionId?: string) => ResolvedSubflowRevision | undefined;

export interface SubflowExpansion {
  readonly ok: boolean;
  readonly errors: WorkflowRuntimeValidationIssue[];
  /** Source definition with every subflow revision pinned. */
  readonly definition?: WorkflowRuntimeDefinition;
  /** Definition after subflow nodes have been replaced. This is what executes. */
  readonly expanded?: WorkflowRuntimeDefinition;
}

export function expandSubflows(definition: WorkflowRuntimeDefinition, resolve?: SubflowResolver): SubflowExpansion {
  const errors: WorkflowRuntimeValidationIssue[] = [];
  const pinnedNodes = definition.nodes.map((node) => ({ ...node, parameters: { ...node.parameters } }));
  const expanded = expandLevel({
    nodes: pinnedNodes,
    edges: definition.edges.map((edge) => ({ ...edge })),
    depth: 1,
    stack: [definition.id],
    resolve,
    errors,
  });
  if (errors.length > 0 || !expanded) return { ok: false, errors };
  if (expanded.nodes.length > SUBFLOW_LIMITS.maxNodes) {
    errors.push({ code: "subflow_budget_exceeded", path: ["nodes"], message: `expanded workflow exceeds ${SUBFLOW_LIMITS.maxNodes} nodes` });
  }
  const paid = expanded.nodes.filter((node) => getWorkflowServiceByRef(node.serviceRef)?.kind === "llm-structured-verifier").length;
  if (paid > SUBFLOW_LIMITS.maxPaidSteps) {
    errors.push({ code: "subflow_budget_exceeded", path: ["nodes"], message: `expanded workflow exceeds ${SUBFLOW_LIMITS.maxPaidSteps} paid model steps` });
  }
  if (expanded.nodes.some((node) => node.type === "control.subflow")) {
    errors.push({ code: "subflow_unresolved", path: ["nodes"], message: "a subflow node survived expansion" });
  }
  if (errors.length > 0) return { ok: false, errors };
  const pinned = { ...definition, nodes: pinnedNodes };
  const seen = new Set<string>();
  const edges = expanded.edges.filter((edge) => {
    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key) || edge.from === edge.to) return false;
    seen.add(key);
    return true;
  });
  const expandedDefinition = { ...definition, id: definition.id, nodes: expanded.nodes, edges };
  const revalidated = validateWorkflowRuntimeDefinitionInput(expandedDefinition);
  if (!revalidated.ok) return { ok: false, errors: revalidated.errors };
  return { ok: true, errors: [], definition: pinned, expanded: revalidated.definition };
}

function expandLevel(input: {
  readonly nodes: WorkflowRuntimeNode[];
  readonly edges: WorkflowRuntimeDefinition["edges"];
  readonly depth: number;
  readonly stack: readonly string[];
  readonly resolve?: SubflowResolver;
  readonly errors: WorkflowRuntimeValidationIssue[];
}): { nodes: WorkflowRuntimeNode[]; edges: WorkflowRuntimeDefinition["edges"] } | undefined {
  const nodes: WorkflowRuntimeNode[] = [];
  const edges = [...input.edges];
  for (const [index, node] of input.nodes.entries()) {
    if (node.type !== "control.subflow") {
      nodes.push(node);
      continue;
    }
    if (node.serviceRef !== "control.subflow") {
      input.errors.push({ code: "service_ref_mismatch", path: ["nodes", index, "serviceRef"], message: "subflow serviceRef must be 'control.subflow'" });
      continue;
    }
    const parameterIssue = validateWorkflowNodeParameters(node.type, node.parameters);
    if (parameterIssue || node.when || node.retry || node.approval || !workflowRuntimePublicParameterSchema.safeParse(node.parameters).success) {
      input.errors.push({ code: "schema_invalid", path: ["nodes", index], message: parameterIssue ?? "subflow parameters must be public and control nodes cannot have when, retry, or approval" });
      continue;
    }
    const definitionId = node.parameters.definitionId as string;
    const requestedRevision = node.parameters.revisionId as string | undefined;
    if (input.stack.includes(definitionId)) {
      input.errors.push({ code: "subflow_cycle", path: ["nodes", index], message: `subflow cycle at '${definitionId}'` });
      continue;
    }
    if (input.depth > SUBFLOW_LIMITS.maxDepth) {
      input.errors.push({ code: "subflow_depth_exceeded", path: ["nodes", index], message: `subflow depth exceeds ${SUBFLOW_LIMITS.maxDepth}` });
      continue;
    }
    const resolved = input.resolve?.(definitionId, requestedRevision);
    if (!resolved || resolved.definition?.id !== definitionId || typeof resolved.revisionId !== "string" || !resolved.revisionId.trim() ||
      (requestedRevision !== undefined && resolved.revisionId !== requestedRevision)) {
      input.errors.push({ code: "subflow_unresolved", path: ["nodes", index, "parameters", "definitionId"], message: `subflow '${definitionId}' has no matching validated revision` });
      continue;
    }
    if (!workflowRuntimePublicParameterSchema.safeParse({ ...node.parameters, revisionId: resolved.revisionId }).success) {
      input.errors.push({ code: "schema_invalid", path: ["nodes", index, "parameters", "revisionId"], message: "subflow revisionId must be public" });
      continue;
    }
    // The resolver supplies a saved validated revision. Recheck its own schema
    // and graph before prefixing: an invalid child must not read parent nodes
    // or have dangling edges silently dropped during expansion.
    const validation = validateWorkflowRuntimeDefinitionInput(resolved.definition);
    if (!validation.ok) {
      input.errors.push(...validation.errors.map((issue) => ({ ...issue, path: ["nodes", index, ...issue.path] })));
      continue;
    }
    node.parameters.revisionId = resolved.revisionId;
    const child = expandLevel({
      nodes: validation.definition.nodes.map((childNode) => ({
        ...childNode,
        id: `${node.id}__${childNode.id}`,
        parameters: { ...childNode.parameters },
        ...(childNode.when === undefined ? {} : { when: { ...childNode.when, source: `${node.id}__${childNode.when.source}` } }),
      })),
      edges: validation.definition.edges.map((edge) => ({ from: `${node.id}__${edge.from}`, to: `${node.id}__${edge.to}` })),
      depth: input.depth + 1,
      stack: [...input.stack, definitionId],
      resolve: input.resolve,
      errors: input.errors,
    });
    if (!child || child.nodes.length === 0) continue;
    const internal = new Set(child.nodes.map((entry) => entry.id));
    const incoming = new Set(child.edges.map((edge) => edge.to));
    const outgoing = new Set(child.edges.map((edge) => edge.from));
    const roots = child.nodes.filter((entry) => !incoming.has(entry.id)).map((entry) => entry.id);
    const leaves = child.nodes.filter((entry) => !outgoing.has(entry.id)).map((entry) => entry.id);
    for (let edgeIndex = edges.length - 1; edgeIndex >= 0; edgeIndex -= 1) {
      const edge = edges[edgeIndex]!;
      if (edge.to !== node.id && edge.from !== node.id) continue;
      edges.splice(edgeIndex, 1);
      if (edge.to === node.id) {
        for (const root of roots) edges.push({ from: edge.from, to: root });
      }
      if (edge.from === node.id) {
        for (const leaf of leaves) edges.push({ from: leaf, to: edge.to });
      }
    }
    nodes.push(...child.nodes);
    edges.push(...child.edges.filter((edge) => internal.has(edge.from) && internal.has(edge.to)));
  }
  return input.errors.length > 0 ? undefined : { nodes, edges };
}
