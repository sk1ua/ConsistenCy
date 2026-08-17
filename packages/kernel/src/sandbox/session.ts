/**
 * SandboxSession — one child-process execution session.
 *
 * Owns: session identity (RunId/AgentId/Principal — bound by the parent,
 * NEVER selectable by the child), the child process handle, the versioned RPC
 * routing, per-session timeout, cancellation, and full resource cleanup.
 *
 * ROUTING CONTRACT (cross-process equivalent of the in-process invariant
 * "service availability != authorization"):
 *
 *   1. validate protocol strictly (fail closed on malformed traffic),
 *   2. resolve the method against the SERVER-SIDE capability binding,
 *   3. authorise through SyscallGateway → CapabilityBroker.authorise(),
 *   4. only then invoke the trusted parent-side handler.
 *
 * The child never sees a CapabilityHandle, a CapabilityRecord, or the
 * Kernel's object graph — only results and typed errors.
 */

import type { Serializable } from "node:child_process";
import { CapabilityError } from "../capability/errors.js";
import type { AuthoriseRequest } from "../capability/broker.js";
import { spawnSandboxChild } from "./runner.js";
import type { SandboxChildProcess } from "./runner.js";
import {
  SandboxCancelledError,
  SandboxLaunchError,
  SandboxTimeoutError,
} from "./errors.js";
import {
  buildCancelMessage,
  buildFinishMessage,
  buildResponseError,
  buildResponseOk,
  MAX_DIAGNOSTIC_BYTES,
  MAX_PENDING_REQUESTS,
  MAX_RPC_MESSAGE_BYTES,
  MAX_TRANSCRIPT_ENTRIES,
  rpcMessageSize,
  sanitizeRpcText,
  validateChildMessage,
} from "./protocol.js";
import {
  TERMINAL_SANDBOX_STATES,
  type PluginDescriptor,
  type SandboxLaunchOptions,
  type SandboxRunResult,
  type SandboxSessionId,
  type SandboxSessionSnapshot,
  type SandboxSessionState,
  type SandboxTerminationReason,
  type TrustedOperationContext,
} from "./types.js";

const DEFAULT_SESSION_TIMEOUT_MS = 30_000;
const FORCE_KILL_FALLBACK_MS = 2_000;
const CANCEL_GRACE_MS = 1_000;

interface PendingRequestEntry {
  readonly method: string;
}

export interface SandboxSessionConfig {
  readonly id: SandboxSessionId;
  readonly descriptor: PluginDescriptor;
  readonly options: SandboxLaunchOptions;
  readonly clock?: () => number;
  readonly onLifecycle?: (session: SandboxSession, state: SandboxSessionState) => void;
}

export class SandboxSession {
  readonly #id: SandboxSessionId;
  readonly #descriptor: PluginDescriptor;
  readonly #options: SandboxLaunchOptions;
  readonly #clock: () => number;
  readonly #onLifecycle?: (session: SandboxSession, state: SandboxSessionState) => void;

  #state: SandboxSessionState = "starting";
  #terminationReason?: SandboxTerminationReason;
  #error?: { readonly code: string; readonly message: string };
  #startedAt: number;
  #endedAt?: number;
  #result?: unknown;
  #child?: SandboxChildProcess;
  #exitCode: number | null = null;
  #exitSignal: string | null = null;
  #processExited = false;
  #readySeen = false;
  #finalResultSeen = false;
  #pending = new Map<string, PendingRequestEntry>();
  #seenRequestIds = new Set<string>();
  #diagnostics = "";
  #transcriptIn: unknown[] = [];
  #transcriptOut: unknown[] = [];
  #timeoutTimer?: NodeJS.Timeout;
  #graceKillTimer?: NodeJS.Timeout;
  #forceKillTimer?: NodeJS.Timeout;
  #resolveResult!: (result: SandboxRunResult) => void;
  readonly #resultPromise: Promise<SandboxRunResult>;
  #exitedResolve!: () => void;
  readonly #exitedPromise: Promise<void>;

  constructor(config: SandboxSessionConfig) {
    this.#id = config.id;
    this.#descriptor = config.descriptor;
    this.#options = config.options;
    this.#clock = config.clock ?? Date.now;
    this.#onLifecycle = config.onLifecycle;
    this.#startedAt = this.#clock();
    this.#resultPromise = new Promise<SandboxRunResult>((resolve) => {
      this.#resolveResult = resolve;
    });
    this.#exitedPromise = new Promise<void>((resolve) => {
      this.#exitedResolve = resolve;
    });

    try {
      this.#child = spawnSandboxChild({
        entrypoint: this.#descriptor.entrypoint,
        envExtension: this.#options.envExtension,
        workerArgs: this.#options.workerArgs,
      });
    } catch (error) {
      const detail = error instanceof SandboxLaunchError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
      this.#terminate("failed", "launch_failed", {
        code: "launch_failed",
        message: sanitizeRpcText(detail, 256),
      });
      this.#processExited = true;
      this.#exitedResolve();
      return;
    }

    const child = this.#child;
    child.child.on("message", (raw: unknown) => this.#onChildMessage(raw));
    child.child.on("exit", (code, signal) => this.#onChildExit(code, signal));
    child.child.on("error", (error) => this.#onChildError(error));
    child.child.on("disconnect", () => this.#onChildDisconnect());
    if (child.child.stderr) {
      child.child.stderr.on("data", (chunk: Buffer) => this.#onDiagnostic(chunk));
    }

    this.#state = "running";
    this.#timeoutTimer = setTimeout(() => {
      const timeoutMs = this.#options.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
      this.#terminate("timed_out", "timeout", {
        code: "timeout",
        message: `Sandbox execution exceeded the ${timeoutMs}ms session timeout`,
      });
      this.#killChild();
    }, this.#options.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS);
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  get id(): SandboxSessionId {
    return this.#id;
  }

  get result(): Promise<SandboxRunResult> {
    return this.#resultPromise;
  }

  /** Resolves when the child process has fully exited. */
  get exited(): Promise<void> {
    return this.#exitedPromise;
  }

  snapshot(): SandboxSessionSnapshot {
    return Object.freeze({
      id: this.#id,
      state: this.#state,
      principalId: this.#options.principal.id,
      runId: this.#options.runId,
      agentId: this.#options.agentId,
      executionDomain: this.#descriptor.executionDomain,
      descriptorId: this.#descriptor.id,
      pid: this.#child?.pid,
      startedAt: this.#startedAt,
      endedAt: this.#endedAt,
      terminationReason: this.#terminationReason,
      error: this.#error,
      exitCode: this.#exitCode,
      exitSignal: this.#exitSignal,
      processExited: this.#processExited,
      pendingRequestCount: this.#pending.size,
      diagnostics: this.#diagnostics.slice(-MAX_DIAGNOSTIC_BYTES),
    });
  }

  /** @internal — test/diagnostic protocol transcript (opt-in at launch). */
  transcript(): { readonly inbound: readonly unknown[]; readonly outbound: readonly unknown[] } {
    return {
      inbound: Object.freeze([...this.#transcriptIn]),
      outbound: Object.freeze([...this.#transcriptOut]),
    };
  }

  /**
   * Cancel the session: mark terminal immediately (all further RPC DENIED),
   * notify the child, reject pending requests, then terminate the process
   * after a short grace period.
   */
  cancel(): void {
    if (TERMINAL_SANDBOX_STATES.includes(this.#state)) return;
    this.#sendToChild(buildCancelMessage("session cancelled by parent"));
    this.#terminate("cancelled", "cancelled", {
      code: "cancelled",
      message: "Sandbox session was cancelled",
    });
    // Grace window lets the child observe cancellation, then it is killed.
    this.#graceKillTimer = setTimeout(() => {
      this.#killChild();
    }, CANCEL_GRACE_MS);
  }

  // -------------------------------------------------------------------------
  // Protocol handling
  // -------------------------------------------------------------------------

  #onChildMessage(raw: unknown): void {
    // 1. Size guard FIRST — before retaining or processing anything.
    if (rpcMessageSize(raw) > MAX_RPC_MESSAGE_BYTES) {
      this.#violate("oversized_message");
      return;
    }

    if (this.#options.captureTranscript) {
      this.#pushTranscript(this.#transcriptIn, raw);
    }

    if (TERMINAL_SANDBOX_STATES.includes(this.#state)) {
      // After a terminal state, requests are DENIED; other messages ignored.
      if (raw !== null && typeof raw === "object") {
        const probe = raw as Record<string, unknown>;
        if (probe.type === "request" && typeof probe.requestId === "string") {
          this.#sendToChild(
            buildResponseError(
              probe.requestId,
              "session_terminated",
              "The sandbox session has already terminated",
            ),
          );
        }
      }
      return;
    }

    // 2. Strict structural validation (fail closed).
    const validation = validateChildMessage(raw);
    if (!validation.ok) {
      this.#violate(validation.violation);
      return;
    }

    switch (validation.kind) {
      case "ready": {
        if (this.#readySeen) {
          this.#violate("duplicate_ready_message");
          return;
        }
        this.#readySeen = true;
        return;
      }

      case "request": {
        this.#onRequest(
          validation.message.requestId,
          validation.message.method,
          validation.message.params ?? {},
        );
        return;
      }

      case "run-result": {
        if (this.#finalResultSeen) {
          this.#violate("duplicate_run_result");
          return;
        }
        this.#finalResultSeen = true;
        this.#result = validation.message.result;
        this.#finishGracefully("succeeded", "completed");
        return;
      }

      case "run-error": {
        if (this.#finalResultSeen) {
          this.#violate("duplicate_run_result");
          return;
        }
        this.#finalResultSeen = true;
        this.#finishGracefully("failed", "crash", {
          code: validation.message.error.code,
          message: sanitizeRpcText(validation.message.error.message, 512),
        });
        return;
      }
    }
  }

  #onRequest(requestId: string, method: string, params: Record<string, unknown>): void {
    if (this.#seenRequestIds.has(requestId)) {
      this.#violate("duplicate_request_id");
      return;
    }
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      this.#violate("too_many_pending_requests");
      return;
    }
    this.#seenRequestIds.add(requestId);

    // Unknown method → typed DENY, handler never runs, session stays alive.
    if (!this.#options.capabilities.has(method)) {
      this.#seenRequestIds.delete(requestId);
      this.#sendToChild(
        buildResponseError(requestId, "unknown_method", `Method '${method}' is not available in this sandbox session`),
      );
      return;
    }

    const binding = this.#options.capabilities.get(method)!;
    const handler = this.#options.operations.get(method);
    if (!handler) {
      // Config validation guarantees this cannot happen; fail closed anyway.
      this.#seenRequestIds.delete(requestId);
      this.#sendToChild(
        buildResponseError(requestId, "unavailable", `Method '${method}' has no trusted handler in this session`),
      );
      return;
    }

    this.#pending.set(requestId, { method });

    const authoriseRequest: AuthoriseRequest = {
      principal: this.#options.principal,
      handle: binding.handle,
      action: binding.action,
      resource: binding.resource,
      path: typeof params.path === "string" ? params.path : undefined,
      sha: typeof params.sha === "string" ? params.sha : undefined,
    };

    const operationContext: TrustedOperationContext = {
      sessionId: this.#id,
      principal: this.#options.principal,
      runId: this.#options.runId,
      agentId: this.#options.agentId,
    };

    this.#options.gateway
      .invoke(authoriseRequest, () => handler(params, operationContext))
      .then(
        (value) => {
          if (rpcMessageSize(value) > MAX_RPC_MESSAGE_BYTES) {
            this.#sendToChild(
              buildResponseError(requestId, "response_too_large", "Operation result exceeds the RPC message size limit"),
            );
          } else {
            this.#sendToChild(buildResponseOk(requestId, value));
          }
          this.#finishRequest(requestId);
        },
        (error: unknown) => {
          this.#sendToChild(buildResponseError(requestId, ...this.#mapOperationError(error)));
          this.#finishRequest(requestId);
        },
      );
  }

  #finishRequest(requestId: string): void {
    this.#pending.delete(requestId);
    this.#seenRequestIds.delete(requestId);
  }

  #mapOperationError(error: unknown): [string, string] {
    if (error instanceof CapabilityError) {
      return ["denied", `Capability denied [${error.reason}]`];
    }
    if (error instanceof SandboxTimeoutError) {
      return ["timeout", error.message];
    }
    if (error instanceof SandboxCancelledError) {
      return ["cancelled", error.message];
    }
    // Trusted-side handler failure: no internal detail crosses to the child.
    return ["operation_failed", "The requested operation failed on the trusted side"];
  }

  // -------------------------------------------------------------------------
  // Lifecycle / termination
  // -------------------------------------------------------------------------

  #onChildExit(code: number | null, signal: string | null): void {
    this.#exitCode = code;
    this.#exitSignal = signal;
    this.#processExited = true;
    this.#exitedResolve();

    if (!TERMINAL_SANDBOX_STATES.includes(this.#state)) {
      // Crashed (or exited) before any run-result/run-error arrived.
      const detail = code !== null && code !== 0 ? `exited with code ${code}` : `exited with signal ${signal ?? "unknown"}`;
      this.#terminate("failed", "crash", {
        code: "crash",
        message: `Sandbox process ${detail}`,
      });
    }
    this.#finalize();
  }

  #onChildError(error: Error): void {
    // Spawn/launch-level failure of the child process itself.
    if (TERMINAL_SANDBOX_STATES.includes(this.#state)) return;
    this.#terminate("failed", "launch_failed", {
      code: "launch_failed",
      message: sanitizeRpcText(error.message, 256),
    });
    this.#killChild();
  }

  #onChildDisconnect(): void {
    if (TERMINAL_SANDBOX_STATES.includes(this.#state)) return;
    // IPC teardown precedes the 'exit' event during a normal crash/exit, so
    // give the exit handler a beat to drive the crash path. If the process
    // is STILL running with a severed channel after that, it is an anomaly
    // (the child called process.disconnect() on its own) → fail closed.
    const probe = setTimeout(() => {
      if (TERMINAL_SANDBOX_STATES.includes(this.#state)) return;
      const child = this.#child;
      const stillRunning =
        child !== undefined &&
        child.child.exitCode === null &&
        child.child.signalCode === null;
      if (stillRunning) {
        this.#violate("channel_disconnected_without_result");
      }
      // Otherwise the exit handler owns the outcome.
    }, 200);
    probe.unref?.();
  }

  #onDiagnostic(chunk: Buffer): void {
    this.#diagnostics += chunk.toString("utf8");
    if (this.#diagnostics.length > MAX_DIAGNOSTIC_BYTES * 2) {
      this.#diagnostics = this.#diagnostics.slice(-MAX_DIAGNOSTIC_BYTES);
    }
  }

  /** Protocol violation: hard fail-closed — terminate the session. */
  #violate(violation: string): void {
    this.#terminate("failed", "protocol_violation", {
      code: "protocol_violation",
      message: `Sandbox protocol violation: ${violation}`,
    });
    this.#killChild();
  }

  /**
   * Clean terminal state after a valid final payload: tell the worker to
   * exit (finish), keep the session until the process actually exits.
   */
  #finishGracefully(state: "succeeded" | "failed", reason: SandboxTerminationReason, error?: { readonly code: string; readonly message: string }): void {
    if (TERMINAL_SANDBOX_STATES.includes(this.#state)) return;
    this.#state = state;
    this.#terminationReason = reason;
    this.#error = error;
    this.#endedAt = this.#clock();
    this.#resolveResult({
      sessionId: this.#id,
      state,
      result: state === "succeeded" ? this.#result : undefined,
      error: state === "failed" ? error : undefined,
    });
    this.#rejectPending("session_terminated");
    this.#onLifecycle?.(this, state);
    this.#sendToChild(buildFinishMessage());
    // Failsafe: never leave an orphan if the child ignores the finish ack.
    this.#forceKillTimer = setTimeout(() => this.#killChild(), FORCE_KILL_FALLBACK_MS);
  }

  #terminate(state: SandboxSessionState, reason: SandboxTerminationReason, error: { readonly code: string; readonly message: string }): void {
    if (TERMINAL_SANDBOX_STATES.includes(this.#state)) return;
    this.#state = state;
    this.#terminationReason = reason;
    this.#error = error;
    this.#endedAt = this.#clock();
    this.#resolveResult({
      sessionId: this.#id,
      state,
      result: undefined,
      error,
    });
    this.#rejectPending(error.code === "cancelled" ? "cancelled" : "session_terminated");
    this.#onLifecycle?.(this, state);
  }

  /** Reject in-flight requests with typed error responses (best-effort). */
  #rejectPending(code: string): void {
    for (const [requestId, entry] of [...this.#pending]) {
      this.#sendToChild(
        buildResponseError(requestId, code, `Sandbox session terminated (${entry.method})`),
      );
    }
    this.#pending.clear();
    this.#seenRequestIds.clear();
  }

  #finalize(): void {
    if (this.#timeoutTimer) clearTimeout(this.#timeoutTimer);
    if (this.#graceKillTimer) clearTimeout(this.#graceKillTimer);
    if (this.#forceKillTimer) clearTimeout(this.#forceKillTimer);
    this.#timeoutTimer = undefined;
    this.#graceKillTimer = undefined;
    this.#forceKillTimer = undefined;
    this.#pending.clear();
    this.#seenRequestIds.clear();
    const child = this.#child;
    if (child) {
      child.child.removeAllListeners();
    }
  }

  #killChild(): void {
    const child = this.#child;
    if (child && !this.#processExited) {
      child.kill();
    }
  }

  #sendToChild(message: Serializable): boolean {
    if (this.#options.captureTranscript) {
      this.#pushTranscript(this.#transcriptOut, message);
    }
    if (!this.#child || this.#processExited) return false;
    try {
      return this.#child.send(message);
    } catch {
      return false;
    }
  }

  #pushTranscript(buffer: unknown[], entry: unknown): void {
    if (buffer.length >= MAX_TRANSCRIPT_ENTRIES) {
      buffer.shift();
    }
    buffer.push(entry);
  }
}
