/**
 * Sandbox subsystem errors — all tagged with a stable machine-readable
 * `code` so callers never parse messages for control flow.
 */

/** Base class for every sandbox error. */
export class SandboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
  }
}

/**
 * The declared execution domain has no executor in the SandboxManager.
 * Thrown synchronously by `launch` — there is NEVER a fallback to another
 * domain (fail closed).
 */
export class UnsupportedExecutionDomainError extends SandboxError {
  constructor(domain: string) {
    super(
      "unsupported_execution_domain",
      `Execution domain '${domain}' has no sandbox executor; ` +
      `only 'child-process' is implemented. No fallback to in-process execution is performed.`,
    );
    this.name = "UnsupportedExecutionDomainError";
  }
}

/** The child process could not be spawned (fork/launch failure). */
export class SandboxLaunchError extends SandboxError {
  constructor(detail: string) {
    super("launch_failed", `Sandbox process failed to launch: ${detail}`);
    this.name = "SandboxLaunchError";
  }
}

/**
 * The child sent a message that violates the versioned RPC protocol
 * (wrong shape, wrong version, duplicate requestId, oversized payload…).
 * The session is terminated: malformed traffic fails closed.
 */
export class SandboxProtocolViolationError extends SandboxError {
  readonly violation: string;

  constructor(violation: string) {
    super("protocol_violation", `Sandbox protocol violation: ${violation}`);
    this.name = "SandboxProtocolViolationError";
    this.violation = violation;
  }
}

/** Session-level execution timeout fired; the child was terminated. */
export class SandboxTimeoutError extends SandboxError {
  constructor(timeoutMs: number) {
    super("timeout", `Sandbox execution exceeded the ${timeoutMs}ms session timeout`);
    this.name = "SandboxTimeoutError";
  }
}

/** The session was cancelled by the trusted parent. */
export class SandboxCancelledError extends SandboxError {
  constructor() {
    super("cancelled", "Sandbox session was cancelled");
    this.name = "SandboxCancelledError";
  }
}

/**
 * Registration of an RPC method that maps to an irreversible external
 * commit action is REFUSED outright: untrusted plugins can never reach
 * github.publish / repo.write through the sandbox RPC surface.
 */
export class ForbiddenRpcMethodError extends SandboxError {
  constructor(method: string) {
    super(
      "forbidden_method",
      `RPC method '${method}' maps to a commit action and cannot be exposed to sandbox plugins`,
    );
    this.name = "ForbiddenRpcMethodError";
  }
}

/**
 * Invalid launch configuration (missing handler for a bound method,
 * malformed binding…). Refused before any process is spawned.
 */
export class InvalidSandboxConfigurationError extends SandboxError {
  constructor(detail: string) {
    super("invalid_configuration", `Invalid sandbox configuration: ${detail}`);
    this.name = "InvalidSandboxConfigurationError";
  }
}
