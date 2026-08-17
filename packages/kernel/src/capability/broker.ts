/**
 * CapabilityBroker — the issuing and enforcement authority for all Capabilities.
 *
 * The Broker is the sole component that:
 *  1. Issues new Capabilities (returns an opaque handle to the caller).
 *  2. Resolves handles back to CapabilityRecords.
 *  3. Authorises syscall attempts against a Capability.
 *  4. Revokes Capabilities.
 *  5. Expires Capabilities (checked on every authorise call).
 *
 * The Broker does NOT execute side effects, dispatch Agents, or touch the
 * Cordis runtime. It is a pure security kernel component.
 *
 * Design: default-deny. Every field mismatch → DENY.
 */

import { randomUUID } from "node:crypto";
import { minimatch } from "minimatch";
import { generateCapabilityHandle, auditFingerprint } from "./handle.js";
import { CapabilityError, type DenyReason } from "./errors.js";
import {
  ACTION_RINGS,
  RING_ALLOWED_KINDS,
  type PrivilegeRing,
} from "./policy.js";
import type {
  Action,
  CapabilityHandle,
  CapabilityRecord,
} from "./types.js";
import type { AuditJournal, AuditEventInput } from "../audit/journal.js";
import { BudgetAccountant } from "../budget/accounting.js";
import type { CapabilityBudget } from "../budget/types.js";
import type { Principal, PrincipalId } from "../identity/principal.js";
import type { Resource, ResourceScope } from "../identity/resource.js";
import { normaliseResourcePath } from "../identity/resource.js";

// ---------------------------------------------------------------------------
// IssueRequest — what callers provide to request a Capability
// ---------------------------------------------------------------------------

export interface IssueRequest {
  /** Who the Capability is being issued to. */
  readonly subject: Principal;
  /** Action the Capability covers. */
  readonly action: Action;
  /** Resource the action applies to. */
  readonly resource: Resource;
  /** Optional sub-resource constraints. */
  readonly scope?: ResourceScope;
  /** When this Capability should expire (Unix ms). Omit for non-expiring. */
  readonly expiresAt?: number;
  /** Optional budget limits. */
  readonly budget?: CapabilityBudget;
}

// ---------------------------------------------------------------------------
// AuthoriseRequest — what callers provide on each syscall
// ---------------------------------------------------------------------------

export interface AuthoriseRequest {
  /** The principal performing the call. */
  readonly principal: Principal;
  /** The opaque handle the principal was given at issuance. */
  readonly handle: CapabilityHandle;
  /** The specific action being attempted. */
  readonly action: Action;
  /** The specific resource being acted on. */
  readonly resource: Resource;
  /**
   * The specific path being accessed (for repo/snapshot resources).
   * Checked against `scope.paths` glob patterns.
   */
  readonly path?: string;
  /**
   * The specific SHA being accessed.
   * Checked against `scope.sha`.
   */
  readonly sha?: string;
  /**
   * Tokens to reserve from the capability's budget (if any).
   * Call `commitTokens` or `releaseTokens` after the operation completes.
   */
  readonly tokensToReserve?: number;
}

// ---------------------------------------------------------------------------
// CapabilityBroker
// ---------------------------------------------------------------------------

export class CapabilityBroker {
  readonly #records = new Map<CapabilityHandle, CapabilityRecord>();
  readonly #accountants = new Map<string, BudgetAccountant>();
  readonly #journal: AuditJournal;
  readonly #clock: () => number;

  constructor(journal: AuditJournal, clock: () => number = Date.now) {
    this.#journal = journal;
    this.#clock = clock;
  }

  // -------------------------------------------------------------------------
  // issue
  // -------------------------------------------------------------------------

  /**
   * Issue a new Capability and return an opaque handle to the caller.
   *
   * The Broker validates that:
   * - The action's privilege ring permits the subject's PrincipalKind.
   * - expiresAt, if given, is in the future.
   */
  issue(request: IssueRequest): CapabilityHandle {
    const { subject, action, resource, scope, expiresAt, budget } = request;
    const now = this.#clock();

    // Policy check: is the subject's kind allowed to hold this action's ring?
    const ring: PrivilegeRing = ACTION_RINGS[action];
    const allowedKinds = RING_ALLOWED_KINDS[ring];
    if (!allowedKinds.includes(subject.kind)) {
      throw new CapabilityError(
        "action_mismatch",
        `PrincipalKind '${subject.kind}' cannot hold Ring ${ring} action '${action}'`
      );
    }

    if (expiresAt !== undefined && expiresAt <= now) {
      throw new RangeError(`expiresAt must be in the future`);
    }

    const handle = generateCapabilityHandle();
    const record: CapabilityRecord = {
      id: randomUUID(),
      handle,
      subject: subject.id,
      action,
      resource,
      scope,
      issuedAt: now,
      expiresAt,
      budget,
      revoked: false,
    };

    this.#records.set(handle, record);

    if (budget) {
      this.#accountants.set(handle, new BudgetAccountant(budget));
    }

    this.#journal.record({
      type: "capability.issued",
      timestamp: now,
      capabilityId: record.id,
      handleFingerprint: auditFingerprint(handle),
      subject: subject.id,
      action,
      resourceKind: resource.kind,
      expiresAt,
    });

    return handle;
  }

  // -------------------------------------------------------------------------
  // revoke
  // -------------------------------------------------------------------------

  /**
   * Permanently revoke a Capability.
   *
   * After revocation, every subsequent `authorise` call with this handle will
   * fail with `reason: "revoked"`. Revocation cannot be undone.
   */
  revoke(handle: CapabilityHandle, revokedBy: PrincipalId): void {
    const record = this.#records.get(handle);
    if (!record) throw new CapabilityError("unknown_capability");
    record.revoked = true;
    this.#journal.record({
      type: "capability.revoked",
      timestamp: this.#clock(),
      handleFingerprint: auditFingerprint(handle),
      capabilityId: record.id,
      subject: record.subject,
      revokedBy,
    });
  }

  // -------------------------------------------------------------------------
  // authorise
  // -------------------------------------------------------------------------

  /**
   * Authorise a syscall attempt. Throws {@link CapabilityError} on denial.
   *
   * Checks (in order, first failure → DENY):
   * 1. Handle exists.
   * 2. Not revoked.
   * 3. Not expired.
   * 4. Subject matches.
   * 5. Action matches.
   * 6. Resource kind + ID matches.
   * 7. Scope (SHA pin, path globs) satisfied.
   * 8. Budget available (reserve phase).
   *
   * On success, returns a `ReservationToken` that the caller MUST later
   * commit or release via `commitTokens` / `releaseTokens`.
   */
  authorise(request: AuthoriseRequest): ReservationToken | null {
    const now = this.#clock();
    let record: CapabilityRecord | undefined;
    let denyReason: DenyReason | null = null;

    // ---- 1. Handle exists ----
    record = this.#records.get(request.handle);
    if (!record) {
      denyReason = "unknown_capability";
    }

    // ---- 2. Not revoked ----
    if (!denyReason && record!.revoked) {
      denyReason = "revoked";
    }

    // ---- 3. Not expired ----
    if (!denyReason && record!.expiresAt !== undefined && record!.expiresAt < now) {
      denyReason = "expired";
    }

    // ---- 4. Subject matches ----
    if (!denyReason && record!.subject !== request.principal.id) {
      denyReason = "subject_mismatch";
    }

    // ---- 4b. RunId consistency ----
    if (!denyReason && record!.scope && request.principal.runId) {
      // If the principal carries a runId and the resource is run-scoped, verify match.
      // (Run-scoped resources like "evidence" / "workspace" embed runId in the resource.)
      const res = request.resource;
      if ((res.kind === "evidence" || res.kind === "workspace") && record!.resource.kind === res.kind) {
        const recRes = record!.resource as typeof res;
        if ("runId" in recRes && recRes.runId !== request.principal.runId) {
          denyReason = "run_mismatch";
        }
      }
    }

    // ---- 5. Action matches ----
    if (!denyReason && record!.action !== request.action) {
      denyReason = "action_mismatch";
    }

    // ---- 6. Resource matches ----
    if (!denyReason) {
      denyReason = matchResource(record!.resource, request.resource);
    }

    // ---- 7. Scope checks ----
    if (!denyReason) {
      denyReason = checkScope(record!.scope, request);
    }

    // ---- 8. Budget check ----
    let reservation: ReservationToken | null = null;
    if (!denyReason && record!.budget) {
      const accountant = this.#accountants.get(request.handle);
      if (accountant) {
        const reserveResult = accountant.reserve({ calls: 1, tokens: request.tokensToReserve });
        if (!reserveResult.ok) {
          denyReason = "budget_exhausted";
        } else {
          reservation = { handle: request.handle, reservationId: reserveResult.reservationId };
        }
      }
    }

    // ---- Audit ----
    const decision = denyReason ? "deny" : "allow";
    this.#journal.record({
      type: "syscall.authorised",
      timestamp: now,
      principal: request.principal.id,
      handleFingerprint: record ? auditFingerprint(record.handle) : "(unknown)",
      action: request.action,
      resourceKind: request.resource.kind,
      decision,
      reason: denyReason ?? "granted",
    });

    if (denyReason) {
      throw new CapabilityError(denyReason);
    }

    return reservation;
  }

  // -------------------------------------------------------------------------
  // Budget phase-2 helpers
  // -------------------------------------------------------------------------

  commitTokens(token: ReservationToken, actualTokens: number): void {
    this.#accountants.get(token.handle)?.commit(token.reservationId, actualTokens);
  }

  releaseTokens(token: ReservationToken): void {
    this.#accountants.get(token.handle)?.release(token.reservationId);
  }

  // -------------------------------------------------------------------------
  // Inspection (for tests / kernel introspection only)
  // -------------------------------------------------------------------------

  /** @internal — do not expose through any Ring 1/3 API */
  _getRecord(handle: CapabilityHandle): CapabilityRecord | undefined {
    return this.#records.get(handle);
  }
}

// ---------------------------------------------------------------------------
// Reservation token
// ---------------------------------------------------------------------------

export interface ReservationToken {
  readonly handle: CapabilityHandle;
  readonly reservationId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchResource(cap: Resource, req: Resource): DenyReason | null {
  if (cap.kind !== req.kind) return "resource_mismatch";

  switch (cap.kind) {
    case "repository":
      return (req as typeof cap).id === cap.id ? null : "resource_mismatch";
    case "snapshot":
      return (req as typeof cap).repositoryId === cap.repositoryId &&
             (req as typeof cap).sha === cap.sha
        ? null
        : "resource_mismatch";
    case "evidence":
      return (req as typeof cap).runId === cap.runId ? null : "resource_mismatch";
    case "workspace":
      return (req as typeof cap).runId === cap.runId ? null : "resource_mismatch";
    case "github.publish":
      return (req as typeof cap).repositoryId === cap.repositoryId ? null : "resource_mismatch";
    case "llm":
      return (req as typeof cap).provider === cap.provider ? null : "resource_mismatch";
    case "ast":
      return (req as typeof cap).snapshotId === cap.snapshotId ? null : "resource_mismatch";
    case "audit":
      return null;
    default:
      return "resource_mismatch";
  }
}

function checkScope(scope: ResourceScope | undefined, req: AuthoriseRequest): DenyReason | null {
  if (!scope) return null;

  // SHA check
  if (scope.sha !== undefined && req.sha !== undefined && scope.sha !== req.sha) {
    return "scope_violation";
  }

  // Path check
  if (scope.paths !== undefined && req.path !== undefined) {
    let normalised: string;
    try {
      normalised = normaliseResourcePath(req.path);
    } catch {
      return "scope_violation";
    }

    const allowed = scope.paths.some(pattern => minimatch(normalised, pattern, { dot: true }));
    if (!allowed) return "scope_violation";
  }

  return null;
}


