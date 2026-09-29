import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  desktopOAuthCancelRequestSchema,
  desktopOAuthCancelResponseSchema,
  desktopOAuthCompleteRequestSchema,
  desktopOAuthCompleteResponseSchema,
  desktopOAuthStartRequestSchema,
  desktopOAuthStartResponseSchema,
  type DesktopOAuthStartRequest
} from "@consistency/schema";

function pkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

const GITHUB_AUTHORIZE_ENDPOINT = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const GITHUB_USER_ENDPOINT = "https://api.github.com/user";
const CALLBACK_PATH = "/oauth/github/callback";
const DESKTOP_CALLBACK_PATH = "/oauth/callback";
const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type OAuthBrokerStatus = "connected" | "denied" | "expired" | "unavailable";

type BrokerFetch = typeof fetch;

export interface GitHubDesktopOAuthBrokerDeps {
  fetchImpl?: BrokerFetch;
  now?: () => number;
  randomId?: () => string;
  randomSecret?: () => string;
  ttlMs?: number;
}

interface PendingFlow {
  flowId: string;
  callbackUrl: string;
  desktopState: string;
  codeChallenge: string;
  createdAt: number;
  expiresAt: number;
  handoffCode?: string;
  authorizationCode?: string;
  terminalStatus?: Exclude<OAuthBrokerStatus, "connected">;
  callbackConsumed: boolean;
  consumed: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

interface BrokerStartResult {
  flowId: string;
  authorizeUrl: string;
}

interface BrokerCallbackResult {
  redirectUrl: string;
  status: OAuthBrokerStatus;
}

interface BrokerCompleteResult {
  status: "connected";
  login: string;
  accessToken: string;
}

function isCleanText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validLogin(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 39
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value);
}

function parseHttpsUrl(value: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(`${name} must not include a path`);
  }
  return parsed;
}

function validateLoopbackCallback(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("callbackUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("callbackUrl must be an HTTP 127.0.0.1 URL");
  }
  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || parsed.pathname !== DESKTOP_CALLBACK_PATH) {
    throw new Error("callbackUrl must use the exact desktop callback path and a valid port");
  }
  return parsed.toString();
}

function appendQuery(url: string, values: Record<string, string>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(values)) parsed.searchParams.set(key, value);
  return parsed.toString();
}

async function fetchJson(fetchImpl: BrokerFetch, url: string, init: RequestInit): Promise<any> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: {
        accept: "application/json",
        "user-agent": "ConsistenCy OAuth broker",
        ...init.headers
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new Error("GitHub OAuth request failed");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("GitHub OAuth request was rejected");
  return payload;
}

function githubCallbackUrl(baseUrl: URL): string {
  return new URL(CALLBACK_PATH, baseUrl).toString();
}

export class GitHubDesktopOAuthBroker {
  private readonly fetchImpl: BrokerFetch;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly randomSecret: () => string;
  private readonly ttlMs: number;
  private readonly flows = new Map<string, PendingFlow>();
  private readonly brokerBaseUrl: URL;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(input: {
    brokerBaseUrl: string;
    clientId: string;
    clientSecret: string;
    deps?: GitHubDesktopOAuthBrokerDeps;
  }) {
    this.brokerBaseUrl = parseHttpsUrl(input.brokerBaseUrl, "brokerBaseUrl");
    if (!isCleanText(input.clientId, 256) || !isCleanText(input.clientSecret, 512)) {
      throw new Error("GitHub OAuth broker credentials are not configured");
    }
    this.clientId = input.clientId;
    this.clientSecret = input.clientSecret;
    const deps = input.deps ?? {};
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.randomId = deps.randomId ?? randomUUID;
    this.randomSecret = deps.randomSecret ?? (() => randomBytes(32).toString("base64url"));
    this.ttlMs = Math.max(60_000, Math.min(deps.ttlMs ?? DEFAULT_TTL_MS, 30 * 60_000));
  }

  get configured(): boolean {
    return true;
  }

  start(input: unknown): BrokerStartResult {
    const request = desktopOAuthStartRequestSchema.parse(input);
    const callbackUrl = validateLoopbackCallback(request.callbackUrl);
    const now = this.now();
    const flowId = this.randomId();
    const flow: PendingFlow = {
      flowId,
      callbackUrl,
      desktopState: request.state,
      codeChallenge: request.codeChallenge,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      callbackConsumed: false,
      consumed: false
    };
    this.flows.set(flowId, flow);
    flow.expiryTimer = setTimeout(() => this.expireFlow(flow), this.ttlMs);
    flow.expiryTimer.unref?.();
    this.prune(now);

    const authorizeUrl = new URL(GITHUB_AUTHORIZE_ENDPOINT);
    authorizeUrl.searchParams.set("client_id", this.clientId);
    authorizeUrl.searchParams.set("redirect_uri", githubCallbackUrl(this.brokerBaseUrl));
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", "read:user");
    authorizeUrl.searchParams.set("state", flowId);
    authorizeUrl.searchParams.set("code_challenge", request.codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", request.codeChallengeMethod);

    return desktopOAuthStartResponseSchema.parse({
      flowId,
      authorizeUrl: authorizeUrl.toString()
    });
  }

  async githubCallback(input: { state?: string; code?: string; error?: string }): Promise<BrokerCallbackResult> {
    const flow = input.state ? this.flows.get(input.state) : undefined;
    if (!flow) {
      return { redirectUrl: "", status: "expired" };
    }
    if (flow.consumed) {
      return { redirectUrl: "", status: flow.terminalStatus ?? "unavailable" };
    }
    if (this.now() >= flow.expiresAt) {
      this.expireFlow(flow);
      return { redirectUrl: appendQuery(flow.callbackUrl, { state: flow.desktopState, error: "expired" }), status: "expired" };
    }

    if (flow.callbackConsumed) {
      flow.terminalStatus = "unavailable";
      flow.consumed = true;
      delete flow.authorizationCode;
      delete flow.handoffCode;
      if (flow.expiryTimer !== undefined) clearTimeout(flow.expiryTimer);
      flow.expiryTimer = undefined;
      return { redirectUrl: "", status: "unavailable" };
    }
    flow.callbackConsumed = true;
    if (input.error) {
      flow.terminalStatus = input.error === "access_denied" ? "denied" : "unavailable";
      flow.consumed = true;
      delete flow.authorizationCode;
      delete flow.handoffCode;
      if (flow.expiryTimer !== undefined) clearTimeout(flow.expiryTimer);
      flow.expiryTimer = undefined;
      return {
        redirectUrl: appendQuery(flow.callbackUrl, { state: flow.desktopState, error: flow.terminalStatus }),
        status: flow.terminalStatus
      };
    }
    if (!isCleanText(input.code, 512)) {
      flow.terminalStatus = "unavailable";
      flow.consumed = true;
      delete flow.authorizationCode;
      delete flow.handoffCode;
      if (flow.expiryTimer !== undefined) clearTimeout(flow.expiryTimer);
      flow.expiryTimer = undefined;
      return {
        redirectUrl: appendQuery(flow.callbackUrl, { state: flow.desktopState, error: "unavailable" }),
        status: "unavailable"
      };
    }
    flow.authorizationCode = input.code;
    flow.handoffCode = this.randomSecret();
    return {
      redirectUrl: appendQuery(flow.callbackUrl, {
        state: flow.desktopState,
        handoff_code: flow.handoffCode
      }),
      status: "connected"
    };
  }

  async complete(input: unknown): Promise<BrokerCompleteResult> {
    const request = desktopOAuthCompleteRequestSchema.parse(input);
    const flow = this.flows.get(request.flowId);
    if (!flow || flow.consumed || !flow.handoffCode || !flow.authorizationCode) {
      throw new Error("OAuth handoff is unavailable");
    }
    if (this.now() >= flow.expiresAt) {
      this.expireFlow(flow);
      throw new Error("OAuth handoff is unavailable");
    }
    if (!constantTimeEquals(request.code, flow.handoffCode) || !constantTimeEquals(pkceChallenge(request.codeVerifier), flow.codeChallenge)) {
      flow.consumed = true;
      flow.terminalStatus = "unavailable";
      delete flow.handoffCode;
      delete flow.authorizationCode;
      if (flow.expiryTimer !== undefined) clearTimeout(flow.expiryTimer);
      flow.expiryTimer = undefined;
      throw new Error("OAuth handoff is invalid");
    }

    const authorizationCode = flow.authorizationCode;
    flow.consumed = true;
    delete flow.handoffCode;
    delete flow.authorizationCode;
    if (flow.expiryTimer !== undefined) clearTimeout(flow.expiryTimer);
    flow.expiryTimer = undefined;
    try {
      const tokenPayload = await fetchJson(this.fetchImpl, GITHUB_TOKEN_ENDPOINT, {
        method: "POST",
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code: authorizationCode,
          redirect_uri: githubCallbackUrl(this.brokerBaseUrl),
          code_verifier: request.codeVerifier,
          grant_type: "authorization_code"
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" }
      });
      const accessToken = tokenPayload && typeof tokenPayload.access_token === "string" && isCleanText(tokenPayload.access_token, 4_096)
        ? tokenPayload.access_token
        : undefined;
      if (!accessToken) throw new Error("GitHub OAuth token response is invalid");
      const user = await fetchJson(this.fetchImpl, GITHUB_USER_ENDPOINT, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}` }
      });
      if (!validLogin(user?.login)) throw new Error("GitHub OAuth identity response is invalid");
      return desktopOAuthCompleteResponseSchema.parse({ status: "connected", login: user.login, accessToken });
    } catch {
      throw new Error("GitHub OAuth completion failed");
    }
  }

  cancel(input: unknown): { status: "cancelled" } {
    const request = desktopOAuthCancelRequestSchema.parse(input);
    const flow = this.flows.get(request.flowId);
    if (flow) {
      flow.consumed = true;
      flow.terminalStatus = "unavailable";
      delete flow.authorizationCode;
      delete flow.handoffCode;
      if (flow.expiryTimer !== undefined) clearTimeout(flow.expiryTimer);
      flow.expiryTimer = undefined;
    }
    return desktopOAuthCancelResponseSchema.parse({ status: "cancelled" });
  }

  private expireFlow(flow: PendingFlow): void {
    if (flow.consumed) return;
    flow.terminalStatus = "expired";
    flow.consumed = true;
    delete flow.authorizationCode;
    delete flow.handoffCode;
    if (flow.expiryTimer !== undefined) clearTimeout(flow.expiryTimer);
    flow.expiryTimer = undefined;
  }

  private prune(now: number): void {
    for (const [flowId, flow] of this.flows) {
      if (now >= flow.expiresAt) this.expireFlow(flow);
      if (flow.consumed) this.flows.delete(flowId);
    }
  }
}

export const OAUTH_BROKER_CALLBACK_PATH = CALLBACK_PATH;
export const OAUTH_BROKER_DESKTOP_CALLBACK_PATH = DESKTOP_CALLBACK_PATH;
export const OAUTH_BROKER_GITHUB_TOKEN_ENDPOINT = GITHUB_TOKEN_ENDPOINT;
export const OAUTH_BROKER_GITHUB_USER_ENDPOINT = GITHUB_USER_ENDPOINT;
export const OAUTH_BROKER_AUTHORIZE_ENDPOINT = GITHUB_AUTHORIZE_ENDPOINT;
