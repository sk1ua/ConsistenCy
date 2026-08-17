import { z } from "zod";

export const securityGuaranteesSchema = z.object({
  processMemoryIsolation: z.enum(["enforced", "not-enforced"]),
  parentEnvSecretIsolation: z.enum(["enforced", "not-enforced"]),
  kernelRpcAuthorization: z.enum(["enforced", "not-enforced"]),
  filesystemOsContainment: z.enum(["enforced", "not-enforced", "partial"]),
  networkOsContainment: z.enum(["enforced", "not-enforced", "partial"]),
  subprocessOsContainment: z.enum(["enforced", "not-enforced", "partial"]),
});
export type SecurityGuarantees = z.infer<typeof securityGuaranteesSchema>;

export const DEFAULT_SECURITY_GUARANTEES: SecurityGuarantees = Object.freeze({
  processMemoryIsolation: "enforced",
  parentEnvSecretIsolation: "enforced",
  kernelRpcAuthorization: "enforced",
  filesystemOsContainment: "not-enforced",
  networkOsContainment: "not-enforced",
  subprocessOsContainment: "not-enforced",
});

export const capabilityScopeSnapshotSchema = z.object({
  sha: z.string().optional(),
  paths: z.array(z.string()).optional(),
});
export type CapabilityScopeSnapshot = z.infer<typeof capabilityScopeSnapshotSchema>;

export const capabilityDescriptorSnapshotSchema = z.object({
  action: z.string(),
  resourceKind: z.string(),
  resourceId: z.string().optional(),
  handleFingerprint: z.string(),
  revoked: z.boolean().optional(),
  scope: capabilityScopeSnapshotSchema.optional(),
  expiresAt: z.number().optional(),
});
export type CapabilityDescriptorSnapshot = z.infer<typeof capabilityDescriptorSnapshotSchema>;

export const contextPageMetadataSnapshotSchema = z.object({
  pageId: z.string(),
  kind: z.string(),
  residency: z.string(),
  estimatedTokens: z.number(),
  contentHash: z.string(),
  sourceRef: z.string().optional(),
});
export type ContextPageMetadataSnapshot = z.infer<typeof contextPageMetadataSnapshotSchema>;

export const contextVMRuntimeSnapshotSchema = z.object({
  baseContextImageId: z.string().optional(),
  workingSetTokens: z.number(),
  workingSetPageCount: z.number(),
  pageCountsByKind: z.record(z.string(), z.number()),
  pageCountsByResidency: z.record(z.string(), z.number()),
  pages: z.array(contextPageMetadataSnapshotSchema),
});
export type ContextVMRuntimeSnapshot = z.infer<typeof contextVMRuntimeSnapshotSchema>;

export const sandboxSessionRuntimeSnapshotSchema = z.object({
  sessionId: z.string(),
  state: z.string(),
  pid: z.number().optional(),
  pluginId: z.string(),
  pluginVersion: z.string(),
  executionDomain: z.literal("child-process"),
  terminationReason: z.string().optional(),
  protocolVersion: z.number(),
  errorCode: z.string().optional(),
  diagnostics: z.string().optional(),
});
export type SandboxSessionRuntimeSnapshot = z.infer<typeof sandboxSessionRuntimeSnapshotSchema>;

export const pendingOperationSnapshotSchema = z.object({
  kind: z.enum(["llm", "tool", "io", "agent", "human"]),
  description: z.string(),
  startedAt: z.number(),
});
export type PendingOperationSnapshot = z.infer<typeof pendingOperationSnapshotSchema>;

export const agentBudgetSnapshotSchema = z.object({
  tokenBudget: z.number().optional(),
  costBudgetUsdMicros: z.string().optional(),
  wallTimeBudgetMs: z.number().optional(),
});
export type AgentBudgetSnapshot = z.infer<typeof agentBudgetSnapshotSchema>;

export const agentRuntimeSnapshotSchema = z.object({
  agentId: z.string(),
  label: z.string(),
  state: z.string(),
  priority: z.number(),
  parent: z.string().optional(),
  children: z.array(z.string()),
  logicalRing: z.number(),
  executionDomain: z.enum(["in-process", "worker-thread", "child-process"]),
  pendingOperation: pendingOperationSnapshotSchema.optional(),
  deadline: z.number().optional(),
  createdAt: z.number(),
  contextImageId: z.string().optional(),
  capabilities: z.array(capabilityDescriptorSnapshotSchema),
  budgets: agentBudgetSnapshotSchema.optional(),
  sandbox: sandboxSessionRuntimeSnapshotSchema.optional(),
});
export type AgentRuntimeSnapshot = z.infer<typeof agentRuntimeSnapshotSchema>;

export const runAgentCountsSchema = z.object({
  total: z.number(),
  running: z.number(),
  waiting: z.number(),
  terminal: z.number(),
});
export type RunAgentCounts = z.infer<typeof runAgentCountsSchema>;

export const runRuntimeSnapshotSchema = z.object({
  runId: z.string(),
  workloadKind: z.string(),
  jobId: z.string().optional(),
  state: z.string(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  deadline: z.number().optional(),
  agentCounts: runAgentCountsSchema,
  concurrency: z.number(),
  telemetryStatus: z.enum(["live", "completed", "unavailable"]),
  securityGuarantees: securityGuaranteesSchema,
  agents: z.array(agentRuntimeSnapshotSchema),
  context: contextVMRuntimeSnapshotSchema.optional(),
});
export type RunRuntimeSnapshot = z.infer<typeof runRuntimeSnapshotSchema>;

export const runtimeRunSummarySchema = z.object({
  runId: z.string(),
  workloadKind: z.string(),
  jobId: z.string().optional(),
  state: z.string(),
  createdAt: z.string(),
  telemetryStatus: z.enum(["live", "completed", "unavailable"]),
  agentCounts: runAgentCountsSchema,
});
export type RuntimeRunSummary = z.infer<typeof runtimeRunSummarySchema>;

export const runtimeRunsResponseSchema = z.object({
  runs: z.array(runtimeRunSummarySchema),
});
export type RuntimeRunsResponse = z.infer<typeof runtimeRunsResponseSchema>;
