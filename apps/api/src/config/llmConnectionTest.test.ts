import { describe, expect, it, vi } from "vitest";
import { testLlmConnection, type LlmConnectionTestDeps } from "./llmConnectionTest";

/**
 * H09: isolated unit tests for the settings LLM connection probe. The fetch
 * seam is always injected — these tests never touch the network.
 */

const SECRET = "sk-draft-secret-value-123";

function okResponse(): Response {
  return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
}

function statusResponse(status: number): Response {
  return new Response(null, { status });
}

function fetchMock(handler: () => Promise<Response> | Response): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("testLlmConnection", () => {
  it("returns connected with bounded metadata when the endpoint answers 200", async () => {
    const { fetchImpl, calls } = fetchMock(() => okResponse());
    const deps: LlmConnectionTestDeps = { fetchImpl, now: () => 1_000 };
    const result = await testLlmConnection({ provider: "deepseek", draftApiKey: SECRET }, deps);
    expect(result).toMatchObject({ status: "connected", provider: "deepseek", latencyMs: 0 });
    expect(result.testedAt).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.deepseek.com/models");
  });

  it("probes the ACTIVE credential only when no draft key is given", async () => {
    const { fetchImpl, calls } = fetchMock(() => okResponse());
    const result = await testLlmConnection({ provider: "openai", activeApiKey: "sk-active" }, { fetchImpl });
    expect(result.status).toBe("connected");
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/models");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-active");
  });

  it("sends the anthropic key via x-api-key headers on the /v1/models path", async () => {
    const { fetchImpl, calls } = fetchMock(() => okResponse());
    await testLlmConnection({ provider: "anthropic", draftApiKey: SECRET }, { fetchImpl });
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("x-api-key")).toBe(SECRET);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("maps 401 and 403 onto auth_failed without reading credential material back", async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = fetchMock(() => statusResponse(status));
      const result = await testLlmConnection({ provider: "deepseek", draftApiKey: SECRET }, { fetchImpl });
      expect(result.status).toBe("auth_failed");
      expect(result.httpStatus).toBe(status);
    }
  });

  it("maps transport failures (refused / DNS / timeout) onto unreachable", async () => {
    const refused = Object.assign(new Error("fetch failed"), { cause: new Error("ECONNREFUSED 127.0.0.1:8317") });
    const { fetchImpl } = fetchMock(() => { throw refused; });
    const result = await testLlmConnection({ provider: "deepseek", draftApiKey: SECRET }, { fetchImpl });
    expect(result.status).toBe("unreachable");

    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.invalid"), {});
    const { fetchImpl: fetchDns } = fetchMock(() => { throw dns; });
    const dnsResult = await testLlmConnection({ provider: "deepseek", draftApiKey: SECRET }, { fetchImpl: fetchDns });
    expect(dnsResult.status).toBe("unreachable");
  });

  it("maps 429 onto rate_limited and 404 onto model_not_found", async () => {
    const { fetchImpl } = fetchMock(() => statusResponse(429));
    expect((await testLlmConnection({ provider: "deepseek", draftApiKey: SECRET }, { fetchImpl })).status).toBe("rate_limited");

    const { fetchImpl: fetch404 } = fetchMock(() => statusResponse(404));
    expect((await testLlmConnection({ provider: "deepseek", draftApiKey: SECRET }, { fetchImpl: fetch404 })).status).toBe("model_not_found");
  });

  it("returns not_configured when no key exists and never probes", async () => {
    const { fetchImpl, calls } = fetchMock(() => okResponse());
    const result = await testLlmConnection({ provider: "deepseek" }, { fetchImpl });
    expect(result.status).toBe("not_configured");
    expect(calls).toHaveLength(0);
  });

  it("rejects non-http(s) or unparseable base URLs as unavailable without probing", async () => {
    const { fetchImpl, calls } = fetchMock(() => okResponse());
    for (const baseUrl of ["not a url", "file:///etc/passwd", "ftp://127.0.0.1/x"]) {
      const result = await testLlmConnection({ provider: "deepseek", baseUrl, draftApiKey: SECRET }, { fetchImpl });
      expect(result.status).toBe("unavailable");
    }
    expect(calls).toHaveLength(0);
  });

  it("falls back to the official endpoint when the base URL is blank", async () => {
    const { fetchImpl, calls } = fetchMock(() => okResponse());
    await testLlmConnection({ provider: "deepseek", baseUrl: "  ", draftApiKey: SECRET }, { fetchImpl });
    expect(calls[0]!.url).toBe("https://api.deepseek.com/models");
  });

  it("uses the draft base URL override for custom gateways", async () => {
    const { fetchImpl, calls } = fetchMock(() => okResponse());
    await testLlmConnection({ provider: "deepseek", baseUrl: "http://127.0.0.1:8317/", draftApiKey: SECRET }, { fetchImpl });
    expect(calls[0]!.url).toBe("http://127.0.0.1:8317/models");
  });

  it("never echoes the key in any response field", async () => {
    const { fetchImpl } = fetchMock(() => okResponse());
    for (const provider of ["deepseek", "openai", "anthropic"]) {
      const result = await testLlmConnection({ provider, draftApiKey: SECRET }, { fetchImpl });
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(Object.keys(result)).toEqual(expect.arrayContaining(["status", "provider", "testedAt"]));
      expect(Object.keys(result)).not.toContain("apiKey");
    }
  });

  it("performs exactly one request per call (no retries)", async () => {
    const { fetchImpl, calls } = fetchMock(() => statusResponse(500));
    await testLlmConnection({ provider: "deepseek", draftApiKey: SECRET }, { fetchImpl });
    expect(calls).toHaveLength(1);
  });
});
