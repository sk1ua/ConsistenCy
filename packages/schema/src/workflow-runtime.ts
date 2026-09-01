/**
 * Cordis-native Workflow Runtime contract (CKPT3 Phase 1 vertical slice).
 *
 * This is the shared contract for the Verified Workflow execution chain:
 *
 *   WorkflowDefinition → Validation → Compilation (Capability Requirement
 *   Check + ExecutablePlan) → Run → ACB → Scheduler admission → Cordis Fiber
 *   → ContextImage → capability-bound syscall → Evidence → Finding/MiniReport
 *
 * It is deliberately separate from `./workflow` (the Python-engine DAG spec
 * used by the legacy deterministic parity path): that spec describes steps
 * executed by the engine over stdio, while this contract describes agents the
 * Kernel/Harness runtime admits. The two must not be conflated; node types
 * here resolve against the runtime-owned Node Registry, never a frontend
 * constant list.
 *
 * Definitions and plans are DATA. Neither grants authorization: compile-time
 * capability checks are feasibility statements only, and every protected
 * operation still authorizes per-call through the Kernel.
 */

import { z } from "zod";
import { severitySchema } from "./review";

const nonEmpty = z.string().trim().min(1);

/** Same id alphabet as the engine workflow schema (JSON-pointer safe). */
export const workflowRuntimeNodeIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]*$/, "Node id must start with a letter and use only [a-z0-9_-]");

/** Definition ids use the same canonical engine-safe alphabet as node ids. */
export const workflowRuntimeDefinitionIdSchema = workflowRuntimeNodeIdSchema.max(128, "Definition id is too long");

export const workflowRuntimeFailurePolicySchema = z.literal("fail-closed");

export const workflowRuntimeNodeSchema = z.object({
  id: workflowRuntimeNodeIdSchema,
  /** Node type — MUST resolve to a runtime-registered service (registry truth). */
  type: nonEmpty,
  /** Registered service identity; must match the registry entry for `type`. */
  serviceRef: nonEmpty,
  /** Descriptive parameters consumed by the registered service. */
  parameters: z.record(z.unknown()).default({}),
  /** This slice fixes fail-closed for every node. */
  failurePolicy: workflowRuntimeFailurePolicySchema,
}).strict();

export const workflowRuntimeParameterFieldSchema = z.object({
  name: nonEmpty,
  label: nonEmpty,
  type: z.enum(["string", "number", "boolean", "enum", "string[]"]),
  required: z.boolean(),
  enumValues: z.array(nonEmpty).min(1).optional(),
  default: z.unknown().optional(),
}).strict().superRefine((field, ctx) => {
  if (field.type === "enum" && (!field.enumValues || field.enumValues.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "enum fields require enumValues" });
  }
  if (!["enum", "string[]"].includes(field.type) && field.enumValues !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "enumValues are only valid for enum and string[] fields" });
  }
  if (field.enumValues !== undefined) {
    if (field.enumValues.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "enumValues must be non-empty" });
    }
    if (new Set(field.enumValues).size !== field.enumValues.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "enumValues must be unique" });
    }
  }
  if (field.default !== undefined) {
    const valid = field.type === "string" ? typeof field.default === "string"
      : field.type === "number" ? typeof field.default === "number" && Number.isFinite(field.default)
      : field.type === "boolean" ? typeof field.default === "boolean"
      : field.type === "string[]" ? Array.isArray(field.default) && field.default.every(item => typeof item === "string") && new Set(field.default).size === field.default.length && (field.enumValues === undefined || field.default.every(item => field.enumValues!.includes(item)))
      : typeof field.default === "string" && field.enumValues?.includes(field.default);
    if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "default does not match field type, enumValues, or uniqueness contract" });
  }
});

export const workflowRuntimeParameterSchemaDescriptorSchema = z.object({
  fields: z.array(workflowRuntimeParameterFieldSchema),
}).strict().superRefine((descriptor, ctx) => {
  const names = new Set<string>();
  descriptor.fields.forEach((field, index) => {
    if (names.has(field.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields", index, "name"], message: "field names must be unique" });
    names.add(field.name);
  });
});

export const workflowRuntimeEdgeSchema = z.object({
  from: workflowRuntimeNodeIdSchema,
  to: workflowRuntimeNodeIdSchema,
}).strict();

export const workflowRuntimeDefinitionSchema = z.object({
  id: workflowRuntimeDefinitionIdSchema,
  version: z.literal(1),
  nodes: z.array(workflowRuntimeNodeSchema).min(1),
  edges: z.array(workflowRuntimeEdgeSchema).default([]),
  metadata: z.object({ purpose: z.string().trim().max(500).optional() }).strict().optional(),
}).strict();

export const workflowRuntimeValidationErrorCodeSchema = z.enum([
  "schema_invalid",
  "duplicate_node_id",
  "unknown_node_reference",
  "self_edge",
  "graph_cycle",
  "unknown_node_type",
  "service_ref_mismatch",
  "capability_requirement_unsatisfiable",
  "coeffect_unavailable",
]);

export const workflowRuntimeValidationIssueSchema = z.object({
  code: workflowRuntimeValidationErrorCodeSchema,
  path: z.array(z.union([z.string(), z.number()])).default([]),
  message: z.string(),
}).strict();

/**
 * One planned agent. Purely descriptive: no credential, no raw handle, no
 * authorization decision — `capabilityRequirements` names the actions the
 * runtime would have to issue for the agent, checked for FEASIBILITY only.
 */
/** Maximum nested container depth accepted in public parameter JSON. */
export const MAX_PUBLIC_PARAMETER_DEPTH = 12;
const PUBLIC_SENSITIVE_KEY = /(secret|token|password|passwd|credential|authorization|api[_-]?key|private[_-]?key|handle|path)/i;

function decodePublicParameterString(value: string): string {
  let decoded = value;
  // Decode a small, bounded number of layers so encoded schemes/paths cannot
  // evade the public boundary without making validation unbounded.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function isPublicParameterString(value: string): boolean {
  const decoded = decodePublicParameterString(value).trim();
  return !/^file:\/\//i.test(decoded)
    && !/^(?:[A-Za-z]:[\\/]|[\\/]|\\\\)/.test(decoded);
}

/** Iterative fail-closed walk; avoids recursive parser stack overflow. */
function isPublicParameterValue(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    const item = current.value;
    if (typeof item === "string") {
      if (!isPublicParameterString(item)) return false;
      continue;
    }
    if (item === null || typeof item === "number" || typeof item === "boolean") {
      if (typeof item === "number" && !Number.isFinite(item)) return false;
      continue;
    }
    if (typeof item !== "object" || current.depth > MAX_PUBLIC_PARAMETER_DEPTH) return false;
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(item)) return false;
    if (seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
    } else {
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        if (PUBLIC_SENSITIVE_KEY.test(key)) return false;
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

/** JSON data that is safe to expose in a descriptive executable plan. */
export const workflowRuntimePublicParameterValueSchema: z.ZodType<unknown> = z.custom<unknown>(
  isPublicParameterValue,
  { message: "value is not a public parameter (paths, secrets, handles, or excessive nesting)" },
);

export const workflowRuntimePublicParameterSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  if (!isPublicParameterValue(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "parameters contain non-public values (paths, secrets, handles, or excessive nesting)" });
  }
});

export const workflowRuntimeAgentSpecSchema = z.object({
  nodeId: workflowRuntimeNodeIdSchema,
  serviceRef: nonEmpty,
  /** Topological execution order (0 runs first). */
  order: z.number().int().nonnegative(),
  coeffects: z.array(nonEmpty).default([]),
  capabilityRequirements: z.array(nonEmpty).default([]),
  /** Validated, public-safe runtime service parameters copied from the definition node. */
  parameters: workflowRuntimePublicParameterSchema.default({}),
}).strict();

export const workflowRuntimeExecutablePlanSchema = z.object({
  definitionId: workflowRuntimeDefinitionIdSchema,
  definitionVersion: z.literal(1),
  agentSpecs: z.array(workflowRuntimeAgentSpecSchema).min(1),
}).strict();

/**
 * Public result for POST /workflow-runtime/validate. A successful compile
 * includes the descriptive executable plan returned by the canonical server;
 * it is data only and never an authorization grant.
 */
export const workflowRuntimeValidationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), errors: z.tuple([]), plan: workflowRuntimeExecutablePlanSchema }).strict(),
  z.object({ ok: z.literal(false), errors: z.array(workflowRuntimeValidationIssueSchema).min(1) }).strict(),
]);

/** Node Registry DTO — the runtime-owned truth about executable node types. */
export const workflowRuntimeNodeTypeSchema = z.object({
  type: nonEmpty,
  serviceRef: nonEmpty,
  role: z.enum(["analyzer", "verifier"]),
  description: z.string(),
  capabilityRequirements: z.array(nonEmpty),
  coeffects: z.array(nonEmpty),
  parameterSchema: workflowRuntimeParameterSchemaDescriptorSchema,
}).strict();

export const workflowRuntimeRunStatusSchema = z.enum(["running", "succeeded", "failed"]);

/** Public (sanitized) evidence view — fingerprints only, never raw payloads with secrets. */
export const workflowRuntimeEvidenceSummarySchema = z.object({
  id: nonEmpty,
  source: nonEmpty,
  ruleId: z.string().nullable(),
  path: nonEmpty,
  startLine: z.number().int().nullable(),
  endLine: z.number().int().nullable(),
  confidence: z.number(),
  fingerprint: nonEmpty,
  analyzer: nonEmpty,
  analyzerVersion: nonEmpty,
  /** Provenance truth: canonical repository identity + pinned SHA. */
  repository: nonEmpty,
  sha: nonEmpty,
}).strict();

export const workflowRuntimeFindingSchema = z.object({
  id: nonEmpty,
  nodeId: workflowRuntimeNodeIdSchema,
  file: nonEmpty,
  title: nonEmpty,
  severity: severitySchema.optional(),
  confidence: z.number().min(0).max(1),
  /** MUST be non-empty and resolve to persisted Evidence records. */
  evidenceIds: z.array(nonEmpty).min(1),
  verified: z.boolean(),
}).strict();

export const workflowRuntimeMiniReportStatusSchema = z.enum(["succeeded", "failed"]);

export const workflowRuntimeAgentSummarySchema = z.object({
  nodeId: workflowRuntimeNodeIdSchema,
  agentId: nonEmpty,
  state: nonEmpty,
  fiberApplied: z.number().int().nonnegative(),
}).strict();

export const workflowRuntimeMiniReportSchema = z.object({
  definitionId: nonEmpty,
  runId: nonEmpty,
  status: workflowRuntimeMiniReportStatusSchema,
  repository: nonEmpty,
  headSha: nonEmpty,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  evidenceCount: z.number().int().nonnegative(),
  verifiedEvidenceCount: z.number().int().nonnegative(),
  findings: z.array(workflowRuntimeFindingSchema).default([]),
  agents: z.array(workflowRuntimeAgentSummarySchema).default([]),
  audit: z.object({
    allowed: z.number().int().nonnegative(),
    denied: z.number().int().nonnegative(),
  }).strict(),
  error: nonEmpty.optional(),
}).strict();

export const workflowRuntimeRunSchema = z.object({
  runId: nonEmpty,
  definitionId: nonEmpty,
  status: workflowRuntimeRunStatusSchema,
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  /** Snapshot identity the run was pinned to (repository + SHA-fixed head). */
  snapshot: z.object({
    repository: nonEmpty,
    headSha: nonEmpty,
  }).strict(),
  evidence: z.array(workflowRuntimeEvidenceSummarySchema).default([]),
  miniReport: workflowRuntimeMiniReportSchema.optional(),
  error: nonEmpty.optional(),
}).strict();

/**
 * POST /workflow-runtime/runs body — binds execution to an EXISTING canonical
 * repository identity (opaque repository id resolved server-side). Inline
 * file-set input is deliberately not part of the public API: snapshots must
 * come from the canonical RepositorySnapshot path.
 */
export const workflowRuntimeTriggerRequestSchema = z.object({
  repositoryId: nonEmpty.max(200),
}).strict();

export type WorkflowRuntimeNode = z.infer<typeof workflowRuntimeNodeSchema>;
export type WorkflowRuntimeEdge = z.infer<typeof workflowRuntimeEdgeSchema>;
export type WorkflowRuntimeDefinition = z.infer<typeof workflowRuntimeDefinitionSchema>;
export type WorkflowRuntimeValidationErrorCode = z.infer<typeof workflowRuntimeValidationErrorCodeSchema>;
export type WorkflowRuntimeValidationIssue = z.infer<typeof workflowRuntimeValidationIssueSchema>;
export type WorkflowRuntimeValidationResult = z.infer<typeof workflowRuntimeValidationResultSchema>;
export type WorkflowRuntimeAgentSpec = z.infer<typeof workflowRuntimeAgentSpecSchema>;
export type WorkflowRuntimeExecutablePlan = z.infer<typeof workflowRuntimeExecutablePlanSchema>;
export type WorkflowRuntimeParameterField = z.infer<typeof workflowRuntimeParameterFieldSchema>;
export type WorkflowRuntimeParameterSchemaDescriptor = z.infer<typeof workflowRuntimeParameterSchemaDescriptorSchema>;
export type WorkflowRuntimeNodeType = z.infer<typeof workflowRuntimeNodeTypeSchema>;
export type WorkflowRuntimeRunStatus = z.infer<typeof workflowRuntimeRunStatusSchema>;
export type WorkflowRuntimeEvidenceSummary = z.infer<typeof workflowRuntimeEvidenceSummarySchema>;
export type WorkflowRuntimeFinding = z.infer<typeof workflowRuntimeFindingSchema>;
export type WorkflowRuntimeAgentSummary = z.infer<typeof workflowRuntimeAgentSummarySchema>;
export type WorkflowRuntimeMiniReport = z.infer<typeof workflowRuntimeMiniReportSchema>;
export type WorkflowRuntimeRun = z.infer<typeof workflowRuntimeRunSchema>;
export type WorkflowRuntimeTriggerRequest = z.infer<typeof workflowRuntimeTriggerRequestSchema>;

// ---------------------------------------------------------------------------
// Phase 2: persisted definition lifecycle, run history, dry-load feasibility
// ---------------------------------------------------------------------------

export const workflowRuntimeDefinitionStatusSchema = z.enum([
  /** Schema-parseable AND compiles (executable). */
  "validated",
  /** Schema-parseable but has validation/compile issues (NOT executable). */
  "draft_with_issues",
]);

/** A persisted, immutable definition revision (append-only). */
export const workflowRuntimeDefinitionRevisionSchema = z.object({
  revisionId: nonEmpty,
  definitionId: workflowRuntimeDefinitionIdSchema,
  /** 1-based monotonic revision number per definition. */
  revision: z.number().int().positive(),
  status: workflowRuntimeDefinitionStatusSchema,
  definition: workflowRuntimeDefinitionSchema,
  /** Structured issues captured at save time (empty when validated). */
  validationIssues: z.array(workflowRuntimeValidationIssueSchema).default([]),
  createdAt: z.string().datetime(),
}).strict();

/** List item — no definition body (bounded listing). */
export const workflowRuntimeDefinitionSummarySchema = z.object({
  definitionId: workflowRuntimeDefinitionIdSchema,
  /** builtin seed definitions are immutable and never editable via API. */
  origin: z.enum(["builtin", "user"]),
  latestRevision: z.number().int().positive().nullable(),
  /** Revision id of the latest revision (null when none persisted). */
  latestRevisionId: nonEmpty.nullable(),
  status: workflowRuntimeDefinitionStatusSchema.nullable(),
  createdAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
}).strict();

export const workflowRuntimeSaveDefinitionRequestSchema = z.object({
  /** Required for create; must match the body definition.id on update. */
  definitionId: workflowRuntimeDefinitionIdSchema.optional(),
  definition: workflowRuntimeDefinitionSchema,
}).strict().superRefine((request, ctx) => {
  if (request.definitionId !== undefined && request.definitionId !== request.definition.id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["definitionId"], message: "definitionId must match definition.id" });
  }
});

/** Dry-load per-node feasibility — REUSES compile output; never a judgment. */
export const workflowRuntimeNodeFeasibilitySchema = z.object({
  nodeId: workflowRuntimeNodeIdSchema,
  nodeType: nonEmpty,
  serviceRef: nonEmpty.nullable(),
  nodeTypeRegistered: z.boolean(),
  serviceRefMatches: z.boolean(),
  coeffects: z.array(z.object({
    name: nonEmpty,
    available: z.boolean(),
  })).default([]),
  capabilityRequirements: z.array(z.object({
    action: nonEmpty,
    satisfiable: z.boolean(),
  })).default([]),
  issues: z.array(workflowRuntimeValidationIssueSchema).default([]),
}).strict();

export const workflowRuntimeDryLoadResultSchema = z.object({
  definitionId: workflowRuntimeDefinitionIdSchema,
  revisionId: nonEmpty,
  /** feasible = every node resolves and every requirement is satisfiable. */
  overall: z.enum(["feasible", "not-feasible"]),
  nodes: z.array(workflowRuntimeNodeFeasibilitySchema).default([]),
  /**
   * Fixed truthfulness disclaimer — this is a COMPILE-TIME FEASIBILITY
   * statement. It is NOT an authorization and does not imply that any future
   * syscall will be authorized (per-syscall authorization stays in the
   * Kernel at execution time).
   */
  disclaimer: z.literal(
    "feasibility-check-only: a successful dry-load does not authorize any syscall; every protected operation is authorized per-call by the Kernel at execution time",
  ),
}).strict();

/** POST /workflow-runtime/runs body (Phase 2): revision-pinned trigger. */
export const workflowRuntimeTriggerRequestV2Schema = z.object({
  repositoryId: nonEmpty.max(200),
  definitionId: workflowRuntimeDefinitionIdSchema.optional(),
  /** Required with definitionId; omitted = the built-in seed definition. */
  revisionId: nonEmpty.optional(),
}).strict();

/**
 * How a run was created — pure observability provenance. A trigger source is
 * never an authorization: every protected operation is authorized per-call by
 * the Kernel regardless of how the run started.
 */
export const workflowRuntimeRunTriggerSchema = z.object({
  source: z.enum(["manual", "repository_change"]),
  /** Canonical repository event id for `repository_change` triggers. */
  eventId: nonEmpty.optional(),
}).strict();

export const workflowRuntimeRunSummarySchema = z.object({
  runId: nonEmpty,
  definitionId: nonEmpty,
  revisionId: nonEmpty,
  status: workflowRuntimeRunStatusSchema,
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  repository: nonEmpty,
  headSha: nonEmpty,
  findingCount: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
  error: nonEmpty.optional(),
  /** How the run was created — observability data, never authority. */
  trigger: workflowRuntimeRunTriggerSchema.optional(),
}).strict();

export const workflowRuntimeRunV2Schema = workflowRuntimeRunSchema.extend({
  revisionId: nonEmpty,
  origin: z.enum(["builtin", "user"]),
  trigger: workflowRuntimeRunTriggerSchema.optional(),
}).strict();

export const workflowRuntimeOverviewSchema = z.object({
  definition: workflowRuntimeDefinitionSchema,
  nodeTypes: z.array(workflowRuntimeNodeTypeSchema),
}).strict();

export const workflowRuntimeDefinitionsResponseSchema = z.object({ definitions: z.array(workflowRuntimeDefinitionSummarySchema) }).strict();
export const workflowRuntimeRevisionResponseSchema = z.object({ revision: workflowRuntimeDefinitionRevisionSchema }).strict();
export const workflowRuntimeDryLoadResponseSchema = workflowRuntimeDryLoadResultSchema;
export const workflowRuntimeTriggerResponseSchema = z.object({ runId: nonEmpty, status: nonEmpty, revisionId: nonEmpty }).strict();
export const workflowRuntimeRunsResponseSchema = z.object({ runs: z.array(workflowRuntimeRunSummarySchema) }).strict();
export const workflowRuntimeRunResponseSchema = workflowRuntimeRunV2Schema;

export type WorkflowRuntimeDefinitionRevision = z.infer<typeof workflowRuntimeDefinitionRevisionSchema>;
export type WorkflowRuntimeDefinitionSummary = z.infer<typeof workflowRuntimeDefinitionSummarySchema>;
export type WorkflowRuntimeSaveDefinitionRequest = z.infer<typeof workflowRuntimeSaveDefinitionRequestSchema>;
export type WorkflowRuntimeNodeFeasibility = z.infer<typeof workflowRuntimeNodeFeasibilitySchema>;
export type WorkflowRuntimeDryLoadResult = z.infer<typeof workflowRuntimeDryLoadResultSchema>;
export type WorkflowRuntimeTriggerRequestV2 = z.infer<typeof workflowRuntimeTriggerRequestV2Schema>;
export type WorkflowRuntimeRunSummary = z.infer<typeof workflowRuntimeRunSummarySchema>;
export type WorkflowRuntimeRunV2 = z.infer<typeof workflowRuntimeRunV2Schema>;

// ---------------------------------------------------------------------------
// Phase 3: repository workflow bindings + per-repository triggers/history
// ---------------------------------------------------------------------------

/**
 * How a binding may fire. `manual` (default) keeps CKPT3 behavior: only the
 * explicit binding-gated trigger route executes it. `on_change` additionally
 * lets persisted repository change events plan an automatic execution. The
 * mode is DATA/intent — it never widens Kernel authorization.
 */
export const workflowRuntimeBindingTriggerModeSchema = z.enum(["manual", "on_change"]);

/**
 * A binding is DATA (repository ↔ definition intent), never an
 * authorization: execution still resolves the latest validated revision and
 * authorizes every protected syscall per-call.
 */
export const workflowRuntimeBindingSchema = z.object({
  repositoryId: nonEmpty,
  definitionId: workflowRuntimeDefinitionIdSchema,
  enabled: z.boolean(),
  triggerMode: workflowRuntimeBindingTriggerModeSchema.default("manual"),
  /** Definition summary at read time; null when the definition was deleted. */
  definition: workflowRuntimeDefinitionSummarySchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const workflowRuntimeSetBindingRequestSchema = z.object({
  enabled: z.boolean(),
  triggerMode: workflowRuntimeBindingTriggerModeSchema.optional(),
}).strict();

/** POST /workflow-runtime/repositories/:id/runs — binding-gated manual trigger. */
export const workflowRuntimeRepositoryTriggerRequestSchema = z.object({
  definitionId: workflowRuntimeDefinitionIdSchema,
}).strict();

export type WorkflowRuntimeBinding = z.infer<typeof workflowRuntimeBindingSchema>;
export type WorkflowRuntimeSetBindingRequest = z.infer<typeof workflowRuntimeSetBindingRequestSchema>;
export type WorkflowRuntimeRepositoryTriggerRequest = z.infer<typeof workflowRuntimeRepositoryTriggerRequestSchema>;
export type WorkflowRuntimeBindingTriggerMode = z.infer<typeof workflowRuntimeBindingTriggerModeSchema>;
export type WorkflowRuntimeRunTrigger = z.infer<typeof workflowRuntimeRunTriggerSchema>;

// ---------------------------------------------------------------------------
// CKPT6 Phase 3: Workflow Copilot proposal (structured WorkflowPatch, §18.3)
// ---------------------------------------------------------------------------

/**
 * One proposed operation (§18.3 ADD_NODE / ADD_EDGE vocabulary). A proposal is
 * DATA only: it never mutates a definition, never creates a Run, and never
 * grants authorization. The only path to a persisted change is a human Apply
 * that translates the patch into Studio reducer actions and then walks the
 * existing validate → save-revision gate chain (§36: the Copilot can never
 * bypass the compiler).
 */
export const workflowRuntimeCopilotAddNodeOperationSchema = z.object({
  op: z.literal("ADD_NODE"),
  nodeId: workflowRuntimeNodeIdSchema,
  /**
   * MUST be a serviceRef from the runtime Node Registry. The API verifies the
   * value against the server-owned registry (`listWorkflowNodeTypes()`);
   * client-supplied registries are never trusted.
   */
  serviceRef: nonEmpty,
  /** Descriptive label suggestion only — the definition schema has no name field. */
  name: z.string().trim().min(1).max(120).optional(),
  /** Proposed node parameters; validated against the registry descriptor server-side. */
  parameters: z.record(z.unknown()).optional(),
}).strict();

/**
 * ADD_EDGE deliberately carries NO `condition` field: the current
 * `workflowRuntimeEdgeSchema` supports `{ from, to }` only, and this contract
 * must not invent capability the graph schema cannot represent. Conditions can
 * be added when the edge schema grows them (documented in docs/workflow-runtime.md).
 */
export const workflowRuntimeCopilotAddEdgeOperationSchema = z.object({
  op: z.literal("ADD_EDGE"),
  /** Both endpoints MUST exist once the proposal is applied (server-verified). */
  from: workflowRuntimeNodeIdSchema,
  to: workflowRuntimeNodeIdSchema,
}).strict();

export const workflowRuntimeCopilotPatchOperationSchema = z.discriminatedUnion("op", [
  workflowRuntimeCopilotAddNodeOperationSchema,
  workflowRuntimeCopilotAddEdgeOperationSchema,
  // Conversational Copilot (full reducer vocabulary). Removals and parameter
  // edits are validated server-side in patch order before any compile.
  z.object({
    op: z.literal("REMOVE_NODE"),
    nodeId: workflowRuntimeNodeIdSchema,
  }).strict(),
  z.object({
    op: z.literal("REMOVE_EDGE"),
    from: workflowRuntimeNodeIdSchema,
    to: workflowRuntimeNodeIdSchema,
  }).strict(),
  z.object({
    op: z.literal("UPDATE_PARAMS"),
    nodeId: workflowRuntimeNodeIdSchema,
    parameters: z.record(z.unknown()),
  }).strict(),
]);

export const workflowRuntimeCopilotProposalSchema = z.object({
  /** Bounded operation list, applied strictly in order. */
  patch: z.array(workflowRuntimeCopilotPatchOperationSchema).min(1).max(32),
  rationale: z.string().trim().min(1).max(2000),
  /** Provenance: which definition the proposal was computed against. */
  basis: z.object({
    definitionFingerprint: nonEmpty.optional(),
  }).strict().optional(),
}).strict();

export const workflowRuntimeCopilotProposalResponseSchema = z.object({
  proposal: workflowRuntimeCopilotProposalSchema,
}).strict();

export const workflowRuntimeCopilotProposalRequestSchema = z.object({
  instruction: z.string().trim().min(1).max(2000),
  /** Inline definition to patch — XOR `definitionId`. */
  definition: workflowRuntimeDefinitionSchema.optional(),
  /** Persisted definition whose latest revision should be patched — XOR `definition`. */
  definitionId: workflowRuntimeDefinitionIdSchema.optional(),
}).strict().superRefine((request, ctx) => {
  if ((request.definition === undefined) === (request.definitionId === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [request.definition === undefined ? "definition" : "definitionId"],
      message: "exactly one of definition or definitionId is required",
    });
  }
});

/**
 * Conversational Copilot (one chat turn). The client owns the conversation:
 * it sends the bounded message history plus the definition the assistant
 * should see; the server stays stateless and persists nothing.
 */
export const workflowRuntimeCopilotChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(4000),
}).strict();

export const workflowRuntimeCopilotChatRequestSchema = z.object({
  /** Bounded conversation history; the LAST message must be the user's turn. */
  messages: z.array(workflowRuntimeCopilotChatMessageSchema).min(1).max(24),
  /** Inline definition to reason about — XOR `definitionId`. */
  definition: workflowRuntimeDefinitionSchema.optional(),
  /** Persisted definition whose latest revision is the context — XOR `definition`. */
  definitionId: workflowRuntimeDefinitionIdSchema.optional(),
}).strict().superRefine((request, ctx) => {
  if ((request.definition === undefined) === (request.definitionId === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [request.definition === undefined ? "definition" : "definitionId"],
      message: "exactly one of definition or definitionId is required",
    });
  }
  if (request.messages[request.messages.length - 1]?.role !== "user") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["messages"],
      message: "the last message must have role 'user'",
    });
  }
});

/**
 * One conversational assistant turn: a natural-language reply plus an
 * OPTIONAL patch. An empty patch means the assistant answered a question or
 * asked for clarification — no graph change is proposed. Patches are DATA:
 * applying one still goes through the Studio reducer and the canonical
 * validate → save-revision gate chain (the compiler is never bypassed).
 */
export const workflowRuntimeCopilotChatResponseSchema = z.object({
  reply: z.string().trim().min(1).max(4000),
  patch: z.array(workflowRuntimeCopilotPatchOperationSchema).max(32),
  basis: z.object({
    definitionFingerprint: nonEmpty,
  }).strict(),
}).strict();

export type WorkflowRuntimeCopilotChatMessage = z.infer<typeof workflowRuntimeCopilotChatMessageSchema>;
export type WorkflowRuntimeCopilotChatRequest = z.infer<typeof workflowRuntimeCopilotChatRequestSchema>;
export type WorkflowRuntimeCopilotChatResponse = z.infer<typeof workflowRuntimeCopilotChatResponseSchema>;

export type WorkflowRuntimeCopilotAddNodeOperation = z.infer<typeof workflowRuntimeCopilotAddNodeOperationSchema>;
export type WorkflowRuntimeCopilotAddEdgeOperation = z.infer<typeof workflowRuntimeCopilotAddEdgeOperationSchema>;
export type WorkflowRuntimeCopilotPatchOperation = z.infer<typeof workflowRuntimeCopilotPatchOperationSchema>;
export type WorkflowRuntimeCopilotProposal = z.infer<typeof workflowRuntimeCopilotProposalSchema>;
export type WorkflowRuntimeCopilotProposalResponse = z.infer<typeof workflowRuntimeCopilotProposalResponseSchema>;
export type WorkflowRuntimeCopilotProposalRequest = z.infer<typeof workflowRuntimeCopilotProposalRequestSchema>;
