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
export type { IssueRequest, AuthoriseRequest, ReservationToken } from "./capability/broker.js";
export { CapabilityBroker } from "./capability/broker.js";
export type { PrivilegeRing } from "./capability/policy.js";
export { ACTION_RINGS, SERVICE_RING, CAPABILITY_ISSUABLE_RING, RING_ALLOWED_KINDS } from "./capability/policy.js";
export type { DenyReason } from "./capability/errors.js";
export { CapabilityError } from "./capability/errors.js";

// Syscall
export type { EffectClass, SyscallDefinition } from "./syscall/types.js";
export { SYSCALL_DEFINITIONS, getSyscallDefinition } from "./syscall/types.js";
export type { SyscallOutcome } from "./syscall/authorize.js";
export { SyscallGateway } from "./syscall/authorize.js";

// Audit
export type { AuditEvent, CapabilityIssuedEvent, CapabilityRevokedEvent, SyscallAuthorisedEvent } from "./audit/types.js";
export type { AuditJournal } from "./audit/journal.js";
export { MemoryJournal } from "./audit/memoryJournal.js";

// Budget
export type { CapabilityBudget, BudgetState, ReserveRequest, ReserveResult } from "./budget/types.js";
export { BudgetAccountant } from "./budget/accounting.js";
