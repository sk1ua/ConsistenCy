/**
 * Versioned Kernel RPC protocol for sandbox sessions.
 *
 * Transport: Node parent/child IPC (`child_process.fork` with an `ipc`
 * channel). Protocol messages travel over the IPC channel; child diagnostics
 * travel over a separate stderr pipe and are never parsed as protocol.
 *
 * Hardening rules enforced on the trusted parent side:
 *   - exact protocol version match (no negotiation),
 *   - strict per-field validation (requestId charset/length, method charset,
 *     params must be a plain object),
 *   - decoded payload size limit (oversized → session terminated),
 *   - duplicate requestId while pending → session terminated,
 *   - unknown method → typed DENY error response (handler never runs),
 *   - every response carries the correlated requestId exactly once.
 *
 * The protocol authenticates NOTHING and authorizes NOTHING. Identity is
 * bound by the parent at session creation; authorization is performed
 * per-call by CapabilityBroker.authorise().
 */

/** Exact protocol version this build speaks. */
export const RPC_PROTOCOL_VERSION = 1;

/** Maximum decoded RPC message size (request, response, or run payload). */
export const MAX_RPC_MESSAGE_BYTES = 256 * 1024;

/**
 * Maximum in-flight requests a session may hold. A flood beyond this is a
 * protocol violation (fail closed) — an untrusted child must not be able to
 * drive unbounded trusted-handler work or queue memory.
 */
export const MAX_PENDING_REQUESTS = 64;

/** Maximum length of a diagnostic (stderr) buffer kept per session. */
export const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

/** Maximum number of transcript entries kept per direction. */
export const MAX_TRANSCRIPT_ENTRIES = 1000;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const METHOD_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/;
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

// ---------------------------------------------------------------------------
// Message shapes (child → parent)
// ---------------------------------------------------------------------------

export interface RpcReadyMessage {
  readonly protocolVersion: typeof RPC_PROTOCOL_VERSION;
  readonly type: "ready";
}

export interface RpcRequestMessage {
  readonly protocolVersion: typeof RPC_PROTOCOL_VERSION;
  readonly type: "request";
  readonly requestId: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface RpcRunResultMessage {
  readonly protocolVersion: typeof RPC_PROTOCOL_VERSION;
  readonly type: "run-result";
  readonly result?: unknown;
}

export interface RpcRunErrorMessage {
  readonly protocolVersion: typeof RPC_PROTOCOL_VERSION;
  readonly type: "run-error";
  readonly error: { readonly code: string; readonly message: string };
}

export type RpcChildMessage =
  | RpcReadyMessage
  | RpcRequestMessage
  | RpcRunResultMessage
  | RpcRunErrorMessage;

// ---------------------------------------------------------------------------
// Message shapes (parent → child)
// ---------------------------------------------------------------------------

export interface RpcResponseOkMessage {
  readonly protocolVersion: typeof RPC_PROTOCOL_VERSION;
  readonly type: "response";
  readonly requestId: string;
  readonly ok: true;
  readonly result?: unknown;
}

export interface RpcResponseErrorMessage {
  readonly protocolVersion: typeof RPC_PROTOCOL_VERSION;
  readonly type: "response";
  readonly requestId: string;
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

export interface RpcCancelMessage {
  readonly protocolVersion: typeof RPC_PROTOCOL_VERSION;
  readonly type: "cancel";
  readonly reason?: string;
}

export interface RpcFinishMessage {
  readonly protocolVersion: typeof RPC_PROTOCOL_VERSION;
  readonly type: "finish";
}

export type RpcParentMessage =
  | RpcResponseOkMessage
  | RpcResponseErrorMessage
  | RpcCancelMessage
  | RpcFinishMessage;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type InboundValidation =
  | { readonly ok: true; readonly kind: "ready"; readonly message: RpcReadyMessage }
  | { readonly ok: true; readonly kind: "request"; readonly message: RpcRequestMessage }
  | { readonly ok: true; readonly kind: "run-result"; readonly message: RpcRunResultMessage }
  | { readonly ok: true; readonly kind: "run-error"; readonly message: RpcRunErrorMessage }
  | { readonly ok: false; readonly violation: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function isValidMethod(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    METHOD_PATTERN.test(value)
  );
}

function isValidErrorCode(value: unknown): value is string {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value);
}

/**
 * Strictly validate one child → parent IPC message. Fail closed on ANY
 * deviation; the session terminates on a violation.
 */
export function validateChildMessage(raw: unknown): InboundValidation {
  if (!isPlainObject(raw)) {
    return { ok: false, violation: "non_object_message" };
  }
  const message = raw as Record<string, unknown>;

  if (message.protocolVersion !== RPC_PROTOCOL_VERSION) {
    return { ok: false, violation: "unsupported_protocol_version" };
  }

  switch (message.type) {
    case "ready":
      return { ok: true, kind: "ready", message: raw as unknown as RpcReadyMessage };

    case "request": {
      if (!isValidRequestId(message.requestId)) {
        return { ok: false, violation: "invalid_request_id" };
      }
      if (!isValidMethod(message.method)) {
        return { ok: false, violation: "invalid_method_name" };
      }
      if (message.params !== undefined && !isPlainObject(message.params)) {
        return { ok: false, violation: "invalid_params" };
      }
      return { ok: true, kind: "request", message: raw as unknown as RpcRequestMessage };
    }

    case "run-result":
      return { ok: true, kind: "run-result", message: raw as unknown as RpcRunResultMessage };

    case "run-error": {
      const error = message.error;
      if (!isPlainObject(error) || !isValidErrorCode(error.code)) {
        return { ok: false, violation: "invalid_run_error" };
      }
      if (typeof error.message !== "string") {
        return { ok: false, violation: "invalid_run_error" };
      }
      return { ok: true, kind: "run-error", message: raw as unknown as RpcRunErrorMessage };
    }

    default:
      return { ok: false, violation: "unknown_message_type" };
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers (parent side)
// ---------------------------------------------------------------------------

/** Approximate decoded message size. Oversized messages fail closed. */
export function rpcMessageSize(message: unknown): number {
  try {
    return JSON.stringify(message)?.length ?? Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Sanitize free-form text before it crosses to an untrusted consumer. */
export function sanitizeRpcText(raw: unknown, maxLength = 512): string {
  const text = typeof raw === "string" ? raw : String(raw);
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, maxLength);
}

export function buildResponseOk(requestId: string, result?: unknown): RpcResponseOkMessage {
  return { protocolVersion: RPC_PROTOCOL_VERSION, type: "response", requestId, ok: true, result };
}

export function buildResponseError(requestId: string, code: string, message: string): RpcResponseErrorMessage {
  return {
    protocolVersion: RPC_PROTOCOL_VERSION,
    type: "response",
    requestId,
    ok: false,
    error: { code, message: sanitizeRpcText(message) },
  };
}

export function buildCancelMessage(reason?: string): RpcCancelMessage {
  return { protocolVersion: RPC_PROTOCOL_VERSION, type: "cancel", reason };
}

export function buildFinishMessage(): RpcFinishMessage {
  return { protocolVersion: RPC_PROTOCOL_VERSION, type: "finish" };
}
