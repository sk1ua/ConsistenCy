import { describe, expect, it } from "vitest";
import type { LlmConnectionProfile } from "@consistency/schema";
import { LlmProviderError } from "./errors";
import { LlmRoutingError, RoutedLLMProvider } from "./routing";
import type { LLMProvider, StructuredInvocation, StructuredResult } from "./types";

/** Scripted single-profile double: each call consumes the next script step. */
function scriptedProvider(
  name: string,
  script: Array<"ok" | Error | ((signal?: AbortSignal) => Promise<never> | never)>,
  model?: string
): LLMProvider & { calls: () => number } {
  let calls = 0;
  const step = () => script[Math.min(calls, script.length - 1)];
  const provider: LLMProvider = {
    name,
    ...(model !== undefined ? { model } : {}),
    async invokeWithSchema<T>(request: StructuredInvocation<T>) {
      const action = step();
      calls += 1;
      if (typeof action === "function") await action(request.signal);
      if (action instanceof Error) throw action;
      return { data: { servedBy: name } } as StructuredResult<T>;
    },
    async generateStructuredFinding() {
      const action = step();
      calls += 1;
      if (typeof action === "function") await action();
      if (action instanceof Error) throw action;
      return { data: [] };
    },
    async generateAgentRun() {
      const action = step();
      calls += 1;
      if (typeof action === "function") await action();
      if (action instanceof Error) throw action;
      return { data: { findings: [] } };
    },
    async generateSummary() {
      const action = step();
      calls += 1;
      if (typeof action === "function") await action();
      if (action instanceof Error) throw action;
      return { data: { summary: `served by ${name}` } };
    }
  };
  return { ...provider, calls: () => calls };
}

function rateLimited(): Error {
  return new LlmProviderError("Pi LLM request failed", { kind: "rate_limited", httpStatus: 429 });
}

function authFailed(): Error {
  return new LlmProviderError("Pi LLM request failed", { kind: "auth_failed", httpStatus: 401 });
}

function networkFailed(): Error {
  return new LlmProviderError("Pi LLM request failed", { kind: "network" });
}

function profile(id: string, provider: string, model?: string): LlmConnectionProfile {
  return { id, provider, enabled: true, ...(model ? { model } : {}) };
}

function routed(
  chain: LlmConnectionProfile[],
  spawns: Map<string, LLMProvider>,
  selected: LlmConnectionProfile = chain[0] ?? profile("primary", "deepseek", "deepseek-v4-flash")
): RoutedLLMProvider {
  return new RoutedLLMProvider({
    selected,
    chain,
    configRevision: "cfgrev-test",
    spawn: candidate => spawns.get(candidate.id)
  });
}

async function summaryError(provider: RoutedLLMProvider, signal?: AbortSignal): Promise<unknown> {
  return provider.generateSummary({
    systemPrompt: "system",
    userPrompt: "user",
    ...(signal ? { signal } : {})
  }).then(
    () => undefined,
    error => error
  );
}

describe("RoutedLLMProvider", () => {
  it("walks the configured chain in order and pins the first profile that succeeds", async () => {
    const primary = scriptedProvider("deepseek", [rateLimited()], "deepseek-v4-flash");
    const fallback = scriptedProvider("openai", ["ok"], "gpt-4.1-mini");
    const provider = routed(
      [profile("primary", "deepseek", "deepseek-v4-flash"), profile("fallback-1", "openai", "gpt-4.1-mini")],
      new Map([["primary", primary], ["fallback-1", fallback]])
    );

    const result = await provider.generateSummary({ systemPrompt: "system", userPrompt: "user" });
    expect(result.data).toEqual({ summary: "served by openai" });

    // 已选模型与实际使用模型 both visible on the route record.
    expect(provider.route.selected).toEqual({ profileId: "primary", provider: "deepseek", model: "deepseek-v4-flash" });
    expect(provider.route.used).toEqual({ profileId: "fallback-1", provider: "openai", model: "gpt-4.1-mini" });
    expect(provider.route.attempts).toHaveLength(1);
    expect(provider.route.attempts[0]).toMatchObject({
      profileId: "primary",
      provider: "deepseek",
      errorKind: "rate_limited",
      httpStatus: 429,
      quota: "unknown"
    });
    expect(provider.route.fallbackCount).toBe(1);
    expect(provider.name).toBe("openai");
    expect(provider.model).toBe("gpt-4.1-mini");

    // Once pinned, later calls go straight to the used profile.
    await provider.generateSummary({ systemPrompt: "system", userPrompt: "user" });
    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(2);
  });

  it("falls back in chain order and ends in the canonical error when every profile fails", async () => {
    const first = scriptedProvider("deepseek", [rateLimited()], "deepseek-v4-flash");
    const second = scriptedProvider("openai", [authFailed()], "gpt-4.1-mini");
    const third = scriptedProvider("anthropic", [networkFailed()]);
    const provider = routed(
      [
        profile("primary", "deepseek", "deepseek-v4-flash"),
        profile("fallback-1", "openai", "gpt-4.1-mini"),
        profile("fallback-2", "anthropic")
      ],
      new Map([["primary", first], ["fallback-1", second], ["fallback-2", third]])
    );

    const error = await summaryError(provider);
    expect(error).toBeInstanceOf(LlmRoutingError);
    const routingError = error as LlmRoutingError;
    expect(routingError.code).toBe("LLM_NO_AVAILABLE_PROFILE");
    expect(routingError.message).toContain("3 个连接档均失败");
    expect(routingError.message).toContain("primary(deepseek/deepseek-v4-flash)=rate_limited(429)，额度未知");
    expect(routingError.message).toContain("fallback-1(openai/gpt-4.1-mini)=auth_failed(401)");
    expect(routingError.message).toContain("fallback-2(anthropic)=network");
    expect(routingError.route.attempts.map(attempt => attempt.errorKind)).toEqual([
      "rate_limited",
      "auth_failed",
      "network"
    ]);
    expect(routingError.route.fallbackCount).toBe(2);
    expect(routingError.route.used).toBeUndefined();
    expect(provider.route.used).toBeUndefined();
  });

  it("shares one bounded fallback budget across the whole run", async () => {
    const first = scriptedProvider("deepseek", [rateLimited()], "deepseek-v4-flash");
    const second = scriptedProvider("openai", ["ok", authFailed()], "gpt-4.1-mini");
    const third = scriptedProvider("anthropic", ["ok", networkFailed(), networkFailed()]);
    const provider = routed(
      [
        profile("primary", "deepseek", "deepseek-v4-flash"),
        profile("fallback-1", "openai", "gpt-4.1-mini"),
        profile("fallback-2", "anthropic")
      ],
      new Map([["primary", first], ["fallback-1", second], ["fallback-2", third]])
    );

    // Call 1: primary rate-limited → one fallback → openai serves.
    await provider.generateSummary({ systemPrompt: "system", userPrompt: "user" });
    expect(provider.route.fallbackCount).toBe(1);

    // Call 2: openai now fails → the second (and last) fallback reaches anthropic.
    await provider.generateSummary({ systemPrompt: "system", userPrompt: "user" });
    expect(provider.route.fallbackCount).toBe(2);
    expect(provider.route.used).toMatchObject({ profileId: "fallback-2", provider: "anthropic" });

    // Call 3: the shared budget is exhausted — the underlying failure
    // propagates unchanged and no further fallback happens.
    const error = await summaryError(provider);
    expect(error).toBeInstanceOf(LlmProviderError);
    expect((error as LlmProviderError).kind).toBe("network");
    expect(provider.route.fallbackCount).toBe(2);
    expect(provider.route.attempts).toHaveLength(2);
    expect(third.calls()).toBe(2);
  });

  it("never falls back when the run is cancelled before dispatch", async () => {
    const controller = new AbortController();
    const reason = new Error("user cancelled the review");
    controller.abort(reason);
    const primary = scriptedProvider("deepseek", [rateLimited()], "deepseek-v4-flash");
    const fallback = scriptedProvider("openai", ["ok"], "gpt-4.1-mini");
    const provider = routed(
      [profile("primary", "deepseek", "deepseek-v4-flash"), profile("fallback-1", "openai", "gpt-4.1-mini")],
      new Map([["primary", primary], ["fallback-1", fallback]])
    );

    const error = await summaryError(provider, controller.signal);
    expect(error).toBe(reason);
    expect(primary.calls()).toBe(0);
    expect(fallback.calls()).toBe(0);
    expect(provider.route.attempts).toHaveLength(0);
    expect(provider.route.fallbackCount).toBe(0);
    expect(provider.route.used).toBeUndefined();
  });

  it("never falls back when cancellation lands during an in-flight attempt", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled mid-call");
    const primary = scriptedProvider("deepseek", [signal => {
      controller.abort(reason);
      throw reason;
    }], "deepseek-v4-flash");
    const fallback = scriptedProvider("openai", ["ok"], "gpt-4.1-mini");
    const provider = routed(
      [profile("primary", "deepseek", "deepseek-v4-flash"), profile("fallback-1", "openai", "gpt-4.1-mini")],
      new Map([["primary", primary], ["fallback-1", fallback]])
    );

    const error = await summaryError(provider, controller.signal);
    expect(error).toBe(reason);
    expect(fallback.calls()).toBe(0);
    expect(provider.route.attempts).toHaveLength(0);
    expect(provider.route.fallbackCount).toBe(0);
  });

  it("returns the canonical error when no enabled profile exists", async () => {
    const disabledSelected: LlmConnectionProfile = { id: "primary", provider: "deepseek", model: "deepseek-v4-flash", enabled: false };
    const provider = new RoutedLLMProvider({
      selected: disabledSelected,
      chain: [],
      configRevision: "cfgrev-test",
      spawn: () => undefined
    });

    for (const outcome of [
      await summaryError(provider),
      await provider.generateStructuredFinding({ agent: "Security", systemPrompt: "s", userPrompt: "u" }).then(() => undefined, error => error),
      await provider.generateAgentRun({ agent: "Security", systemPrompt: "s", userPrompt: "u" }).then(() => undefined, error => error)
    ]) {
      expect(outcome).toBeInstanceOf(LlmRoutingError);
      expect((outcome as LlmRoutingError).code).toBe("LLM_NO_AVAILABLE_PROFILE");
      expect((outcome as LlmRoutingError).message).toContain("没有可用的模型连接档");
    }
    expect(provider.route.attempts).toHaveLength(0);
    expect(provider.route.selected).toEqual({ profileId: "primary", provider: "deepseek", model: "deepseek-v4-flash" });
  });

  it("treats an unspawnable profile as a failed attempt and keeps walking", async () => {
    const fallback = scriptedProvider("openai", ["ok"], "gpt-4.1-mini");
    const provider = routed(
      [profile("primary", "deepseek", "deepseek-v4-flash"), profile("fallback-1", "openai", "gpt-4.1-mini")],
      new Map([["fallback-1", fallback]])
    );
    const result = await provider.generateSummary({ systemPrompt: "system", userPrompt: "user" });
    expect(result.data).toEqual({ summary: "served by openai" });
    expect(provider.route.attempts).toHaveLength(1);
    expect(provider.route.attempts[0]).toMatchObject({ profileId: "primary", errorKind: "unknown" });
    expect(provider.route.used).toMatchObject({ profileId: "fallback-1" });
  });

  it("reports provider-provided retry hints and keeps quota unknown", async () => {
    const primary = scriptedProvider("deepseek", [rateLimitedWithRetry()], "deepseek-v4-flash");
    const fallback = scriptedProvider("openai", ["ok"], "gpt-4.1-mini");
    const provider = routed(
      [profile("primary", "deepseek", "deepseek-v4-flash"), profile("fallback-1", "openai", "gpt-4.1-mini")],
      new Map([["primary", primary], ["fallback-1", fallback]])
    );
    await provider.generateSummary({ systemPrompt: "system", userPrompt: "user" });
    expect(provider.route.attempts[0]).toMatchObject({ retryAfterMs: 2_000, quota: "unknown" });
  });
});

function rateLimitedWithRetry(): Error {
  return new LlmProviderError("Pi LLM request failed", { kind: "rate_limited", httpStatus: 429, retryAfterMs: 2_000 });
}
