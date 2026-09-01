import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubDesktopOAuthBroker } from "./oauthBroker";

function pkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

const verifier = "v".repeat(43);
const state = "s".repeat(43);
const codeChallenge = pkceChallenge(verifier);

function response(payload: unknown, ok = true): Response {
  return new Response(JSON.stringify(payload), {
    status: ok ? 200 : 400,
    headers: { "content-type": "application/json" }
  });
}

describe("GitHubDesktopOAuthBroker", () => {
  it("rejects non-loopback and non-canonical callback URLs", () => {
    const broker = new GitHubDesktopOAuthBroker({
      brokerBaseUrl: "https://auth.consistency.example",
      clientId: "product-client",
      clientSecret: "server-only-secret"
    });

    expect(() => broker.start({
      callbackUrl: "http://localhost:43123/oauth/callback",
      state,
      codeChallenge,
      codeChallengeMethod: "S256"
    })).toThrow();
    expect(() => broker.start({
      callbackUrl: "http://127.0.0.1:43123/other",
      state,
      codeChallenge,
      codeChallengeMethod: "S256"
    })).toThrow();
    expect(() => broker.start({
      callbackUrl: "https://127.0.0.1:43123/oauth/callback",
      state,
      codeChallenge,
      codeChallengeMethod: "S256"
    })).toThrow();
  });

  it("keeps the GitHub code and token out of the callback redirect and consumes the handoff once", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const broker = new GitHubDesktopOAuthBroker({
      brokerBaseUrl: "https://auth.consistency.example",
      clientId: "product-client",
      clientSecret: "server-only-secret",
      deps: {
        randomId: () => "flow-123456789012",
        randomSecret: () => "handoff-123456789012345678901234",
        fetchImpl: async (url, init) => {
          requests.push({ url: String(url), init });
          if (String(url).endsWith("/access_token")) return response({ access_token: "gho-secret-token" });
          return response({ login: "octocat" });
        }
      }
    });

    const started = broker.start({
      callbackUrl: "http://127.0.0.1:43123/oauth/callback",
      state,
      codeChallenge,
      codeChallengeMethod: "S256"
    });
    const authorizeUrl = new URL(started.authorizeUrl);
    expect(authorizeUrl.protocol).toBe("https:");
    expect(authorizeUrl.hostname).toBe("github.com");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("product-client");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("https://auth.consistency.example/oauth/github/callback");
    expect(authorizeUrl.searchParams.get("state")).toBe(started.flowId);

    const callback = await broker.githubCallback({ state: started.flowId, code: "github-authorization-code" });
    expect(callback.status).toBe("connected");
    const callbackUrl = new URL(callback.redirectUrl);
    expect(callbackUrl.origin).toBe("http://127.0.0.1:43123");
    expect(callbackUrl.pathname).toBe("/oauth/callback");
    expect(callbackUrl.searchParams.get("state")).toBe(state);
    expect(callbackUrl.searchParams.get("handoff_code")).toBeTruthy();
    expect(callbackUrl.searchParams.has("code")).toBe(false);
    expect(callbackUrl.searchParams.has("access_token")).toBe(false);

    const completed = await broker.complete({
      flowId: started.flowId,
      code: callbackUrl.searchParams.get("handoff_code"),
      codeVerifier: verifier
    });
    expect(completed).toEqual({ status: "connected", login: "octocat", accessToken: "gho-secret-token" });
    await expect(broker.complete({
      flowId: started.flowId,
      code: callbackUrl.searchParams.get("handoff_code"),
      codeVerifier: verifier
    })).rejects.toThrow("OAuth handoff is unavailable");

    const tokenRequest = requests.find(request => request.url.endsWith("/access_token"));
    expect(tokenRequest?.init?.body).toBeInstanceOf(URLSearchParams);
    const tokenBody = tokenRequest?.init?.body as URLSearchParams;
    expect(tokenBody.get("client_secret")).toBe("server-only-secret");
    expect(tokenBody.get("code")).toBe("github-authorization-code");
    expect(tokenBody.get("code_verifier")).toBe(verifier);
    expect(requests.some(request => request.url.endsWith("/user"))).toBe(true);
  });

  it("invalidates a flow on a wrong verifier and returns only fixed cancellation status", async () => {
    const broker = new GitHubDesktopOAuthBroker({
      brokerBaseUrl: "https://auth.consistency.example",
      clientId: "product-client",
      clientSecret: "server-only-secret",
      deps: {
        randomId: () => "flow-123456789012",
        randomSecret: () => "handoff-123456789012345678901234"
      }
    });
    const started = broker.start({
      callbackUrl: "http://127.0.0.1:43123/oauth/callback",
      state,
      codeChallenge,
      codeChallengeMethod: "S256"
    });
    const callback = await broker.githubCallback({ state: started.flowId, code: "github-authorization-code" });
    const handoffCode = new URL(callback.redirectUrl).searchParams.get("handoff_code");
    await expect(broker.complete({
      flowId: started.flowId,
      code: handoffCode,
      codeVerifier: "x".repeat(43)
    })).rejects.toThrow("OAuth handoff is invalid");
    expect(broker.cancel({ flowId: started.flowId })).toEqual({ status: "cancelled" });
  });
});
