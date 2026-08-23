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

export const workflowRuntimeEdgeSchema = z.object({
  from: workflowRuntimeNodeIdSchema,
  to: workflowRuntimeNodeIdSchema,
}).strict();

export const workflowRuntimeDefinitionSchema = z.object({
  id: nonEmpty,
  version: z.literal(1),
  nodes: z.array(workflowRuntimeNodeSchema).min(1),
  edges: z.array(workflowRuntimeEdgeSchema).default([]),
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

export const workflowRuntimeValidationResultSchema = z.object({
  ok: z.boolean(),
  errors: z.array(workflowRuntimeValidationIssueSchema).default([]),
}).strict();

/**
 * One planned agent. Purely descriptive: no credential, no raw handle, no
 * authorization decision — `capabilityRequirements` names the actions the
 * runtime would have to issue for the agent, checked for FEASIBILITY only.
 */
export const workflowRuntimeAgentSpecSchema = z.object({
  nodeId: workflowRuntimeNodeIdSchema,
  serviceRef: nonEmpty,
  /** Topological execution order (0 runs first). */
  order: z.number().int().nonnegative(),
  coeffects: z.array(nonEmpty).default([]),
  capabilityRequirements: z.array(nonEmpty).default([]),
}).strict();

export const workflowRuntimeExecutablePlanSchema = z.object({
  definitionId: nonEmpty,
  definitionVersion: z.literal(1),
  agentSpecs: z.array(workflowRuntimeAgentSpecSchema).min(1),
}).strict();

/** Node Registry DTO — the runtime-owned truth about executable node types. */
export const workflowRuntimeNodeTypeSchema = z.object({
  type: nonEmpty,
  serviceRef: nonEmpty,
  role: z.enum(["analyzer", "verifier"]),
  description: z.string(),
  capabilityRequirements: z.array(nonEmpty),
  coeffects: z.array(nonEmpty),
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

/** Definition ids share the engine-safe alphabet ([a-z][a-z0-9_-]*). */
export const workflowRuntimeDefinitionIdSchema = workflowRuntimeNodeIdSchema;

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
}).strict();

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
}).strict();

export const workflowRuntimeRunV2Schema = workflowRuntimeRunSchema.extend({
  revisionId: nonEmpty,
  origin: z.enum(["builtin", "user"]),
}).strict();

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
 * A binding is DATA (repository ↔ definition intent), never an
 * authorization: execution still resolves the latest validated revision and
 * authorizes every protected syscall per-call.
 */
export const workflowRuntimeBindingSchema = z.object({
  repositoryId: nonEmpty,
  definitionId: workflowRuntimeDefinitionIdSchema,
  enabled: z.boolean(),
  /** Definition summary at read time; null when the definition was deleted. */
  definition: workflowRuntimeDefinitionSummarySchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const workflowRuntimeSetBindingRequestSchema = z.object({
  enabled: z.boolean(),
}).strict();

/** POST /workflow-runtime/repositories/:id/runs — binding-gated manual trigger. */
export const workflowRuntimeRepositoryTriggerRequestSchema = z.object({
  definitionId: workflowRuntimeDefinitionIdSchema,
}).strict();

export type WorkflowRuntimeBinding = z.infer<typeof workflowRuntimeBindingSchema>;
export type WorkflowRuntimeSetBindingRequest = z.infer<typeof workflowRuntimeSetBindingRequestSchema>;
export type WorkflowRuntimeRepositoryTriggerRequest = z.infer<typeof workflowRuntimeRepositoryTriggerRequestSchema>;
