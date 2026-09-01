import { request } from "node:http";
import { describe, expect, it } from "vitest";
import {
  CALLBACK_PATH,
  CANCEL_PATH,
  COMPLETE_PATH,
  GitHubOAuthFlow,
  START_PATH
} from "./github-oauth.cjs";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function httpRequest(url: URL, method = "GET"): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method }, responseValue => {
      const chunks: Buffer[] = [];
      responseValue.on("data", chunk => chunks.push(Buffer.from(chunk)));
      responseValue.once("end", () => resolve({
        status: responseValue.statusCode,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.once("error", reject);
    req.end();
  });
}

function callbackUrl(redirectUri: string, query: Record<string, string>): URL {
  const redirect = new URL(redirectUri);
  redirect.search = new URLSearchParams(query).toString();
  return redirect;
}

function brokerAuthorize(init: RequestInit): string {
  const body = JSON.parse(String(init.body));
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", "public");
  authorize.searchParams.set("redirect_uri", "https://auth.consistency.example/oauth/github/callback");
  authorize.searchParams.set("state", "flow-123456789012");
  authorize.searchParams.set("code_challenge", body.codeChallenge);
  authorize.searchParams.set("code_challenge_method", body.codeChallengeMethod);
  return authorize.toString();
}

describe("GitHubOAuthFlow", () => {
  it("uses the broker start and complete endpoints, then returns token only to main", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const flow = new GitHubOAuthFlow({
      fetchImpl: async (url: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith(START_PATH)) {
          return response({ flowId: "flow-123456789012", authorizeUrl: brokerAuthorize(init) });
        }
        if (String(url).endsWith(COMPLETE_PATH)) {
          return response({ status: "connected", login: "octocat", accessToken: "gho_test_secret" });
        }
        throw new Error("unexpected broker request");
      }
    });
    let authorizeUrl: URL | undefined;
    const resultPromise = flow.start({
      brokerUrl: "https://auth.consistency.example",
      openExternal: async value => { authorizeUrl = new URL(value); }
    });
    while (!authorizeUrl) await new Promise(resolve => setImmediate(resolve));

    const startRequest = calls.find(call => call.url.endsWith(START_PATH));
    const startBody = JSON.parse(String(startRequest?.init.body));
    const loopbackRedirect = startBody.callbackUrl as string;
    expect(loopbackRedirect).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+${CALLBACK_PATH}$`));

    expect(authorizeUrl.protocol).toBe("https:");
    expect(authorizeUrl.hostname).toBe("github.com");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("public");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("https://auth.consistency.example/oauth/github/callback");
    expect(authorizeUrl.searchParams.get("state")).toBe("flow-123456789012");
    expect(authorizeUrl.searchParams.get("code_challenge")).toBe(startBody.codeChallenge);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const callback = callbackUrl(loopbackRedirect, { handoff_code: "handoff-secret", state: startBody.state });
    const callbackResponse = await httpRequest(callback);
    expect(callbackResponse.status).toBe(200);
    expect(callbackResponse.body).not.toContain("gho_test_secret");
    await expect(resultPromise).resolves.toEqual({ status: "connected", login: "octocat", accessToken: "gho_test_secret" });

    expect(String(startRequest?.init.body)).toContain("callbackUrl");
    expect(String(startRequest?.init.body)).not.toContain("clientSecret");
    const completeRequest = calls.find(call => call.url.endsWith(COMPLETE_PATH));
    expect(String(completeRequest?.init.body)).toContain("handoff-secret");
    expect(String(completeRequest?.init.body)).toContain("codeVerifier");
    expect(String(completeRequest?.init.body)).not.toContain("accessToken");
  });

  it("rejects mismatched state without completing the broker flow", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const flow = new GitHubOAuthFlow({
      fetchImpl: async (url: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith(START_PATH)) return response({ flowId: "flow-123456789012", authorizeUrl: brokerAuthorize(init) });
        throw new Error("unexpected broker request");
      }
    });
    let authorizeUrl: URL | undefined;
    const resultPromise = flow.start({ brokerUrl: "https://auth.consistency.example", openExternal: async value => { authorizeUrl = new URL(value); } });
    while (!authorizeUrl) await new Promise(resolve => setImmediate(resolve));
    const state = authorizeUrl.searchParams.get("state")!;
    const startRequest = calls.find(call => call.url.endsWith(START_PATH));
    const loopbackRedirect = JSON.parse(String(startRequest?.init.body)).callbackUrl as string;
    expect((await httpRequest(callbackUrl(loopbackRedirect, { handoff_code: "never", state: "wrong-state" }))).status).toBe(400);
    await expect(resultPromise).resolves.toEqual({ status: "unavailable" });
    expect(calls.filter(call => call.url.endsWith(COMPLETE_PATH))).toHaveLength(0);
  });

  it("maps broker denial, cancellation and missing configuration to sanitized statuses", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const flow = new GitHubOAuthFlow({
      fetchImpl: async (url: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith(START_PATH)) return response({ flowId: "flow-123456789012", authorizeUrl: brokerAuthorize(init) });
        if (String(url).endsWith(CANCEL_PATH)) return response({ status: "cancelled" });
        throw new Error("unexpected broker request");
      }
    });
    let authorizeUrl: URL | undefined;
    const resultPromise = flow.start({ brokerUrl: "https://auth.consistency.example", openExternal: async value => { authorizeUrl = new URL(value); } });
    while (!authorizeUrl) await new Promise(resolve => setImmediate(resolve));
    const state = authorizeUrl.searchParams.get("state")!;
    const startRequest = calls.find(call => call.url.endsWith(START_PATH));
    const loopbackRedirect = JSON.parse(String(startRequest?.init.body)).callbackUrl as string;
    expect((await httpRequest(callbackUrl(loopbackRedirect, { error: "denied", state: JSON.parse(String(startRequest?.init.body)).state }))).status).toBe(200);
    await expect(resultPromise).resolves.toEqual({ status: "denied" });
    await expect(flow.start({ brokerUrl: "", openExternal: async () => {} })).resolves.toEqual({ status: "not_configured" });
  });

  it("rejects non-loopback, non-GET and wrong-path callbacks without broker completion", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const flow = new GitHubOAuthFlow({
      fetchImpl: async (url: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith(START_PATH)) return response({ flowId: "flow-123456789012", authorizeUrl: brokerAuthorize(init) });
        if (String(url).endsWith(CANCEL_PATH)) return response({ status: "cancelled" });
        throw new Error("unexpected broker request");
      }
    });
    let authorizeUrl: URL | undefined;
    const resultPromise = flow.start({ brokerUrl: "https://auth.consistency.example", openExternal: async value => { authorizeUrl = new URL(value); } });
    while (!authorizeUrl) await new Promise(resolve => setImmediate(resolve));
    const state = authorizeUrl.searchParams.get("state")!;
    const startRequest = calls.find(call => call.url.endsWith(START_PATH));
    const loopbackRedirect = JSON.parse(String(startRequest?.init.body)).callbackUrl as string;
    const requestValue = (remoteAddress: string, method: string, url: string) => ({ method, url, socket: { remoteAddress } });
    const invokeCallback = async (remoteAddress: string, method: string, url: string) => {
      const captured = {
        writableEnded: false,
        status: 0,
        writeHead: (status: number) => { captured.status = status; },
        end: () => { captured.writableEnded = true; }
      };
      await flow.handleCallback(requestValue(remoteAddress, method, url), captured, state);
      return captured.status;
    };
    expect(await invokeCallback("10.0.0.2", "GET", `${CALLBACK_PATH}?handoff_code=code&state=${state}`)).toBe(403);
    expect(await invokeCallback("127.0.0.1", "POST", `${CALLBACK_PATH}?handoff_code=code&state=${state}`)).toBe(405);
    expect(await invokeCallback("127.0.0.1", "GET", `/wrong?handoff_code=code&state=${state}`)).toBe(404);
    await flow.cancel();
    await expect(resultPromise).resolves.toEqual({ status: "cancelled" });
  });
});
