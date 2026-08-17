/**
 * @consistency/kernel — public surface
 *
 * Only types and classes that cross package boundaries are re-exported here.
 * Kernel-internal implementation details stay buried inside their respective
 * subdirectories and are NOT part of this export.
 *
 * Rule: if a type is only used inside `packages/kernel`, it does NOT belong
 * in `@consistency/schema`. Keep schema for wire contracts and persistence DTOs.
 */

// Identity
export type { Principal, PrincipalId, PrincipalKind } from "./identity/principal.js";
export { asPrincipalId, makePrincipalId } from "./identity/principal.js";

export type {
  Resource,
  ResourceKind,
  ResourceScope,
  RepositoryResource,
  SnapshotResource,
  EvidenceResource,
  AuditResource,
  WorkspaceResource,
  GitHubPublishResource,
  LLMResource,
  ASTResource,
} from "./identity/resource.js";
export { normaliseResourcePath } from "./identity/resource.js";

// Capability
export type { Action, CapabilityHandle, CapabilityRecord } from "./capability/types.js";
export { asCapabilityHandle } from "./capability/types.js";
export { auditFingerprint } from "./capability/handle.js";
export type { IssueRequest, AuthoriseRequest, ReservationToken } from "./capability/broker.js";
export { CapabilityBroker } from "./capability/broker.js";
export type { PrivilegeRing } from "./capability/policy.js";
export { ACTION_RINGS, SERVICE_RING, CAPABILITY_ISSUABLE_RING, RING_ALLOWED_KINDS } from "./capability/policy.js";
export type { DenyReason } from "./capability/errors.js";
export { CapabilityError } from "./capability/errors.js";

// Capability lifecycle notifications (Cordis-free subscription bus)
export type {
  CapabilityChangeEvent,
  CapabilityChangeListener,
  CapabilityIssuedChangeEvent,
  CapabilityRevokedChangeEvent,
} from "./capability/events.js";
export { CapabilityChangeBus } from "./capability/events.js";

// Syscall
export type { EffectClass, DispatchPolicy, SyscallDefinition } from "./syscall/types.js";
export { SYSCALL_DEFINITIONS, getSyscallDefinition } from "./syscall/types.js";
export type { SyscallOutcome } from "./syscall/authorize.js";
export { SyscallGateway } from "./syscall/authorize.js";

// CommitCoordinator (durable intent gate for irreversible external mutations)
export type {
  CommitAction,
  CommitIntentId,
  CommitIntent,
  CommitReceipt,
  CommitReceiptStatus,
  CommitIntentSink,
  CommitAcceptRequest,
  CommitCoordinatorSnapshot,
} from "./commit/types.js";
export { asCommitIntentId } from "./commit/types.js";
export {
  CommitCoordinatorRequiredError,
  CommitIntentRejectedError,
  CommitSinkError,
} from "./commit/errors.js";
export type { CommitCoordinatorOptions } from "./commit/coordinator.js";
export { CommitCoordinator } from "./commit/coordinator.js";

// Audit
export type {
  AuditEvent,
  CapabilityIssuedEvent,
  CapabilityRevokedEvent,
  SyscallAuthorisedEvent,
  CommitIntentAcceptedEvent,
  CommitIntentDeniedEvent,
} from "./audit/types.js";
export type { AuditJournal } from "./audit/journal.js";
export { MemoryJournal } from "./audit/memoryJournal.js";

// Budget
export type { CapabilityBudget, BudgetState, ReserveRequest, ReserveResult } from "./budget/types.js";
export { BudgetAccountant } from "./budget/accounting.js";

// Run (generic execution instance of a Job)
export type {
  Run,
  RunId,
  RunSnapshot,
  RunState,
  CreateRunRequest,
} from "./run/types.js";
export {
  asRunId,
  RUN_STATES,
  TERMINAL_RUN_STATES,
  RUN_TRANSITIONS,
  canTransitionRun,
  transitionRun,
  RunStateTransitionError,
} from "./run/types.js";
export { RunRegistry } from "./run/registry.js";

// Agent process model (ACB)
export type {
  AgentId,
  AgentState,
  AgentSnapshot,
  AgentControlBlock,
  CapabilityRef,
  ExecutionDomain,
  ModelPolicy,
  PendingOperation,
  RegisterAgentRequest,
} from "./agent/types.js";
export {
  asAgentId,
  AGENT_STATES,
  TERMINAL_AGENT_STATES,
  WAIT_AGENT_STATES,
  AgentTreeInvariantError,
} from "./agent/types.js";
export {
  AGENT_TRANSITIONS,
  canTransitionAgent,
  transitionAgent,
  AgentStateTransitionError,
} from "./agent/state.js";
export { AgentRegistry } from "./agent/registry.js";

// ContextImage reference contract (Context VM arrives in PR-3)
export type { ContextImageId } from "./identity/context-image.js";
export { asContextImageId } from "./identity/context-image.js";

// RepositorySnapshot identity policy (materialization lives in @consistency/repository)
export type { RepositorySnapshotId, SnapshotIdentity } from "./identity/snapshot.js";
export {
  asRepositorySnapshotId,
  SNAPSHOT_URI_SCHEME,
  SnapshotUriError,
  formatSnapshotUri,
  parseSnapshotUri,
} from "./identity/snapshot.js";

// Evidence — canonical deterministic grounding records (PR-4)
export type {
  EvidenceId,
  EvidenceSource,
  EvidenceLocation,
  EvidenceProvenance,
  EvidenceInput,
  Evidence,
  EvidenceSnapshot,
  EvidenceQuery,
  JsonValue,
} from "./evidence/types.js";
export { asEvidenceId } from "./evidence/types.js";
export {
  EvidenceError,
  EvidenceValidationError,
  EvidenceIdConflictError,
  CanonicalizationError,
} from "./evidence/errors.js";
export { canonicalizeJson, computeEvidenceFingerprint } from "./evidence/fingerprint.js";
export { EvidenceStore } from "./evidence/store.js";

// Context VM (PR-3): virtual context memory primitives
export type {
  ContextPageId,
  ContextPageKind,
  ContextPage,
  CreatePageSpec,
  Residency,
  ResolvedPage,
  SourceRef,
  PageProvenance,
  ContextImageSnapshot,
  WorkingSetSnapshot,
  RenderedContextPage,
  RenderedContext,
  ContextCheckpoint,
} from "./context/types.js";
export {
  asContextPageId,
  CONTEXT_PAGE_KINDS,
  CONTEXT_PAGE_KIND_PRECEDENCE,
  RESIDENCIES,
  isResidency,
} from "./context/types.js";
export {
  ContextError,
  PageNotFoundError,
  ImageNotFoundError,
  PageAlreadyExistsError,
  PageAlreadyAttachedError,
  PageNotAttachedError,
  PinnedPageEvictionError,
  InvalidResidencyTransitionError,
  CheckpointFormatError,
  CheckpointCorruptionError,
  ImageIdConflictError,
} from "./context/errors.js";
export { hashText } from "./context/page-store.js";
export { ContextManager } from "./context/manager.js";
export type { RestoreOptions } from "./context/manager.js";

// Scheduler (admission control + cooperative scheduling)
export type {
  SchedulerConfig,
  SchedulerEvent,
  SchedulerEventListener,
  WaitDetails,
} from "./scheduler/types.js";
export { WAIT_STATE_BY_KIND, pendingOperationFor } from "./scheduler/types.js";
export { SchedulerEventBus } from "./scheduler/events.js";
export { KernelScheduler } from "./scheduler/scheduler.js";
export type { KernelSchedulerOptions } from "./scheduler/scheduler.js";
