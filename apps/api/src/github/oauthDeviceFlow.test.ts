import { describe, expect, it, vi } from "vitest";
import { GitHubOauthDeviceFlow, GitHubOauthDeviceFlowError } from "./oauthDeviceFlow";

interface FakeResponse {
  status: number;
  body: unknown;
}

function fakeFetch(responses: Record<string, FakeResponse>, calls: Array<{ url: string; init: RequestInit }> = []) {
  return (async (url: string | URL, init: RequestInit = {}) => {
    const key = String(url);
    calls.push({ url: key, init });
    const response = responses[key];
    if (!response) throw new Error(`unexpected fetch ${key}`);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body
    } as Response;
  }) as typeof fetch;
}

const BASE_NOW = 1_700_000_000_000;

function makeFlow(
  responses: Record<string, FakeResponse>,
  calls: Array<{ url: string; init: RequestInit }> = [],
  options: { clientId?: string; stepMs?: number } = {}
) {
  let tick = 0;
  const stepMs = options.stepMs ?? 10_000;
  const flow = new GitHubOauthDeviceFlow(options.clientId ?? "test-client-id", {
    fetchImpl: fakeFetch(responses, calls),
    now: () => new Date(BASE_NOW + (tick++) * stepMs),
    randomId: () => `flow-${tick}`
  });
  return flow;
}

const DEVICE_RESPONSE: FakeResponse = {
  status: 200,
  body: {
    device_code: "DEVICE123",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5
  }
};

describe("GitHubOauthDeviceFlow", () => {
  it("reports configured only with a non-empty client id", () => {
    expect(makeFlow({}, [], { clientId: "abc" }).configured).toBe(true);
    expect(makeFlow({}, [], { clientId: "" }).configured).toBe(false);
  });

  it("starts a flow and never exposes the device code", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const flow = makeFlow({ [DEVICE_URL]: DEVICE_RESPONSE }, calls);

    const started = await flow.start();

    expect(started.userCode).toBe("ABCD-1234");
    expect(started.verificationUri).toBe("https://github.com/login/device");
    expect(started.intervalSeconds).toBe(5);
    expect(started.expiresAt).toBe(new Date(BASE_NOW + 900_000).toISOString());
    expect(JSON.stringify(started)).not.toContain("DEVICE123");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(DEVICE_URL);
    expect(String(calls[0]?.init.body)).toContain("client_id=test-client-id");
  });

  it("throws a sanitized error when GitHub rejects the start request", async () => {
    const flow = makeFlow({ [DEVICE_URL]: { status: 400, body: { error: "incorrect_client_id" } } });
    await expect(flow.start()).rejects.toBeInstanceOf(GitHubOauthDeviceFlowError);
  });

  it("throws a sanitized error on network failure or malformed payloads", async () => {
    const networkFlow = new GitHubOauthDeviceFlow("id", {
      fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch,
      now: () => new Date(BASE_NOW)
    });
    await expect(networkFlow.start()).rejects.toBeInstanceOf(GitHubOauthDeviceFlowError);

    const malformedFlow = makeFlow({ [DEVICE_URL]: { status: 200, body: { device_code: "x" } } });
    await expect(malformedFlow.start()).rejects.toBeInstanceOf(GitHubOauthDeviceFlowError);
  });

  it("returns undefined for unknown flow ids", async () => {
    const flow = makeFlow({});
    await expect(flow.poll("nope")).resolves.toBeUndefined();
  });

  it("answers early polls locally without an outbound call", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let ms = BASE_NOW;
    const flow = new GitHubOauthDeviceFlow("test-client-id", {
      fetchImpl: fakeFetch({
        [DEVICE_URL]: DEVICE_RESPONSE,
        [TOKEN_URL]: { status: 200, body: { error: "authorization_pending" } }
      }, calls),
      now: () => new Date(ms),
      randomId: () => "flow-1"
    });
    const started = await flow.start();

    // +1s: before the 5s interval → local pending, no GitHub call.
    ms += 1_000;
    const early = await flow.poll(started.flowId);
    expect(early).toEqual({ status: "pending", retryAfterSeconds: 4 });
    expect(calls.filter(call => call.url === TOKEN_URL)).toHaveLength(0);

    // +10s total: past the interval → the token endpoint is queried once.
    ms += 9_000;
    const pending = await flow.poll(started.flowId);
    expect(pending).toEqual({ status: "pending", retryAfterSeconds: 5 });
    expect(calls.filter(call => call.url === TOKEN_URL)).toHaveLength(1);
  });

  it("maps slow_down to a longer interval and expired_token/denied to terminal states", async () => {
    const slowCalls: Array<{ url: string; init: RequestInit }> = [];
    const slowFlow = makeFlow({
      [DEVICE_URL]: DEVICE_RESPONSE,
      [TOKEN_URL]: { status: 200, body: { error: "slow_down" } }
    }, slowCalls);
    const started = await slowFlow.start();
    const slowed = await slowFlow.poll(started.flowId);
    expect(slowed).toEqual({ status: "pending", retryAfterSeconds: 10 });
    // The flow survives a slow_down; the next early poll is answered locally.
    await expect(slowFlow.poll(started.flowId)).resolves.toMatchObject({ status: "pending" });

    const expiredFlow = makeFlow({
      [DEVICE_URL]: DEVICE_RESPONSE,
      [TOKEN_URL]: { status: 200, body: { error: "expired_token" } }
    });
    const expiredStart = await expiredFlow.start();
    await expect(expiredFlow.poll(expiredStart.flowId)).resolves.toEqual({ status: "expired" });
    await expect(expiredFlow.poll(expiredStart.flowId)).resolves.toBeUndefined();

    const deniedFlow = makeFlow({
      [DEVICE_URL]: DEVICE_RESPONSE,
      [TOKEN_URL]: { status: 200, body: { error: "access_denied" } }
    });
    const deniedStart = await deniedFlow.start();
    await expect(deniedFlow.poll(deniedStart.flowId)).resolves.toEqual({ status: "denied" });
  });

  it("expires a flow once GitHub's window has passed without contacting GitHub", async () => {
    let ms = BASE_NOW;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const flow = new GitHubOauthDeviceFlow("test-client-id", {
      fetchImpl: fakeFetch({ [DEVICE_URL]: DEVICE_RESPONSE }, calls),
      now: () => new Date(ms),
      randomId: () => "flow-1"
    });
    const started = await flow.start();

    ms += 901_000;
    await expect(flow.poll(started.flowId)).resolves.toEqual({ status: "expired" });
    expect(calls.filter(call => call.url === TOKEN_URL)).toHaveLength(0);
  });

  it("returns the access token exactly once on success and identifies the user", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const flow = makeFlow({
      [DEVICE_URL]: DEVICE_RESPONSE,
      [TOKEN_URL]: { status: 200, body: { access_token: "gho_SECRET", token_type: "bearer" } },
      [USER_URL]: { status: 200, body: { login: "octocat" } }
    }, calls);
    const started = await flow.start();

    const connected = await flow.poll(started.flowId);
    expect(connected).toEqual({
      status: "connected",
      login: "octocat",
      publicReadToken: "gho_SECRET"
    });

    // Single-use: the second poll can neither re-exchange nor leak the token.
    await expect(flow.poll(started.flowId)).resolves.toBeUndefined();
    expect(calls.filter(call => call.url === TOKEN_URL)).toHaveLength(1);
    expect(calls.filter(call => call.url === USER_URL)).toHaveLength(1);
    // The user lookup must carry the bearer token to GitHub, nothing else.
    const userCall = calls.find(call => call.url === USER_URL);
    expect((userCall?.init.headers as Record<string, string>).authorization).toBe("Bearer gho_SECRET");
  });

  it("reports unavailable without partial state when the identity lookup fails", async () => {
    const flow = makeFlow({
      [DEVICE_URL]: DEVICE_RESPONSE,
      [TOKEN_URL]: { status: 200, body: { access_token: "gho_SECRET" } },
      [USER_URL]: { status: 500, body: {} }
    });
    const started = await flow.start();
    await expect(flow.poll(started.flowId)).resolves.toEqual({ status: "unavailable" });
    await expect(flow.poll(started.flowId)).resolves.toBeUndefined();
  });

  it("keeps the flow alive when the token request hits a network error", async () => {
    let ms = BASE_NOW;
    let tokenCalls = 0;
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const flow = new GitHubOauthDeviceFlow("test-client-id", {
      fetchImpl: (async (url: string | URL) => {
        const key = String(url);
        if (key === DEVICE_URL) return ok(DEVICE_RESPONSE.body);
        if (key === TOKEN_URL) {
          tokenCalls += 1;
          if (tokenCalls === 1) throw new TypeError("fetch failed");
          return ok({ access_token: "gho_SECRET" });
        }
        if (key === USER_URL) return ok({ login: "octocat" });
        throw new Error("unexpected fetch");
      }) as typeof fetch,
      now: () => new Date(ms += 10_000),
      randomId: () => "flow-1"
    });
    const started = await flow.start();

    await expect(flow.poll(started.flowId)).resolves.toEqual({ status: "pending", retryAfterSeconds: 5 });
    await expect(flow.poll(started.flowId)).resolves.toMatchObject({ status: "connected" });
    expect(tokenCalls).toBe(2);
  });
});

const DEVICE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
