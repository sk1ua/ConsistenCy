/**
 * Sandbox worker bootstrap — the ONLY code path that runs inside the
 * untrusted child process.
 *
 * Plain ESM JavaScript with ZERO imports from the Kernel package. The child
 * receives:
 *   - an explicit, allowlisted environment (see env.ts on the parent side),
 *   - exactly one plugin entrypoint path as argv[2],
 *   - an IPC channel speaking the versioned RPC protocol,
 *   - stderr as the (sanitized, size-capped, never-parsed) diagnostic channel.
 *
 * The child holds NO raw capability handle, NO credential, and NO reference
 * to parent memory. Every mediated call is a request the parent authorises
 * through the Kernel; the child only ever sees results or typed errors.
 */

import { pathToFileURL } from "node:url";

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 256 * 1024;
const METHOD_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/;

const hasIpc = typeof process.send === "function";
const entrypoint = process.argv[2];

/** Child-side logger: stderr ONLY (stdout is ignored by the parent). */
function log(...parts) {
  try {
    process.stderr.write(`[sandbox-worker] ${parts.map(String).join(" ")}\n`);
  } catch {
    /* diagnostics must never break the protocol */
  }
}

function send(message) {
  if (!hasIpc) return false;
  try {
    process.send(message);
    return true;
  } catch {
    return false;
  }
}

function messageSize(message) {
  try {
    return JSON.stringify(message).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function rpcError(code, message) {
  return { code: String(code), message: String(message), isRpcError: true };
}

function sendRunError(code, message) {
  const error = {
    code: String(code).slice(0, 64).toLowerCase(),
    message: String(message).slice(0, 1024),
  };
  send({ protocolVersion: PROTOCOL_VERSION, type: "run-error", error });
}

// ---------------------------------------------------------------------------
// RPC client (the only bridge between plugin code and the parent Kernel)
// ---------------------------------------------------------------------------

const pending = new Map();
let cancelled = false;
let finished = false;
let finishResolve = null;
const finishSignal = new Promise((resolve) => {
  finishResolve = resolve;
});

function rejectAllPending(error) {
  for (const entry of pending.values()) {
    entry.reject(error);
  }
  pending.clear();
}

function call(method, params) {
  return new Promise((resolve, reject) => {
    if (cancelled || finished) {
      reject(rpcError("cancelled", "Sandbox session is no longer accepting operations"));
      return;
    }
    if (typeof method !== "string" || !METHOD_PATTERN.test(method)) {
      reject(rpcError("invalid_method", "Malformed RPC method name"));
      return;
    }
    const requestId = crypto.randomUUID();
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: "request",
      requestId,
      method,
      params: params === undefined ? undefined : params,
    };
    if (messageSize(message) > MAX_MESSAGE_BYTES) {
      reject(rpcError("oversized_request", "RPC request exceeds the message size limit"));
      return;
    }
    pending.set(requestId, { resolve, reject });
    if (!send(message)) {
      pending.delete(requestId);
      reject(rpcError("send_failed", "IPC channel is not available"));
    }
  });
}

function onParentMessage(raw) {
  if (!raw || typeof raw !== "object" || raw.protocolVersion !== PROTOCOL_VERSION) {
    return;
  }
  if (raw.type === "response") {
    const entry = pending.get(raw.requestId);
    if (!entry) return; // unknown/duplicate response — ignore
    pending.delete(raw.requestId);
    if (raw.ok === true) {
      entry.resolve(raw.result);
    } else {
      const error = raw.error;
      entry.reject(
        rpcError(
          typeof error?.code === "string" ? error.code : "rpc_error",
          typeof error?.message === "string" ? error.message : "RPC operation failed",
        ),
      );
    }
  } else if (raw.type === "cancel") {
    cancelled = true;
    rejectAllPending(rpcError("cancelled", "Sandbox session was cancelled by the parent"));
  } else if (raw.type === "finish") {
    finishResolve();
  }
}

if (hasIpc) {
  process.on("message", onParentMessage);
}

process.on("disconnect", () => {
  cancelled = true;
  finished = true;
  rejectAllPending(rpcError("disconnected", "IPC channel closed by the parent"));
  finishResolve();
});

// ---------------------------------------------------------------------------
// Mediated plugin surface — the ONLY API the plugin receives
// ---------------------------------------------------------------------------

const context = Object.freeze({
  repository: Object.freeze({
    read: (params) => call("repo.read", params),
  }),
  evidence: Object.freeze({
    read: (params) => call("evidence.read", params),
  }),
  ast: Object.freeze({
    query: (params) => call("ast.query", params),
  }),
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function settle(exitCode) {
  if (!hasIpc) {
    process.exit(exitCode);
  }
  await finishSignal;
  process.exit(exitCode);
}

async function main() {
  if (!entrypoint) {
    sendRunError("entrypoint_missing", "No plugin entrypoint path was provided to the sandbox worker");
    return settle(1);
  }

  let module;
  try {
    module = await import(pathToFileURL(entrypoint).href);
  } catch (error) {
    log("entrypoint load failed:", error && error.message ? error.message : String(error));
    sendRunError("entrypoint_load_failed", "Unable to load the plugin entrypoint");
    return settle(1);
  }

  const plugin = module && module.default ? module.default : module;
  if (!plugin || typeof plugin.run !== "function") {
    sendRunError("plugin_contract", "Plugin entrypoint must export a run(ctx) function");
    return settle(1);
  }

  send({ protocolVersion: PROTOCOL_VERSION, type: "ready" });
  log("plugin loaded, running");

  try {
    const result = await plugin.run(context);

    let sanitized;
    try {
      const serialized = JSON.stringify(result);
      if (serialized.length > MAX_MESSAGE_BYTES) {
        sendRunError("result_too_large", "Plugin result exceeds the RPC message size limit");
        return settle(1);
      }
      sanitized = JSON.parse(serialized);
    } catch {
      sendRunError("result_serialization", "Plugin result must be JSON-serializable");
      return settle(1);
    }

    send({ protocolVersion: PROTOCOL_VERSION, type: "run-result", result: sanitized });
    log("plugin completed");
    return settle(0);
  } catch (error) {
    log("plugin failed:", error && error.message ? error.message : String(error));
    const code = error && typeof error.code === "string" ? error.code : "plugin_error";
    sendRunError(code, error && error.message ? error.message : "Plugin execution failed");
    return settle(1);
  }
}

main().catch((error) => {
  log("fatal:", error && error.message ? error.message : String(error));
  sendRunError("worker_fatal", "Sandbox worker failed unexpectedly");
  settle(1);
});
