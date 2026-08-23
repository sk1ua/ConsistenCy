/**
 * Workflow Runtime compiler: Definition → ExecutablePlan.
 *
 * The compiler MAY validate the schema and graph, resolve node types against
 * the runtime Node Registry, derive required coeffects and capability
 * requirements, and reject clearly unsatisfiable requirements.
 *
 * The compiler MUST NOT issue any durable authorization, cache an
 * authorization decision, or pass a raw capability handle anywhere. The
 * ExecutablePlan is a DESCRIPTION of intended execution, not a permission
 * token: a successful compile does not imply any future syscall is
 * authorized — every protected operation re-authorizes per-call through the
 * Kernel at runtime.
 */

import type {
  WorkflowRuntimeExecutablePlan,
  WorkflowRuntimeValidationIssue,
} from "@consistency/schema";
import {
  AVAILABLE_WORKFLOW_SERVICES,
  getWorkflowNodeService,
  isRegisteredSyscallAction,
} from "./registry";
import {
  topologicalNodeOrder,
  validateWorkflowRuntimeDefinitionInput,
} from "./validate";

export interface WorkflowCompilation {
  readonly ok: boolean;
  readonly errors: WorkflowRuntimeValidationIssue[];
  readonly plan?: WorkflowRuntimeExecutablePlan;
}

/**
 * Compile-time Capability Requirement / Feasibility Check. This answers:
 * "does the runtime have a registered service for every node, are all
 * declared capability requirements nameable Kernel syscalls, and are the
 * required coeffect services provided by this runtime?" It does NOT answer
 * "will any syscall be allowed" — that is exclusively per-call Kernel
 * authorization at execution time.
 */
export function compileWorkflowRuntimeDefinition(input: unknown): WorkflowCompilation {
  const validation = validateWorkflowRuntimeDefinitionInput(input);
  if (!validation.ok || !validation.definition) {
    return { ok: false, errors: validation.errors };
  }
  const definition = validation.definition;
  const errors: WorkflowRuntimeValidationIssue[] = [];

  for (const [index, node] of definition.nodes.entries()) {
    const service = getWorkflowNodeService(node.type);
    if (!service) {
      errors.push({
        code: "unknown_node_type",
        path: ["nodes", index, "type"],
        message: `Node type '${node.type}' is not registered in the runtime Node Registry`,
      });
      continue;
    }
    if (service.serviceRef !== node.serviceRef) {
      errors.push({
        code: "service_ref_mismatch",
        path: ["nodes", index, "serviceRef"],
        message: `serviceRef '${node.serviceRef}' does not match registered service '${service.serviceRef}' for type '${node.type}'`,
      });
      continue;
    }
    for (const action of service.capabilityRequirements) {
      if (!isRegisteredSyscallAction(action)) {
        errors.push({
          code: "capability_requirement_unsatisfiable",
          path: ["nodes", index, "type"],
          message: `Capability requirement '${action}' is not a registered Kernel syscall`,
        });
      }
    }
    for (const coeffect of service.coeffects) {
      if (!AVAILABLE_WORKFLOW_SERVICES.has(coeffect)) {
        errors.push({
          code: "coeffect_unavailable",
          path: ["nodes", index, "type"],
          message: `Required coeffect service '${coeffect}' is unavailable in this runtime`,
        });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const order = topologicalNodeOrder(definition);
  const plan: WorkflowRuntimeExecutablePlan = {
    definitionId: definition.id,
    definitionVersion: definition.version,
    agentSpecs: order.map((nodeId, index) => {
      const node = byId.get(nodeId)!;
      const service = getWorkflowNodeService(node.type)!;
      return {
        nodeId,
        serviceRef: service.serviceRef,
        order: index,
        coeffects: [...service.coeffects],
        capabilityRequirements: [...service.capabilityRequirements],
      };
    }),
  };
  return { ok: true, errors: [], plan };
}
