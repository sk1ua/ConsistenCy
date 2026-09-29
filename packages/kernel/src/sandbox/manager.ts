/**
 * SandboxManager — the Kernel-side owner of child-process execution sessions.
 *
 * Responsibilities (and nothing more):
 *   - validate plugin descriptors and session configuration (fail closed),
 *   - create sessions with SERVER-SIDE identity + capability bindings,
 *   - launch exactly one worker process per session,
 *   - route validated RPC requests into trusted Kernel-facing handlers,
 *   - terminate processes on timeout / cancel / protocol violation / crash,
 *   - emit lifecycle notifications for runtime integration,
 *   - clean up every session resource (no zombie sessions).
 *
 * It is NOT a scheduler, a policy engine, a plugin marketplace, or a package
 * installer. Authorization remains per-call in CapabilityBroker.authorise().
 */

import { randomUUID } from "node:crypto";
import { SYSCALL_DEFINITIONS } from "../syscall/types.js";
import { SandboxLifecycleBus } from "./events.js";
import {
  ForbiddenRpcMethodError,
  InvalidSandboxConfigurationError,
  UnsupportedExecutionDomainError,
} from "./errors.js";
import { SandboxSession } from "./session.js";
import {
  asSandboxSessionId,
  TERMINAL_SANDBOX_STATES,
  type PluginDescriptor,
  type SandboxLaunch,
  type SandboxLaunchOptions,
  type SandboxSessionId,
  type SandboxSessionSnapshot,
  type SandboxSessionState,
} from "./types.js";

const METHOD_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/;

/** Commit actions (dispatch = "intent") can NEVER be exposed through RPC. */
const FORBIDDEN_RPC_ACTIONS: ReadonlySet<string> = new Set(
  SYSCALL_DEFINITIONS.filter((definition) => definition.dispatch === "intent").map(
    (definition) => definition.action,
  ),
);

export interface SandboxManagerOptions {
  readonly clock?: () => number;
  readonly events?: SandboxLifecycleBus;
}

export class SandboxManager {
  readonly #sessions = new Map<SandboxSessionId, SandboxSession>();
  readonly #events?: SandboxLifecycleBus;
  readonly #clock: () => number;

  constructor(options: SandboxManagerOptions = {}) {
    this.#events = options.events;
    this.#clock = options.clock ?? Date.now;
  }

  /**
   * Launch a sandbox session for the given descriptor.
   *
   * Fails closed:
   *   - any execution domain other than "child-process" → synchronous
   *     {@link UnsupportedExecutionDomainError} (no fallback, ever),
   *   - invalid/forbidden bindings → synchronous configuration error,
   *   - process spawn failure → resolved `result` with state "failed".
   */
  launch(descriptor: PluginDescriptor, options: SandboxLaunchOptions): SandboxLaunch {
    // The manager implements ONLY the child-process executor. Any other
    // declared domain (including in-process and future domains) fails closed
    // here — nothing ever silently runs in another domain.
    if (descriptor.executionDomain !== "child-process") {
      throw new UnsupportedExecutionDomainError(descriptor.executionDomain);
    }
    this.#validateConfiguration(options);

    const id = asSandboxSessionId(`sbx_${randomUUID()}`);
    const session = new SandboxSession({
      id,
      descriptor,
      options,
      clock: this.#clock,
      onLifecycle: (current, state) => {
        if (TERMINAL_SANDBOX_STATES.includes(state)) {
          this.#emitTerminal(current, state);
        }
      },
    });
    this.#sessions.set(id, session);
    this.#emit("session.launched", session);
    return { sessionId: id, session, result: session.result };
  }

  #validateConfiguration(options: SandboxLaunchOptions): void {
    for (const [method, binding] of options.capabilities) {
      if (!METHOD_PATTERN.test(method)) {
        throw new InvalidSandboxConfigurationError(`invalid RPC method name '${method}'`);
      }
      if (FORBIDDEN_RPC_ACTIONS.has(method) || FORBIDDEN_RPC_ACTIONS.has(binding.action)) {
        throw new ForbiddenRpcMethodError(method);
      }
      if (!options.operations.has(method)) {
        throw new InvalidSandboxConfigurationError(
          `bound method '${method}' has no trusted handler`,
        );
      }
    }
    // Handlers without bindings are unreachable — refuse to keep config honest.
    for (const method of options.operations.keys()) {
      if (!options.capabilities.has(method)) {
        throw new InvalidSandboxConfigurationError(
          `handler '${method}' has no server-side capability binding`,
        );
      }
    }
  }

  get(id: SandboxSessionId): SandboxSessionSnapshot | undefined {
    return this.#sessions.get(id)?.snapshot();
  }

  /** All sessions, including terminal ones (introspection/history). */
  list(): readonly SandboxSessionSnapshot[] {
    return [...this.#sessions.values()].map((session) => session.snapshot());
  }

  /** Sessions that are not yet in a terminal state. */
  activeSessions(): readonly SandboxSessionSnapshot[] {
    return this.list().filter((snapshot) => !TERMINAL_SANDBOX_STATES.includes(snapshot.state));
  }

  /** Cancel one session. Returns false if unknown or already terminal. */
  cancel(id: SandboxSessionId): boolean {
    const session = this.#sessions.get(id);
    if (!session) return false;
    const state = session.snapshot().state;
    if (TERMINAL_SANDBOX_STATES.includes(state)) return false;
    session.cancel();
    return true;
  }

  /** Shutdown hook: cancel every active session (test cleanup / process exit). */
  terminateAll(): void {
    for (const session of this.#sessions.values()) {
      const state = session.snapshot().state;
      if (!TERMINAL_SANDBOX_STATES.includes(state)) {
        session.cancel();
      }
    }
  }

  #emitTerminal(session: SandboxSession, state: SandboxSessionState): void {
    const type =
      state === "succeeded"
        ? "session.succeeded"
        : state === "failed"
          ? "session.failed"
          : state === "timed_out"
            ? "session.timed_out"
            : "session.cancelled";
    this.#emit(type, session);
  }

  #emit(type: "session.launched" | "session.succeeded" | "session.failed" | "session.timed_out" | "session.cancelled", session: SandboxSession): void {
    if (!this.#events) return;
    const snapshot = session.snapshot();
    this.#events.emit({
      type,
      timestamp: this.#clock(),
      sessionId: snapshot.id,
      state: snapshot.state,
      principalId: snapshot.principalId,
      runId: snapshot.runId,
      agentId: snapshot.agentId,
      terminationReason: snapshot.terminationReason,
    });
  }
}
