import { describe, expect, it } from "vitest";
import { classifyLlmError, classifyLlmText, LlmProviderError } from "./errors";

describe("classifyLlmError", () => {
  it("classifies 429 as rate_limited whether it arrives as status or text", () => {
    expect(classifyLlmError({ status: 429 })).toEqual({ kind: "rate_limited", httpStatus: 429 });
    expect(classifyLlmError(new Error("HTTP 429: too many requests")))
      .toMatchObject({ kind: "rate_limited", httpStatus: 429 });
    expect(classifyLlmError(new Error("Rate limit reached for requests"))).toMatchObject({ kind: "rate_limited" });
    expect(classifyLlmText("You exceeded your current quota, please check your plan and billing data."))
      .toMatchObject({ kind: "rate_limited" });
    expect(classifyLlmError(new Error("resource_exhausted"))).toMatchObject({ kind: "rate_limited" });
  });

  it("classifies rejected credentials as auth_failed", () => {
    expect(classifyLlmError({ statusCode: 401 })).toEqual({ kind: "auth_failed", httpStatus: 401 });
    expect(classifyLlmError({ httpStatus: 403 })).toEqual({ kind: "auth_failed", httpStatus: 403 });
    expect(classifyLlmError(new Error("Invalid API key provided"))).toMatchObject({ kind: "auth_failed" });
    expect(classifyLlmError(new Error("Unauthorized"))).toMatchObject({ kind: "auth_failed" });
    // Pi's fixed "no authenticated model" selection failure: the credential
    // is the missing piece, not the model id.
    expect(classifyLlmError(new Error("Pi has no authenticated model for provider 'deepseek'")))
      .toMatchObject({ kind: "auth_failed" });
  });

  it("classifies missing models as model_not_found", () => {
    expect(classifyLlmError({ status: 404 })).toEqual({ kind: "model_not_found", httpStatus: 404 });
    expect(classifyLlmError(new Error("The model 'gpt-nope' does not exist"))).toMatchObject({ kind: "model_not_found" });
    expect(classifyLlmError(new Error("model not found: deepseek-v9"))).toMatchObject({ kind: "model_not_found" });
    // Pi's pinned-model resolution failure conflates the two causes; the
    // router treats it as the pinned-model failure it describes.
    expect(classifyLlmError(new Error("Pi model is unavailable or not authenticated")))
      .toMatchObject({ kind: "model_not_found" });
  });

  it("classifies transport failures and 5xx gateways as network", () => {
    expect(classifyLlmError(new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:1"))).toMatchObject({ kind: "network" });
    expect(classifyLlmError(new Error("request timed out after 30s"))).toMatchObject({ kind: "network" });
    expect(classifyLlmError(new Error("getaddrinfo ENOTFOUND api.example.com"))).toMatchObject({ kind: "network" });
    expect(classifyLlmError({ status: 502 })).toEqual({ kind: "network", httpStatus: 502 });
  });

  it("maps everything unmatched to unknown", () => {
    expect(classifyLlmError(new Error("something entirely different happened"))).toEqual({ kind: "unknown" });
    expect(classifyLlmError({ status: 400 })).toEqual({ kind: "unknown", httpStatus: 400 });
    expect(classifyLlmError("plain string failure")).toEqual({ kind: "unknown" });
  });

  it("carries a provider-provided retry hint and never fabricates one", () => {
    expect(classifyLlmError({ status: 429, retryAfterMs: 2_000 }))
      .toEqual({ kind: "rate_limited", httpStatus: 429, retryAfterMs: 2_000 });
    expect(classifyLlmError({ status: 429 }).retryAfterMs).toBeUndefined();
  });

  it("sees through wrapper errors via the cause chain", () => {
    const inner = new LlmProviderError("Pi LLM request failed", { kind: "rate_limited", httpStatus: 429 });
    const wrapped = new Error("Provider deepseek failed schema review after one repair attempt: Pi LLM request failed", { cause: inner });
    expect(classifyLlmError(wrapped)).toEqual({ kind: "rate_limited", httpStatus: 429 });
  });

  it("keeps upstream text out of the typed error message", () => {
    const raw = new Error("Bearer sk-supersecret-value leaked upstream");
    const typed = new LlmProviderError("Pi LLM request failed", { kind: "unknown" }, { cause: raw });
    expect(typed.message).toBe("Pi LLM request failed");
    expect(typed.message).not.toContain("sk-supersecret-value");
    expect(typed.kind).toBe("unknown");
  });
});
