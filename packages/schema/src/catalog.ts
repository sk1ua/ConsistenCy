import { z } from "zod";

/**
 * Read-only catalog projections (R1) — static, code-derived facts about the
 * review agent pipeline, the Kernel syscall registry, and the engine
 * analyzer/verifier allowlist. The API PROJECTS these from in-code constants;
 * it never invents semantics that do not exist in source. Every payload is
 * strict: unknown fields fail closed. No secrets, no absolute paths, no
 * capability handles cross this boundary.
 */

// ---------------------------------------------------------------------------
// Review agent pipeline catalog (pipeline C)
// ---------------------------------------------------------------------------

export const capabilityGrantSchema = z.object({
  repo: z.boolean(),
  ast: z.boolean(),
  evidenceRead: z.boolean(),
  evidenceWrite: z.boolean(),
  llm: z.boolean()
}).strict();
export type CapabilityGrant = z.infer<typeof capabilityGrantSchema>;

export const pipelineMemberKindSchema = z.enum([
  "deterministic-analyzer",
  "planner",
  "specialized-agent",
  "synthesizer"
]);
export type PipelineMemberKind = z.infer<typeof pipelineMemberKindSchema>;

export const capabilityProfileNameSchema = z.enum([
  "supervisor",
  "specialized",
  "security",
  "synthesizer"
]);
export type CapabilityProfileName = z.infer<typeof capabilityProfileNameSchema>;

/**
 * One member of the review pipeline. `agentName` is present only for
 * specialized agents and equals the exact `reviewAgentNameSchema` value.
 * `capabilityProfile`/`grants`/`grantedActions` are present only where the
 * workload assigns a profile (Planner, specialized agents, Synthesizer);
 * `grantedActions` materializes the exact Kernel actions issued from those
 * grant flags at runtime. The deterministic analyzer deliberately carries NO
 * profile — none exists in source.
 */
export const reviewPipelineMemberSchema = z.object({
  key: z.string(),
  kind: pipelineMemberKindSchema,
  agentName: z.string().optional(),
  capabilityProfile: capabilityProfileNameSchema.optional(),
  grants: capabilityGrantSchema.optional(),
  grantedActions: z.array(z.string()).optional()
}).strict();
export type ReviewPipelineMember = z.infer<typeof reviewPipelineMemberSchema>;

export const reviewContextPageCatalogSchema = z.object({
  kind: z.enum(["policy", "task", "diff", "source", "evidence"]),
  residency: z.enum(["pinned", "hot"])
}).strict();
export type ReviewContextPageCatalog = z.infer<typeof reviewContextPageCatalogSchema>;

export const reviewContextBudgetsSchema = z.object({
  diffMaxChars: z.number().int().nonnegative(),
  fileContentsMaxChars: z.number().int().nonnegative(),
  projectMetadataMaxChars: z.number().int().nonnegative(),
  kernelEvidenceMaxEntries: z.number().int().nonnegative()
}).strict();
export type ReviewContextBudgets = z.infer<typeof reviewContextBudgetsSchema>;

export const reviewPipelineCatalogSchema = z.object({
  members: z.array(reviewPipelineMemberSchema),
  contextPages: z.array(reviewContextPageCatalogSchema),
  budgets: reviewContextBudgetsSchema,
  /** Supervisor plan fields (reviewPlanSchema) — semantics described client-side. */
  planFields: z.array(z.enum(["enabledAgents", "skippedAgents", "riskAreas", "reason"]))
}).strict();
export type ReviewPipelineCatalog = z.infer<typeof reviewPipelineCatalogSchema>;

export const reviewPipelineCatalogResponseSchema = z.object({
  pipeline: reviewPipelineCatalogSchema
}).strict();
export type ReviewPipelineCatalogResponse = z.infer<typeof reviewPipelineCatalogResponseSchema>;

// ---------------------------------------------------------------------------
// Kernel syscall catalog
// ---------------------------------------------------------------------------

export const kernelSyscallDefinitionSchema = z.object({
  action: z.string(),
  effectClass: z.enum(["pure", "read", "revertible", "commit"]),
  dispatchPolicy: z.enum(["direct", "intent"]),
  description: z.string().optional()
}).strict();
export type KernelSyscallDefinition = z.infer<typeof kernelSyscallDefinitionSchema>;

export const kernelSyscallCatalogSchema = z.object({
  syscalls: z.array(kernelSyscallDefinitionSchema),
  /** Subset of actions whose dispatch policy routes through CommitCoordinator intents. */
  commitIntentActions: z.array(z.string())
}).strict();
export type KernelSyscallCatalog = z.infer<typeof kernelSyscallCatalogSchema>;

export const kernelSyscallCatalogResponseSchema = z.object({
  catalog: kernelSyscallCatalogSchema
}).strict();
export type KernelSyscallCatalogResponse = z.infer<typeof kernelSyscallCatalogResponseSchema>;

// ---------------------------------------------------------------------------
// Engine allowlist catalog
// ---------------------------------------------------------------------------

export const builtinEngineWorkflowSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional()
}).strict();
export type BuiltinEngineWorkflowSummary = z.infer<typeof builtinEngineWorkflowSummarySchema>;

export const runtimeVerifiedBuiltinSummarySchema = z.object({
  id: z.string(),
  namespace: z.literal("workflow-runtime"),
  revision: z.number().int().positive(),
  revisionId: z.string(),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  purpose: z.string(),
  nodeTypes: z.array(z.string()),
  verificationStatus: z.enum(["unverified", "verified"]),
  verificationContract: z.string(),
  verificationMatrixVersion: z.string(),
  status: z.literal("available")
}).strict();
export type RuntimeVerifiedBuiltinSummary = z.infer<typeof runtimeVerifiedBuiltinSummarySchema>;

export const engineAllowlistCatalogSchema = z.object({
  analyzers: z.array(z.string()),
  verifiers: z.array(z.string()),
  synthesizerKinds: z.array(z.string()),
  /** Deprecated compatibility projection of the frozen legacy WorkflowStore. */
  builtinWorkflows: z.array(builtinEngineWorkflowSummarySchema),
  engineLegacyBuiltins: z.array(builtinEngineWorkflowSummarySchema),
  runtimeVerifiedBuiltins: z.array(runtimeVerifiedBuiltinSummarySchema),
  /** Present (true) only when the builtin workflow list could not be read. */
  builtinWorkflowsUnavailable: z.literal(true).optional()
}).strict();
export type EngineAllowlistCatalog = z.infer<typeof engineAllowlistCatalogSchema>;

export const engineAllowlistCatalogResponseSchema = z.object({
  catalog: engineAllowlistCatalogSchema
}).strict();
export type EngineAllowlistCatalogResponse = z.infer<typeof engineAllowlistCatalogResponseSchema>;
