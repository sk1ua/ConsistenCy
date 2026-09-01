import { randomUUID } from "node:crypto";
import type {
  GitHubOauthDevicePollResponse,
  GitHubOauthDeviceStartResponse
} from "@consistency/schema";

/**
 * GitHub OAuth Device Flow (https://docs.github.com/en/apps/oauth-apps/
 * building-oauth-apps/authorizing-oauth-apps#device-flow), used by Settings
 * to obtain a read token without asking the user to create and paste a PAT.
 *
 * Security properties:
 * - The device_code never leaves this process: only the human user_code and
 *   polling metadata are returned from start, and the poll response carries
 *   the access token exactly once before the flow is destroyed.
 * - Flows are single-use and expire with GitHub's own expires_in window.
 * - The server enforces GitHub's polling interval locally: an early poll is
 *   answered "pending" without an outbound call instead of tripping GitHub's
 *   slow_down penalties.
 * - The client id is public by design; the device flow never uses a client
 *   secret, so the API holds no additional GitHub secret for this feature.
 *
 * All network seams are injectable for unit tests (mirrors connectionTest).
 */

const DEVICE_CODE_ENDPOINT = "https://github.com/login/device/code";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const USER_ENDPOINT = "https://api.github.com/user";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_PENALTY_SECONDS = 5;

export interface GitHubOauthDeviceFlowDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  randomId?: () => string;
}

interface PendingFlow {
  flowId: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresAtMs: number;
  lastPollAtMs: number;
}

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export class GitHubOauthDeviceFlowError extends Error {
  constructor(readonly reason: "network" | "rejected" | "malformed") {
    super(`GitHub OAuth device flow failed: ${reason}`);
    this.name = "GitHubOauthDeviceFlowError";
  }
}

function fetchJson(deps: Required<Pick<GitHubOauthDeviceFlowDeps, "fetchImpl">>, url: string, init: RequestInit): Promise<unknown> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return deps.fetchImpl(url, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      // GitHub's REST API rejects requests without a user agent.
      "user-agent": "ConsistenCy",
      ...init.headers
    },
    signal
  }).then(async response => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new GitHubOauthDeviceFlowError("rejected");
    return payload;
  }, () => {
    throw new GitHubOauthDeviceFlowError("network");
  });
}

export class GitHubOauthDeviceFlow {
  private readonly flows = new Map<string, PendingFlow>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly randomId: () => string;

  constructor(private readonly clientId: string, deps: GitHubOauthDeviceFlowDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.randomId = deps.randomId ?? randomUUID;
  }

  get configured(): boolean {
    return this.clientId.trim().length > 0;
  }

  /** Starts a flow; throws GitHubOauthDeviceFlowError on any failure. */
  async start(): Promise<GitHubOauthDeviceStartResponse> {
    const now = this.now();
    const payload = await fetchJson({ fetchImpl: this.fetchImpl }, DEVICE_CODE_ENDPOINT, {
      method: "POST",
      body: new URLSearchParams({ client_id: this.clientId })
    }) as DeviceCodeResponse;

    if (
      typeof payload.device_code !== "string" || payload.device_code === ""
      || typeof payload.user_code !== "string" || payload.user_code === ""
      || typeof payload.verification_uri !== "string" || payload.verification_uri === ""
    ) {
      throw new GitHubOauthDeviceFlowError("malformed");
    }

    const intervalSeconds = typeof payload.interval === "number" && payload.interval > 0
      ? payload.interval
      : DEFAULT_INTERVAL_SECONDS;
    const expiresInSeconds = typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in
      : 900;
    const flowId = this.randomId();

    this.flows.set(flowId, {
      flowId,
      deviceCode: payload.device_code,
      intervalSeconds,
      expiresAtMs: now.getTime() + expiresInSeconds * 1_000,
      // GitHub's polling interval runs from flow creation, so the first early
      // poll is answered locally instead of hitting the token endpoint.
      lastPollAtMs: now.getTime()
    });
    this.pruneExpired(now.getTime());

    return {
      flowId,
      userCode: payload.user_code,
      verificationUri: payload.verification_uri,
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1_000).toISOString(),
      intervalSeconds
    };
  }

  /**
   * Polls one flow. Returns undefined for unknown or already-consumed flow
   * ids; a non-undefined result is schema-shaped and sanitized.
   */
  async poll(flowId: string): Promise<GitHubOauthDevicePollResponse | undefined> {
    const now = this.now();
    const flow = this.flows.get(flowId);
    if (flow === undefined) return undefined;

    if (now.getTime() >= flow.expiresAtMs) {
      this.flows.delete(flowId);
      return { status: "expired" };
    }

    const intervalRemainingMs = flow.lastPollAtMs + flow.intervalSeconds * 1_000 - now.getTime();
    if (intervalRemainingMs > 0) {
      return {
        status: "pending",
        retryAfterSeconds: Math.max(1, Math.ceil(intervalRemainingMs / 1_000))
      };
    }
    flow.lastPollAtMs = now.getTime();

    let payload: TokenResponse;
    try {
      payload = await fetchJson({ fetchImpl: this.fetchImpl }, TOKEN_ENDPOINT, {
        method: "POST",
        body: new URLSearchParams({
          client_id: this.clientId,
          device_code: flow.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        })
      }) as TokenResponse;
    } catch (error) {
      if (error instanceof GitHubOauthDeviceFlowError && error.reason === "network") {
        // Transient: keep the flow so the next poll can retry the exchange.
        return { status: "pending", retryAfterSeconds: flow.intervalSeconds };
      }
      this.flows.delete(flowId);
      return { status: "unavailable" };
    }

    if (typeof payload.access_token === "string" && payload.access_token !== "") {
      this.flows.delete(flowId);
      // Single-use: the token crosses the wire exactly once from here.
      let login: string | undefined;
      try {
        const user = await fetchJson({ fetchImpl: this.fetchImpl }, USER_ENDPOINT, {
          method: "GET",
          headers: { authorization: `Bearer ${payload.access_token}` }
        }) as { login?: string };
        login = typeof user.login === "string" && user.login !== "" ? user.login : undefined;
      } catch {
        login = undefined;
      }
      if (login === undefined) {
        // Identity lookup failed after a successful exchange; the authorization
        // cannot be retried (device codes are single-use), so the user restarts
        // the flow. Nothing partial is persisted anywhere.
        return { status: "unavailable" };
      }
      return { status: "connected", login, publicReadToken: payload.access_token };
    }

    switch (payload.error) {
      case "authorization_pending":
        return { status: "pending", retryAfterSeconds: flow.intervalSeconds };
      case "slow_down":
        flow.intervalSeconds += SLOW_DOWN_PENALTY_SECONDS;
        return { status: "pending", retryAfterSeconds: flow.intervalSeconds };
      case "expired_token":
        this.flows.delete(flowId);
        return { status: "expired" };
      case "access_denied":
        this.flows.delete(flowId);
        return { status: "denied" };
      default:
        this.flows.delete(flowId);
        return { status: "unavailable" };
    }
  }

  private pruneExpired(nowMs: number): void {
    for (const [flowId, flow] of this.flows) {
      if (nowMs >= flow.expiresAtMs) this.flows.delete(flowId);
    }
  }
}
