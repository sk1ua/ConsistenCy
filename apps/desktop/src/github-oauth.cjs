const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");
const { createServer } = require("node:http");

const LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/oauth/callback";
const START_PATH = "/oauth/desktop/start";
const COMPLETE_PATH = "/oauth/desktop/complete";
const CANCEL_PATH = "/oauth/desktop/cancel";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const CALLBACK_BODY = "GitHub authorization finished. You can return to ConsistenCy.";

function isNonEmptyString(value, maxLength = 4096) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function constantTimeEquals(left, right) {
  if (!isNonEmptyString(left) || !isNonEmptyString(right)) return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function createPkcePair(randomBytesImpl = randomBytes) {
  const verifier = randomBytesImpl(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

function callbackAddress(address) {
  if (!address || typeof address !== "object" || typeof address.port !== "number" || address.port <= 0) {
    throw new Error("Loopback callback port is unavailable");
  }
  return `http://${LOOPBACK_HOST}:${address.port}${CALLBACK_PATH}`;
}

function isLoopbackAddress(value) {
  return value === LOOPBACK_HOST || value === "::ffff:127.0.0.1";
}

function responseHeaders(contentType = "text/plain; charset=utf-8") {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-content-type-options": "nosniff"
  };
}

function writeCallbackResponse(response, statusCode, body = CALLBACK_BODY) {
  if (response.writableEnded) return;
  response.writeHead(statusCode, {
    ...responseHeaders(),
    "content-length": String(Buffer.byteLength(body, "utf8"))
  });
  response.end(body);
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise(resolve => server.close(() => resolve()));
}

async function fetchJson(fetchImpl, url, init = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "ConsistenCy Desktop",
        ...init.headers
      },
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new Error("GitHub OAuth broker request failed");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("GitHub OAuth broker request was rejected");
  return payload;
}

function parseBrokerUrl(value) {
  if (!isNonEmptyString(value, 2_048)) return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return undefined;
  return parsed;
}

function brokerEndpoint(baseUrl, path) {
  return new URL(path, baseUrl).toString();
}

function safeStatus(status, login) {
  return login === undefined ? { status } : { status, login };
}

function validConnectedResult(value) {
  return value && value.status === "connected"
    && isNonEmptyString(value.login, 39)
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value.login)
    && isNonEmptyString(value.accessToken, 4096);
}

/**
 * Main-process-only Desktop OAuth broker flow.
 *
 * GitHub authorization codes and the broker's client secret never enter this
 * process. The loopback callback carries only the desktop state and a
 * single-use broker handoff code; the access token is returned only to main so
 * it can be written to the OS credential store.
 */
class GitHubOAuthFlow {
  constructor(deps = {}) {
    this.fetchImpl = deps.fetchImpl || fetch;
    this.createServer = deps.createServer || ((handler) => createServer(handler));
    this.randomBytes = deps.randomBytes || randomBytes;
    this.now = deps.now || (() => Date.now());
    this.setTimeout = deps.setTimeout || setTimeout;
    this.clearTimeout = deps.clearTimeout || clearTimeout;
    this.pending = null;
  }

  get active() {
    return this.pending !== null;
  }

  async start({ brokerUrl, openExternal }) {
    await this.cancel();
    const brokerBaseUrl = parseBrokerUrl(brokerUrl);
    if (!brokerBaseUrl || typeof openExternal !== "function") return safeStatus("not_configured");

    const state = this.randomBytes(32).toString("base64url");
    const { verifier, challenge } = createPkcePair(this.randomBytes);
    const server = this.createServer((request, response) => {
      void this.handleCallback(request, response, state);
    });
    const pending = {
      server,
      brokerBaseUrl,
      state,
      verifier,
      challenge,
      redirectUri: undefined,
      resolve: undefined,
      timer: undefined,
      settled: false,
      callbackConsumed: false,
      flowId: undefined
    };
    this.pending = pending;

    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK_HOST, () => resolve());
      });
      const redirectUri = callbackAddress(server.address());
      pending.redirectUri = redirectUri;
      const started = await fetchJson(this.fetchImpl, brokerEndpoint(brokerBaseUrl, START_PATH), {
        method: "POST",
        body: JSON.stringify({
          callbackUrl: redirectUri,
          state,
          codeChallenge: challenge,
          codeChallengeMethod: "S256"
        })
      });
      if (!isNonEmptyString(started?.flowId, 256) || !isNonEmptyString(started?.authorizeUrl, 2_048)) {
        throw new Error("GitHub OAuth broker response is invalid");
      }
      const authorizeUrl = new URL(started.authorizeUrl);
      if (
        authorizeUrl.protocol !== "https:"
        || authorizeUrl.hostname !== "github.com"
        || authorizeUrl.pathname !== "/login/oauth/authorize"
        || authorizeUrl.username
        || authorizeUrl.password
        || authorizeUrl.hash
        || authorizeUrl.searchParams.get("redirect_uri") !== brokerEndpoint(brokerBaseUrl, "/oauth/github/callback")
        || authorizeUrl.searchParams.get("state") !== started.flowId
        || authorizeUrl.searchParams.get("code_challenge") !== challenge
        || authorizeUrl.searchParams.get("code_challenge_method") !== "S256"
      ) throw new Error("GitHub OAuth authorize URL is not secure");
      pending.flowId = started.flowId;

      const result = await new Promise(resolve => {
        pending.resolve = resolve;
        pending.timer = this.setTimeout(() => {
          void this.finish(pending, safeStatus("expired"));
        }, DEFAULT_TIMEOUT_MS);
        Promise.resolve().then(() => openExternal(authorizeUrl.toString())).catch(() => {
          void this.finish(pending, safeStatus("unavailable"));
        });
      });
      return result;
    } catch {
      await this.finish(pending, safeStatus("unavailable"));
      return safeStatus("unavailable");
    }
  }

  async cancel() {
    const pending = this.pending;
    if (!pending) return;
    if (pending.flowId) {
      try {
        await fetchJson(this.fetchImpl, brokerEndpoint(pending.brokerBaseUrl, CANCEL_PATH), {
          method: "POST",
          body: JSON.stringify({ flowId: pending.flowId })
        });
      } catch {
        // Local cancellation still closes the listener if the broker is offline.
      }
    }
    await this.finish(pending, safeStatus("cancelled"));
  }

  async handleCallback(request, response, expectedState) {
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      writeCallbackResponse(response, 403, "Authorization callback rejected.");
      return;
    }
    if (request.method !== "GET") {
      writeCallbackResponse(response, 405, "Authorization callback rejected.");
      return;
    }

    let url;
    try {
      url = new URL(request.url || "/", `http://${LOOPBACK_HOST}`);
    } catch {
      writeCallbackResponse(response, 400, "Authorization callback rejected.");
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      writeCallbackResponse(response, 404, "Authorization callback rejected.");
      return;
    }

    const pending = this.pending;
    if (!pending || pending.state !== expectedState || pending.callbackConsumed) {
      writeCallbackResponse(response, 400, "Authorization callback is no longer active.");
      return;
    }
    pending.callbackConsumed = true;

    const returnedState = url.searchParams.get("state");
    if (!constantTimeEquals(returnedState, expectedState)) {
      writeCallbackResponse(response, 400, "Authorization callback rejected.");
      if (this.pending === pending) await this.finish(pending, safeStatus("unavailable"));
      return;
    }

    const error = url.searchParams.get("error");
    if (error !== null) {
      writeCallbackResponse(response, 200);
      await this.finish(pending, safeStatus(error === "denied" ? "denied" : "unavailable"));
      return;
    }

    const handoffCode = url.searchParams.get("handoff_code");
    if (!isNonEmptyString(handoffCode, 512) || !pending.flowId) {
      writeCallbackResponse(response, 400, "Authorization handoff is missing.");
      await this.finish(pending, safeStatus("unavailable"));
      return;
    }

    writeCallbackResponse(response, 200);
    let result;
    try {
      result = await fetchJson(this.fetchImpl, brokerEndpoint(pending.brokerBaseUrl, COMPLETE_PATH), {
        method: "POST",
        body: JSON.stringify({
          flowId: pending.flowId,
          code: handoffCode,
          codeVerifier: pending.verifier
        })
      });
    } catch {
      result = safeStatus("unavailable");
    }
    if (!validConnectedResult(result)) result = safeStatus(result?.status === "expired" ? "expired" : "unavailable");
    if (this.pending === pending) await this.finish(pending, result);
  }

  async finish(pending, result) {
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (pending.timer !== undefined) this.clearTimeout(pending.timer);
    if (this.pending === pending) this.pending = null;
    await closeServer(pending.server);
    pending.resolve?.(result);
  }
}

module.exports = {
  CALLBACK_PATH,
  COMPLETE_PATH,
  CANCEL_PATH,
  GitHubOAuthFlow,
  LOOPBACK_HOST,
  START_PATH,
  constantTimeEquals,
  createPkcePair,
  isLoopbackAddress,
  parseBrokerUrl
};
