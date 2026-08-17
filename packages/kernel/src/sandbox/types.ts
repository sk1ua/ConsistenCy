/**
 * Sandbox subsystem model types.
 *
 * The sandbox subsystem creates the FIRST REAL physical execution boundary
 * for untrusted third-party plugins: a child Node process that talks to the
 * Kernel only through a narrow, versioned RPC channel.
 *
 * SECURITY MODEL — three distinct guarantees, kept deliberately separate:
 *
 *   A. PROCESS ISOLATION — separate PID, separate JS heap, no parent globals,
 *      no parent `process.env` inheritance. Enforced by OS process boundaries.
 *   B. CAPABILITY AUTHORIZATION — every RPC operation is authorised per-call
 *      by CapabilityBroker.authorise() through SyscallGateway on the trusted
 *      parent side. The child never holds a raw CapabilityHandle.
 *   C. OS CONTAINMENT (filesystem/network/subprocess) — NOT provided by this
 *      PR. A plain Node child process retains normal OS permissions for the
 *      account it runs under. Stronger containment is a platform-specific
 *      requirement documented separately.
 */

import type { Action, CapabilityHandle } from "../capability/types.js";
import type { PrivilegeRing } from "../capability/policy.js";
import type { Principal, PrincipalId } from "../identity/principal.js";
import type { Resource } from "../identity/resource.js";
import type { AgentId } from "../agent/types.js";
import type { ExecutionDomain } from "../agent/types.js";
import type { RunId } from "../run/types.js";
import type { SyscallGateway, SyscallOutcome } from "../syscall/authorize.js";
import type { SandboxSession } from "./session.js";

/** Branded, serializable sandbox session identifier. */
export type SandboxSessionId = string & { readonly __brand: "SandboxSessionId" };

export function asSandboxSessionId(raw: string): SandboxSessionId {
  if (!raw || raw.trim() === "") {
    throw new TypeError("SandboxSessionId must be non-empty");
  }
  return raw as SandboxSessionId;
}

/** Lifecycle of one child-process execution session. */
export type SandboxSessionState =
  | "starting"    // fork issued, child not yet confirmed
  | "running"     // child process alive, protocol active
  | "succeeded"   // plugin produced a valid run-result
  | "failed"      // crash / launch failure / plugin error / protocol violation
  | "timed_out"   // execution timeout fired, child terminated
  | "cancelled";  // cancellation requested, child terminated

export const TERMINAL_SANDBOX_STATES: readonly SandboxSessionState[] = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
];

/** Why a session reached a terminal state. */
export type SandboxTerminationReason =
  | "completed"
  | "crash"
  | "launch_failed"
  | "timeout"
  | "cancelled"
  | "protocol_violation";

/**
 * Immutable plugin descriptor. Trust and execution domain are EXPLICIT fields;
 * they are never inferred from package names or paths.
 */
export interface PluginDescriptor {
  readonly id: string;
  readonly version: string;
  /** "trusted" = part of the trusted codebase; "untrusted" = third-party. */
  readonly trust: "trusted" | "untrusted";
  readonly logicalRing: PrivilegeRing;
  /**
   * Where the plugin may execute. SandboxManager implements ONLY
   * "child-process". Any other domain has no executor here and launch fails
   * closed — there is never a silent fallback to another domain.
   */
  readonly executionDomain: ExecutionDomain;
  /** Absolute path to the plugin entrypoint (loaded by the sandbox worker). */
  readonly entrypoint: string;
  /**
   * Operations the plugin wants (e.g. "repo.read"). DECLARATIVE ONLY —
   * provisioning still requires an explicit server-side capability binding.
   */
  readonly requestedOperations?: readonly string[];
}

/**
 * Server-side capability binding: maps one RPC method to a capability the
 * TRUSTED PARENT holds. The raw handle never crosses the process boundary.
 */
export interface BoundOperation {
  readonly action: Action;
  readonly resource: Resource;
  readonly handle: CapabilityHandle;
}

/** Context handed to trusted parent-side operation handlers. */
export interface TrustedOperationContext {
  readonly sessionId: SandboxSessionId;
  readonly principal: Principal;
  readonly runId?: RunId;
  readonly agentId?: AgentId;
}

/**
 * Trusted parent-side implementation of one RPC method. Runs ONLY after
 * CapabilityBroker.authorise() allows the call; invoked through
 * SyscallGateway.invoke like every other Kernel-mediated operation.
 */
export type TrustedOperationHandler = (
  params: Record<string, unknown>,
  ctx: TrustedOperationContext,
) => SyscallOutcome<unknown> | Promise<SyscallOutcome<unknown>>;

export interface SandboxLaunchOptions {
  /** Gateway + broker chain that authorises every RPC operation. */
  readonly gateway: SyscallGateway;
  /** The session principal. The child CANNOT choose its own identity. */
  readonly principal: Principal;
  readonly runId?: RunId;
  readonly agentId?: AgentId;
  /** RPC method → server-side capability binding (parent-held handles). */
  readonly capabilities: ReadonlyMap<string, BoundOperation>;
  /** RPC method → trusted handler. Every bound method must have a handler. */
  readonly operations: ReadonlyMap<string, TrustedOperationHandler>;
  /** Session-level execution timeout (ms). Default 30_000. */
  readonly timeoutMs?: number;
  /** Opt-in protocol transcript capture (test/diagnostic only). */
  readonly captureTranscript?: boolean;
  /** Extra allowlisted child env vars (test-only). Never the parent env. */
  readonly envExtension?: Readonly<Record<string, string | undefined>>;
  /** Extra argv entries passed to the worker (test fixtures only). */
  readonly workerArgs?: readonly string[];
}

/** Terminal outcome of one sandbox session. */
export interface SandboxRunResult {
  readonly sessionId: SandboxSessionId;
  readonly state: SandboxSessionState;
  /** Plugin run-result payload (only when state === "succeeded"). */
  readonly result?: unknown;
  /** Typed terminal error (absent when succeeded). */
  readonly error?: { readonly code: string; readonly message: string };
}

/** Frozen public view of a session. */
export interface SandboxSessionSnapshot {
  readonly id: SandboxSessionId;
  readonly state: SandboxSessionState;
  readonly principalId: PrincipalId;
  readonly runId?: RunId;
  readonly agentId?: AgentId;
  readonly executionDomain: ExecutionDomain;
  readonly descriptorId: string;
  readonly pid?: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly terminationReason?: SandboxTerminationReason;
  readonly error?: { readonly code: string; readonly message: string };
  readonly exitCode?: number | null;
  readonly exitSignal?: string | null;
  readonly processExited: boolean;
  readonly pendingRequestCount: number;
  /** Sanitized, size-capped child diagnostics (stderr), never echoed to RPC. */
  readonly diagnostics: string;
}

/** What `SandboxManager.launch` returns. */
export interface SandboxLaunch {
  readonly sessionId: SandboxSessionId;
  readonly session: SandboxSession;
  /** Resolves exactly once with the terminal outcome. */
  readonly result: Promise<SandboxRunResult>;
}
