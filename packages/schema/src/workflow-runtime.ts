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
import { severitySchema, tokenUsageSchema } from "./review";
import { executionLifecycleStateSchema, terminalReasonSchema } from "./runtime";

const nonEmpty = z.string().trim().min(1);

/** Same id alphabet as the engine workflow schema (JSON-pointer safe). */
export const workflowRuntimeNodeIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]*$/, "Node id must start with a letter and use only [a-z0-9_-]");

/** Definition ids use the same canonical engine-safe alphabet as node ids. */
export const workflowRuntimeDefinitionIdSchema = workflowRuntimeNodeIdSchema.max(128, "Definition id is too long");

export const workflowRuntimeFailurePolicySchema = z.literal("fail-closed");

/**
 * H18 structured condition. Reads one public field of an upstream node's
 * output. A missing field is an explicit execution failure, never a silent skip.
 */
export const workflowRuntimeConditionSchema = z.object({
  source: workflowRuntimeNodeIdSchema,
  path: z.array(nonEmpty).min(1).max(8),
  equals: z.union([z.string(), z.number(), z.boolean()]),
}).strict();
export type WorkflowRuntimeCondition = z.infer<typeof workflowRuntimeConditionSchema>;

/** Bounded retry. The bound is part of the definition, not a runtime guess. */
export const workflowRuntimeRetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(3),
}).strict();

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
  /** When false, the node is skipped and produces no side effect. */
  when: workflowRuntimeConditionSchema.optional(),
  retry: workflowRuntimeRetrySchema.optional(),
  /** Human wait. Absent means the node does not wait for a decision. */
  approval: z.object({ ttlSeconds: z.number().int().min(1).max(86_400) }).strict().optional(),
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
  "duplicate_edge",
  "condition_unknown_source",
  "condition_not_upstream",
  "subflow_unresolved",
  "subflow_cycle",
  "subflow_depth_exceeded",
  "subflow_budget_exceeded",
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
  /**
   * H18: node ids this agent must wait for (compiled from the definition
   * edges). Dependency-READY dispatch starts an agent only once every entry
   * has SETTLED, so a bounded-concurrency run still reads facts its inputs
   * already produced.
   *
   * Deliberately `.optional()` rather than `.default([])`: a plan produced
   * before H18 (or by an out-of-repo producer) has no dependency metadata at
   * all, and absence MEANS "no dependencies" — the same thing an empty array
   * means. Optional keeps every existing plan fixture and producer
   * type-compatible (`dependsOn: string[] | undefined`), while the compiler
   * always emits the array explicitly for new plans.
   */
  dependsOn: z.array(workflowRuntimeNodeIdSchema).optional(),
  coeffects: z.array(nonEmpty).default([]),
  capabilityRequirements: z.array(nonEmpty).default([]),
  /** Validated, public-safe runtime service parameters copied from the definition node. */
  parameters: workflowRuntimePublicParameterSchema.default({}),
  /** H18: copied from the definition node. Absent means always run. */
  when: workflowRuntimeConditionSchema.optional(),
  retry: workflowRuntimeRetrySchema.optional(),
  approval: z.object({ ttlSeconds: z.number().int().min(1).max(86_400) }).strict().optional(),
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
  /** H17: role grew additively with the new node kinds (tool / model-verifier). */
  role: z.enum(["analyzer", "verifier", "tool", "model-verifier", "control"]),
  description: z.string(),
  capabilityRequirements: z.array(nonEmpty),
  coeffects: z.array(nonEmpty),
  parameterSchema: workflowRuntimeParameterSchemaDescriptorSchema,
}).strict();

export const workflowRuntimeRunStatusSchema = z.enum(["running", "succeeded", "failed"]);

// ---------------------------------------------------------------------------
// H17: explicit analysis selection, quota, batching, and coverage disclosure.
//
// The host used to slice the snapshot's analyzable files SILENTLY (sorted,
// first 10). That silently dropped files from analysis. The selection is now
// an explicit, quota-bounded plan and every run DISCLOSES its coverage: what
// was selected, what was omitted (listed, never silently dropped), and how
// the selected files were batched for deterministic analysis.
// ---------------------------------------------------------------------------

/** Upper bound for the explicit per-run omitted-path disclosure list. */
export const WORKFLOW_COVERAGE_MAX_DISCLOSED_PATHS = 200;

export const workflowRuntimeRunCoverageSchema = z.object({
  /** Every analyzable (language-supported) file at the pinned snapshot. */
  totalAnalyzable: z.number().int().nonnegative(),
  /** Explicit quota applied to this run. */
  quota: z.number().int().positive(),
  /** Files selected for analysis (≤ quota; sorted, deterministic). */
  selectedCount: z.number().int().nonnegative(),
  selectedPaths: z.array(nonEmpty),
  /** Files EXPLICITLY not covered — always disclosed, never silently dropped. */
  omittedCount: z.number().int().nonnegative(),
  omittedPaths: z.array(nonEmpty).max(WORKFLOW_COVERAGE_MAX_DISCLOSED_PATHS),
  /** True when omittedPaths was truncated at the disclosure bound. */
  omittedTruncated: z.boolean(),
  /** Deterministic batch plan the analyzer will run (size ≥ 1). */
  batchSize: z.number().int().positive(),
  batchCount: z.number().int().nonnegative(),
}).strict();
export type WorkflowRuntimeRunCoverage = z.infer<typeof workflowRuntimeRunCoverageSchema>;

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

/**
 * Mini-report status. `degraded` (H17) is an HONEST terminal quality marker:
 * the run completed and every reported finding is evidence-grounded, but part
 * of the planned verification (e.g. the structured model check) did not
 * fulfill its contract — the reason is carried in `error`. Degraded never
 * counts as a verification receipt.
 */
export const workflowRuntimeMiniReportStatusSchema = z.enum(["succeeded", "failed", "degraded"]);

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
  /** Unified execution lifecycle & provenance metadata (backward-compatible optional fields). */
  correlationId: nonEmpty.optional(),
  lifecycleState: executionLifecycleStateSchema.optional(),
  terminalReason: terminalReasonSchema.optional(),
  startedAt: z.string().datetime().optional(),
  /** H17: explicit selection/quota/batch coverage disclosure for this run. */
  coverage: workflowRuntimeRunCoverageSchema.optional(),
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
  /** Unified execution lifecycle & provenance metadata (backward-compatible optional fields). */
  correlationId: nonEmpty.optional(),
  lifecycleState: executionLifecycleStateSchema.optional(),
  terminalReason: terminalReasonSchema.optional(),
  startedAt: z.string().datetime().optional(),
  /** H17: coverage disclosure (counts only on summaries; full lists on the run DTO). */
  coverage: workflowRuntimeRunCoverageSchema.optional(),
}).strict();

export const workflowRuntimeRunV2Schema = workflowRuntimeRunSchema.extend({
  revisionId: nonEmpty,
  origin: z.enum(["builtin", "user"]),
  trigger: workflowRuntimeRunTriggerSchema.optional(),
  /** Present only while this run has one undecided human gate. */
  awaitingApprovalStepId: nonEmpty.optional(),
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
  /** Audit P2-04: Copilot used to discard provider usage; optional so older clients keep parsing. */
  tokenUsage: tokenUsageSchema.optional(),
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
  /** Audit P2-04: Copilot used to discard provider usage; optional so older clients keep parsing. */
  tokenUsage: tokenUsageSchema.optional(),
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

// ---------------------------------------------------------------------------
// H16: versioned node descriptor contract (node registration protocol)
// ---------------------------------------------------------------------------
//
// Registration contract for the runtime-owned Node Registry. A descriptor is
// DATA that fully describes one executable node type: what it is (kind),
// which executor service backs it (serviceRef), which Kernel syscalls it
// needs (capabilityRequirements), which named data contracts it reads and
// writes (input/output schema references), and which version of THIS
// descriptor contract it was written against (schemaVersion).
//
// Scope note: H16 delivers the contract + registry only. The executor keeps
// its current per-serviceRef dispatch until H17 moves it to descriptor-driven
// dispatch, after which registering a new node type here is enough to execute
// it without touching the executor.

/**
 * Descriptor contract version carried by every descriptor. Bump ONLY for a
 * breaking shape change of the descriptor itself; adding new kinds, node
 * types, or capability names is additive and does not bump it.
 */
export const WORKFLOW_NODE_DESCRIPTOR_SCHEMA_VERSION = 1;

/**
 * Executor-dispatchable node kind — the semantic category an executor
 * dispatches on (H17 replaces per-serviceRef hardcoding with this key). The
 * registry `type` stays the definition-facing identity; several registry
 * types may share one kind. Extending this union with new kinds (LLM, tool,
 * conditional nodes) is additive and does not bump the descriptor version.
 *
 * H17 adds two kinds:
 *   - `llm-structured-verifier`: reads PERSISTED Evidence (evidence.read) and
 *     re-checks it with ONE structured model invocation through the unified
 *     LLM entry (llm.invoke capability + Kernel facade — never a node-local
 *     provider). Model output is strictly schema-validated; bad JSON or a
 *     failed invocation yields an explainable degraded outcome, never a
 *     fabricated verification.
 *   - `readonly-tool`: reads the pinned snapshot through repo.read ONLY and
 *     produces a bounded, structured read-only artifact. No writes, no
 *     network, no side effects.
 */
export const workflowNodeKindSchema = z.enum([
  "deterministic-analyzer",
  "persisted-evidence-verifier",
  "llm-structured-verifier",
  "readonly-tool",
  /** Compile-time only. A saved plan never contains this kind. */
  "subflow",
]);

/**
 * Structured verdict ONE model verification may attach to a piece of
 * persisted evidence, keyed by that record's DETERMINISTIC fingerprint
 * (fingerprints are restart-stable; evidence row ids are not — H14 reuse
 * therefore keys model verdicts on fingerprints, never on ids).
 */
export const workflowModelVerificationVerdictSchema = z.enum(["confirmed", "refuted", "uncertain"]);

/** Strict output contract for the model verification node (H17). */
export const workflowModelVerificationSchema = z.object({
  findings: z.array(z.object({
    /** Deterministic fingerprint of the judged evidence record. */
    evidenceFingerprint: nonEmpty,
    verdict: workflowModelVerificationVerdictSchema,
    /** Explainable, bounded rationale for the verdict. */
    note: z.string().trim().min(1).max(2000),
  }).strict()),
  summary: z.string().trim().min(1).max(4000),
}).strict();
export type WorkflowModelVerification = z.infer<typeof workflowModelVerificationSchema>;

/**
 * Reference to a named, versioned data contract a node reads or writes.
 * A reference is a stable NAME plus major version (e.g.
 * "workflow-runtime.finding" for `workflowRuntimeFindingSchema` in this
 * module, or "kernel.evidence-input" / "kernel.evidence-snapshot" for the
 * kernel evidence records) — it never carries a payload and never grants
 * authority.
 */
export const workflowNodeIOSchemaRefSchema = z.object({
  /** Stable contract name (dotted, lowercase). */
  name: nonEmpty.max(200),
  /** Major version of the referenced contract. */
  version: z.number().int(),
}).strict();

/**
 * One versioned node descriptor — the complete registration payload for a
 * node type in the runtime Node Registry. Registration validates: required
 * fields (strict schema), supported `schemaVersion`, that every capability
 * requirement names a registered Kernel syscall, and registry-id uniqueness.
 */
export const workflowRuntimeNodeDescriptorSchema = z.object({
  schemaVersion: z.number().int(),
  /** Registry identity; workflow definition nodes reference it as `type`. */
  type: z.string().trim().regex(
    /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/,
    "Node type must be dotted lowercase (e.g. 'analyzer.deterministic-evidence')",
  ).max(128, "Node type is too long"),
  kind: workflowNodeKindSchema,
  /** Registered service identity; must match the executor service. */
  serviceRef: nonEmpty,
  description: z.string(),
  /** Kernel syscall actions the executor must issue for this node's agent. */
  capabilityRequirements: z.array(nonEmpty),
  /** Harness services that must be available for the node to activate. */
  coeffects: z.array(nonEmpty),
  /** UI-facing parameter descriptor; runtime parameter rules stay registry-side. */
  parameterSchema: workflowRuntimeParameterSchemaDescriptorSchema,
  /** Named data contract this node reads its primary input from. */
  inputSchema: workflowNodeIOSchemaRefSchema,
  /** Named data contract this node writes its primary output to. */
  outputSchema: workflowNodeIOSchemaRefSchema,
}).strict();

export type WorkflowNodeKind = z.infer<typeof workflowNodeKindSchema>;
export type WorkflowNodeIOSchemaRef = z.infer<typeof workflowNodeIOSchemaRefSchema>;
export type WorkflowRuntimeNodeDescriptor = z.infer<typeof workflowRuntimeNodeDescriptorSchema>;

// ---------------------------------------------------------------------------
// H12: run event timeline — server-authoritative event read/resume contract.
//
// The server (WorkflowRuntimeEventStore, H11) owns the append-only ledger;
// clients receive ordered seq pages, dedupe by eventId, and can fully rebuild
// the timeline from raw events (reconnect ⇒ resume from the seq cursor, never
// a lossy inference from a dropped socket). The projection below is a PURE
// function shared by the API (snapshot endpoint) and the Web client (rebuild).
// ---------------------------------------------------------------------------

/** Wire DTO for one persisted workflow-runtime execution event. */
export const workflowRuntimeRunEventSchema = z.object({
  eventId: nonEmpty,
  /** Per-run monotonic cursor (UNIQUE(run_id, seq)); resume keys on this. */
  seq: z.number().int().positive(),
  eventType: nonEmpty,
  correlationId: nonEmpty,
  runId: nonEmpty,
  stepId: nonEmpty.optional(),
  attemptNumber: z.number().int().positive().optional(),
  fromState: executionLifecycleStateSchema.optional(),
  toState: executionLifecycleStateSchema,
  terminalReason: terminalReasonSchema.optional(),
  timestamp: z.string().datetime(),
  error: z.string().optional(),
  payload: z.record(z.unknown()),
}).strict();
export type WorkflowRuntimeRunEvent = z.infer<typeof workflowRuntimeRunEventSchema>;

/** Authoritative run state attached to every events page / projection. */
export const workflowRuntimeRunEventStateSchema = z.object({
  runId: nonEmpty,
  status: workflowRuntimeRunStatusSchema,
  /** Shared lifecycle vocabulary (H10) — e.g. awaiting_input vs running. */
  lifecycleState: executionLifecycleStateSchema.optional(),
  terminalReason: terminalReasonSchema.optional(),
  finishedAt: z.string().datetime().optional(),
}).strict();
export type WorkflowRuntimeRunEventState = z.infer<typeof workflowRuntimeRunEventStateSchema>;

/**
 * GET /workflow-runtime/runs/:id/events — one seq page. `after` returns only
 * events with seq > after; `nextSeq` is the cursor to pass back; `terminal`
 * means the run itself reached a terminal status server-side (the ONLY source
 * of "the run is over" — a closed SSE socket never implies it).
 */
export const workflowRuntimeRunEventsPageSchema = z.object({
  run: workflowRuntimeRunEventStateSchema,
  events: z.array(workflowRuntimeRunEventSchema),
  nextSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  total: z.number().int().nonnegative(),
  terminal: z.boolean(),
}).strict();
export type WorkflowRuntimeRunEventsPage = z.infer<typeof workflowRuntimeRunEventsPageSchema>;

/** One projected step row of the run timeline. */
export const workflowRuntimeRunStepTimelineSchema = z.object({
  stepId: nonEmpty,
  serviceRef: nonEmpty.optional(),
  agentId: nonEmpty.optional(),
  /** Actual model the step invoked, when the step's payload records one. */
  model: nonEmpty.optional(),
  attemptNumber: z.number().int().positive(),
  /** A step still open under an awaiting_input run shows awaiting_input (H10). */
  state: z.enum(["running", "awaiting_input", "succeeded", "failed"]),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
  /** Evidence record ids to link from the step row. */
  evidenceIds: z.array(nonEmpty),
}).strict();
export type WorkflowRuntimeRunStepTimeline = z.infer<typeof workflowRuntimeRunStepTimelineSchema>;

/**
 * The run timeline projection. Anomaly markers (seq gaps, duplicate eventIds,
 * unknown event types) are surfaced EXPLICITLY — a projection that silently
 * hides them would lie about what the run did.
 */
export const workflowRuntimeRunTimelineSchema = z.object({
  run: workflowRuntimeRunEventStateSchema,
  /** H10 awaiting_input: the run is paused for human input, not executing. */
  awaitingInput: z.boolean(),
  terminal: z.boolean(),
  steps: z.array(workflowRuntimeRunStepTimelineSchema),
  seqGaps: z.array(z.number().int().positive()),
  duplicateEventIds: z.array(nonEmpty),
  unknownEventTypes: z.array(nonEmpty),
}).strict();
export type WorkflowRuntimeRunTimeline = z.infer<typeof workflowRuntimeRunTimelineSchema>;

/** Event types the projection knows how to fold into the timeline. */
export const WORKFLOW_RUNTIME_TIMELINE_EVENT_TYPES: readonly string[] = Object.freeze([
  "run_started",
  "run_succeeded",
  "run_failed",
  "step_started",
  "step_succeeded",
  "step_failed",
]);

/**
 * Pure event→timeline projection (H12).
 *
 * Contract:
 *   - dedupes by eventId (a replayed frame never double-counts; the FIRST seq
 *     wins and later repeats are reported in `duplicateEventIds`);
 *   - orders by seq ascending and marks every missing seq in `seqGaps`
 *     (a gap means the ledger is incomplete — the client must be able to see
 *     it and refetch from 0 to rebuild);
 *   - folds step_started/succeeded/failed into per-step rows with duration
 *     (finishedAt − startedAt of the events' timestamps), error, serviceRef,
 *     agentId, model (when the step payload records one) and evidence ids;
 *   - a step without a terminal step event stays `running` — or shows the
 *     run-level H10 `awaiting_input` when the run's lifecycle state says so;
 *   - unknown event types still count for seq continuity (forward
 *     compatibility) and are listed in `unknownEventTypes`.
 */
export function projectWorkflowRunTimeline(
  run: WorkflowRuntimeRunEventState,
  events: ReadonlyArray<WorkflowRuntimeRunEvent>,
): WorkflowRuntimeRunTimeline {
  // Out-of-order input is normalized FIRST (seq ascending), so the dedupe
  // below keeps the LOWEST-seq occurrence of a repeated eventId — the
  // canonical ledger position — and reports the later replays.
  const bySeq = [...events].sort((a, b) => a.seq - b.seq);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const ordered: WorkflowRuntimeRunEvent[] = [];
  for (const event of bySeq) {
    if (seen.has(event.eventId)) {
      duplicates.add(event.eventId);
      continue;
    }
    seen.add(event.eventId);
    ordered.push(event);
  }

  const gaps: number[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const expected = ordered[index]!.seq;
    if (index > 0 && expected !== ordered[index - 1]!.seq + 1) {
      // Mark the missing seqs inside the gap, bounded by what the page saw.
      for (let missing = ordered[index - 1]!.seq + 1; missing < expected; missing += 1) {
        gaps.push(missing);
      }
    }
  }

  const unknownTypes = new Set<string>();
  for (const event of ordered) {
    if (!WORKFLOW_RUNTIME_TIMELINE_EVENT_TYPES.includes(event.eventType)) {
      unknownTypes.add(event.eventType);
    }
  }

  const steps = new Map<string, WorkflowRuntimeRunStepTimeline>();
  const stepOrder: string[] = [];
  let runTerminal = run.status === "succeeded" || run.status === "failed";
  const awaitingInput = run.lifecycleState === "awaiting_input";

  for (const event of ordered) {
    if (!event.stepId) {
      if (event.eventType === "run_succeeded" || event.eventType === "run_failed") {
        runTerminal = true;
      }
      continue;
    }
    let timeline = steps.get(event.stepId);
    if (!timeline) {
      stepOrder.push(event.stepId);
      timeline = {
        stepId: event.stepId,
        ...(typeof event.payload.serviceRef === "string" && event.payload.serviceRef !== ""
          ? { serviceRef: event.payload.serviceRef }
          : {}),
        ...(typeof event.payload.agentId === "string" && event.payload.agentId !== ""
          ? { agentId: event.payload.agentId }
          : {}),
        ...(typeof event.payload.model === "string" && event.payload.model !== ""
          ? { model: event.payload.model }
          : {}),
        attemptNumber: event.attemptNumber ?? 1,
        state: "running",
        ...(event.timestamp !== undefined ? { startedAt: event.timestamp } : {}),
        evidenceIds: [],
      };
      // A step may be observed first through a non-started event (e.g. the
      // started event was lost); its row still appears — honestly incomplete.
      if (event.eventType !== "step_started" && event.timestamp) {
        timeline.startedAt = undefined;
      }
      steps.set(event.stepId, timeline);
    }
    if (event.payload.evidenceIds !== undefined && Array.isArray(event.payload.evidenceIds)) {
      for (const id of event.payload.evidenceIds) {
        if (typeof id === "string" && id !== "" && !timeline.evidenceIds.includes(id)) {
          timeline.evidenceIds.push(id);
        }
      }
    }
    if (event.eventType === "step_started") {
      timeline.startedAt = event.timestamp;
      timeline.state = "running";
    } else if (event.eventType === "step_succeeded") {
      timeline.finishedAt = event.timestamp;
      timeline.state = "succeeded";
    } else if (event.eventType === "step_failed") {
      timeline.finishedAt = event.timestamp;
      timeline.state = "failed";
      if (event.error !== undefined) timeline.error = event.error;
    }
  }

  const rows: WorkflowRuntimeRunStepTimeline[] = stepOrder.map((stepId) => {
    const timeline = steps.get(stepId)!;
    const state = timeline.state === "running" && awaitingInput ? "awaiting_input" : timeline.state;
    const rawDurationMs =
      timeline.startedAt !== undefined && timeline.finishedAt !== undefined
        ? Date.parse(timeline.finishedAt) - Date.parse(timeline.startedAt)
        : Number.NaN;
    const durationMs = Number.isFinite(rawDurationMs) ? Math.max(0, rawDurationMs) : undefined;
    return {
      ...timeline,
      state,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  });

  return {
    run,
    awaitingInput,
    terminal: runTerminal,
    steps: rows,
    seqGaps: gaps,
    duplicateEventIds: [...duplicates].sort(),
    unknownEventTypes: [...unknownTypes].sort(),
  };
}

/**
 * Client-side incremental merge (H12): fold one page of events into what the
 * client already holds. Dedupe is by eventId; frames whose every seq is at or
 * below the cursor are duplicates of history and dropped (counted); a frame
 * opening a gap beyond cursor+1 is accepted AND flagged so the caller can
 * decide to rebuild from a full refetch. Pure — no network, no mutation.
 */
export function mergeWorkflowRunEvents(
  existing: ReadonlyArray<WorkflowRuntimeRunEvent>,
  cursor: number,
  incoming: ReadonlyArray<WorkflowRuntimeRunEvent>,
): { events: WorkflowRuntimeRunEvent[]; nextCursor: number; duplicates: number; gapAfter: number | undefined } {
  const byEventId = new Map<string, WorkflowRuntimeRunEvent>();
  for (const event of existing) byEventId.set(event.eventId, event);
  let nextCursor = cursor;
  let duplicates = 0;
  let gapAfter: number | undefined;
  for (const event of incoming) {
    if (event.seq <= cursor || byEventId.has(event.eventId)) {
      duplicates += 1;
      continue;
    }
    if (nextCursor > 0 && event.seq > nextCursor + 1 && gapAfter === undefined) {
      gapAfter = nextCursor;
    }
    byEventId.set(event.eventId, event);
    if (event.seq > nextCursor) nextCursor = event.seq;
  }
  const events = [...byEventId.values()].sort((a, b) => a.seq - b.seq);
  return { events, nextCursor, duplicates, gapAfter };
}

// ---------------------------------------------------------------------------
// H14: checkpoint / restart-recovery contract.
//
// A run that was executing when the API process died is recovered at startup
// scan: it is honestly marked FAILED (success is never fabricated) and its
// durable facts — the H11 execution-event ledger plus per-step checkpoint
// results — are exposed as an explicit recovery plan with four actions:
//
//   continue      resume the interrupted run as a SUCCESSOR run, reusing the
//                 completed READ-ONLY step results (a completed model call is
//                 never billed twice). Re-validates: definition revision +
//                 checksum, repository binding, snapshot readability, and
//                 that the repository HEAD is UNCHANGED — historical inputs
//                 are never silently re-based onto new history.
//   retry         re-run a sent-but-unresulted step. FRAMEWORK ONLY in this
//                 ticket: steps with unknown side effects stay blocked.
//   rerun         launch a fresh run of the same definition (no reuse).
//   readonly_view inspect the checkpoint and ledger facts without executing.
//
// A step whose tool call was sent but whose result never arrived is
// outcome_unknown: it is NEVER reused and NEVER blindly replayed.
// ---------------------------------------------------------------------------

/** Per-step outcome folded from the durable H11 ledger + checkpoint facts. */
export const workflowRuntimeStepOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  /** Tool call was dispatched but no result was persisted — never replay. */
  "outcome_unknown",
]);
export type WorkflowRuntimeStepOutcome = z.infer<typeof workflowRuntimeStepOutcomeSchema>;

export const workflowRuntimeRecoveryActionSchema = z.enum(["continue", "retry", "rerun", "readonly_view"]);
export type WorkflowRuntimeRecoveryAction = z.infer<typeof workflowRuntimeRecoveryActionSchema>;

/** One folded step fact of an interrupted run (ledger + checkpoint merged). */
export const workflowRuntimeRecoveryStepSchema = z.object({
  stepId: nonEmpty,
  serviceRef: nonEmpty.optional(),
  nodeKind: workflowNodeKindSchema.optional(),
  outcome: workflowRuntimeStepOutcomeSchema,
  /** H11 ledger seq of the step's terminal (or last observed) event. */
  eventSeq: z.number().int().positive().optional(),
  /** Durable evidence fingerprint references of the completed step. */
  evidenceFingerprints: z.array(nonEmpty).default([]),
  /** True when a reusable checkpoint result exists for this step. */
  reusable: z.boolean(),
  /** True when the reusable checkpoint row was unreadable (corrupt JSON). */
  corrupt: z.boolean().default(false),
}).strict();
export type WorkflowRuntimeRecoveryStep = z.infer<typeof workflowRuntimeRecoveryStepSchema>;

/** Structured, explainable reason an action is blocked. */
export const workflowRuntimeRecoveryBlockerSchema = z.object({
  code: z.enum([
    "run_not_interrupted",
    "no_checkpoint",
    "checkpoint_corrupt",
    "step_outcome_unknown",
    "step_failed",
    "step_without_reusable_result",
    "non_readonly_step_present",
    "definition_revision_missing",
    "definition_checksum_changed",
    "repository_binding_unknown",
    "repository_binding_unavailable",
    "head_changed",
    "snapshot_unavailable",
    "analysis_selection_changed",
    "plan_revision_recovery_unsupported",
    "model_not_configured",
  ]),
  message: nonEmpty,
  stepId: nonEmpty.optional(),
}).strict();
export type WorkflowRuntimeRecoveryBlocker = z.infer<typeof workflowRuntimeRecoveryBlockerSchema>;

export const workflowRuntimeRecoveryActionAvailabilitySchema = z.object({
  action: workflowRuntimeRecoveryActionSchema,
  available: z.boolean(),
  /** Why the action is (un)available, or what executing it will do. */
  reason: nonEmpty.optional(),
  blockers: z.array(workflowRuntimeRecoveryBlockerSchema).default([]),
}).strict();
export type WorkflowRuntimeRecoveryActionAvailability = z.infer<typeof workflowRuntimeRecoveryActionAvailabilitySchema>;

/**
 * GET /workflow-runtime/runs/:id/recovery — the explicit, honest recovery
 * plan. Pure read: computing it never executes anything.
 */
export const workflowRuntimeRecoveryPlanSchema = z.object({
  runId: nonEmpty,
  definitionId: nonEmpty,
  revisionId: nonEmpty,
  status: workflowRuntimeRunStatusSchema,
  /** The run was interrupted by an API restart (startup-scan marker). */
  interrupted: z.boolean(),
  repository: nonEmpty,
  headSha: nonEmpty,
  steps: z.array(workflowRuntimeRecoveryStepSchema),
  actions: z.array(workflowRuntimeRecoveryActionAvailabilitySchema),
  blockers: z.array(workflowRuntimeRecoveryBlockerSchema),
  /** Set on the SUCCESSOR run created by `continue`. */
  resumedFromRunId: nonEmpty.optional(),
}).strict();
export type WorkflowRuntimeRecoveryPlan = z.infer<typeof workflowRuntimeRecoveryPlanSchema>;

/** H19: narrow runtime revision of an undispatched, approval-paused tail. */
export const workflowRuntimePlanRevisionRequestSchema = z.object({
  stepId: workflowRuntimeNodeIdSchema.max(128),
  nodeId: workflowRuntimeNodeIdSchema.max(128),
  expectedRevision: z.number().int().min(0).max(3),
}).strict();
export type WorkflowRuntimePlanRevisionRequest = z.infer<typeof workflowRuntimePlanRevisionRequestSchema>;

export const workflowRuntimePlanRevisionResponseSchema = z.object({
  runId: nonEmpty,
  revision: z.number().int().min(0).max(4),
  plan: workflowRuntimeExecutablePlanSchema,
}).strict();
export type WorkflowRuntimePlanRevisionResponse = z.infer<typeof workflowRuntimePlanRevisionResponseSchema>;

/** POST /workflow-runtime/runs/:id/approval body. */
export const workflowRuntimeApprovalDecisionRequestSchema = z.object({
  stepId: nonEmpty,
  decision: z.enum(["approved", "rejected"]),
}).strict();
export type WorkflowRuntimeApprovalDecisionRequest = z.infer<typeof workflowRuntimeApprovalDecisionRequestSchema>;

export const workflowRuntimeApprovalDecisionResponseSchema = z.object({
  runId: nonEmpty,
  stepId: nonEmpty,
  decision: z.enum(["approved", "rejected"]),
  accepted: z.boolean(),
}).strict();
export type WorkflowRuntimeApprovalDecisionResponse = z.infer<typeof workflowRuntimeApprovalDecisionResponseSchema>;

/** POST /workflow-runtime/runs/:id/recovery body. */
export const workflowRuntimeRecoveryRequestSchema = z.object({
  action: workflowRuntimeRecoveryActionSchema,
}).strict();
export type WorkflowRuntimeRecoveryRequest = z.infer<typeof workflowRuntimeRecoveryRequestSchema>;

export const workflowRuntimeRecoveryResponseSchema = z.object({
  action: workflowRuntimeRecoveryActionSchema,
  /** False when the action was refused (blockers say why — never a guess). */
  executed: z.boolean(),
  /** Successor run created by continue/rerun. */
  runId: nonEmpty.optional(),
  resumedFromRunId: nonEmpty.optional(),
  status: nonEmpty.optional(),
  revisionId: nonEmpty.optional(),
  message: nonEmpty.optional(),
  blockers: z.array(workflowRuntimeRecoveryBlockerSchema).default([]),
}).strict();
export type WorkflowRuntimeRecoveryResponse = z.infer<typeof workflowRuntimeRecoveryResponseSchema>;
