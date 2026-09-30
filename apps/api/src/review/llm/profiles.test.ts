import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config/env";
import { buildLlmProfileChain, computeLlmConfigRevision, parseLlmFallbackEntries, profileEnabled } from "./profiles";

// A non-empty marker stands in for a configured key; the marker is asserted
// to never leak into the config revision.
const SECRET_MARKER = "profile-test-key-marker";

const baseConfig = {
  LLM_PROVIDER: "deepseek",
  DEEPSEEK_API_KEY: SECRET_MARKER,
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  OPENAI_API_KEY: "",
  OPENAI_MODEL: "gpt-4.1-mini",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_MODEL: "",
  LLM_API_KEY: "",
  LLM_MODEL: "",
  LLM_FALLBACK_CHAIN: "",
  piConfigDir: ".consistency"
} as unknown as AppConfig;

const configWith = (overrides: Partial<AppConfig>): AppConfig => ({ ...baseConfig, ...overrides });

describe("profileEnabled", () => {
  it("requires a key for ConsistenCy-managed providers", () => {
    expect(profileEnabled(configWith({}), "deepseek")).toBe(true);
    expect(profileEnabled(configWith({ DEEPSEEK_API_KEY: "" }), "deepseek")).toBe(false);
    expect(profileEnabled(configWith({ DEEPSEEK_API_KEY: "" }), "openai")).toBe(false);
    expect(profileEnabled(configWith({ OPENAI_API_KEY: "" }), "anthropic")).toBe(false);
    // The generic LLM_API_KEY is scoped to the selected provider.
    expect(profileEnabled(configWith({ DEEPSEEK_API_KEY: "", LLM_API_KEY: SECRET_MARKER }), "deepseek")).toBe(true);
    expect(profileEnabled(configWith({ LLM_PROVIDER: "xiaomi", DEEPSEEK_API_KEY: "", LLM_API_KEY: SECRET_MARKER }), "deepseek")).toBe(false);
  });

  it("keeps Pi-managed providers enabled — their auth cannot be verified statically", () => {
    expect(profileEnabled(configWith({}), "moonshotai")).toBe(true);
    expect(profileEnabled(configWith({}), "openrouter")).toBe(true);
  });
});

describe("parseLlmFallbackEntries", () => {
  it("parses ordered provider and provider:model entries", () => {
    expect(parseLlmFallbackEntries("openai:gpt-4.1-mini, anthropic:claude-opus-4-5")).toEqual([
      { provider: "openai", model: "gpt-4.1-mini" },
      { provider: "anthropic", model: "claude-opus-4-5" }
    ]);
    expect(parseLlmFallbackEntries("openai")).toEqual([{ provider: "openai" }]);
    expect(parseLlmFallbackEntries("openai; anthropic")).toEqual([
      { provider: "openai" },
      { provider: "anthropic" }
    ]);
  });

  it("keeps slashes inside model ids (only the first colon separates)", () => {
    expect(parseLlmFallbackEntries("openrouter:anthropic/claude-sonnet-4.5")).toEqual([
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" }
    ]);
  });

  it("drops invalid provider ids and duplicates", () => {
    expect(parseLlmFallbackEntries("not a provider!, openai, openai, , openai:gpt-x")).toEqual([
      { provider: "openai" },
      { provider: "openai", model: "gpt-x" }
    ]);
    expect(parseLlmFallbackEntries(undefined)).toEqual([]);
    expect(parseLlmFallbackEntries("   ")).toEqual([]);
  });
});

describe("buildLlmProfileChain", () => {
  it("resolves the active profile from existing settings", () => {
    const chain = buildLlmProfileChain({ config: baseConfig, selected: { provider: "deepseek", model: "deepseek-v4-flash" } });
    expect(chain.selected).toEqual({
      id: "primary",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      enabled: true
    });
    expect(chain.chain).toHaveLength(1);
    expect(chain.fallbackConfigured).toBe(false);
  });

  it("records the selected profile even when it is disabled and routes around it", () => {
    const chain = buildLlmProfileChain({
      config: configWith({ DEEPSEEK_API_KEY: "", OPENAI_API_KEY: SECRET_MARKER, LLM_FALLBACK_CHAIN: "openai:gpt-4.1-mini" }),
      selected: { provider: "deepseek", model: "deepseek-v4-flash" }
    });
    expect(chain.selected?.enabled).toBe(false);
    expect(chain.chain.map(profile => profile.id)).toEqual(["fallback-1"]);
    expect(chain.chain[0]).toMatchObject({ provider: "openai", model: "gpt-4.1-mini", enabled: true });
    expect(chain.fallbackConfigured).toBe(true);
  });

  it("builds the enabled fallback chain in configured order", () => {
    const chain = buildLlmProfileChain({
      config: configWith({
        OPENAI_API_KEY: SECRET_MARKER,
        ANTHROPIC_API_KEY: SECRET_MARKER,
        LLM_FALLBACK_CHAIN: "openai:gpt-4.1-mini, anthropic:claude-opus-4-5"
      }),
      selected: { provider: "deepseek", model: "deepseek-v4-flash" }
    });
    expect(chain.chain.map(profile => [profile.id, profile.provider, profile.model])).toEqual([
      ["primary", "deepseek", "deepseek-v4-flash"],
      ["fallback-1", "openai", "gpt-4.1-mini"],
      ["fallback-2", "anthropic", "claude-opus-4-5"]
    ]);
  });

  it("bounds the chain to the selected profile plus two fallbacks", () => {
    const chain = buildLlmProfileChain({
      config: configWith({
        OPENAI_API_KEY: SECRET_MARKER,
        ANTHROPIC_API_KEY: SECRET_MARKER,
        LLM_FALLBACK_CHAIN: "openai, anthropic, google, moonshotai"
      }),
      selected: { provider: "deepseek", model: "deepseek-v4-flash" }
    });
    expect(chain.chain).toHaveLength(3);
    expect(chain.chain.map(profile => profile.provider)).toEqual(["deepseek", "openai", "anthropic"]);
  });

  it("skips entries that duplicate the selected profile and reports invalid ones", () => {
    const chain = buildLlmProfileChain({
      config: configWith({ OPENAI_API_KEY: SECRET_MARKER, LLM_FALLBACK_CHAIN: "deepseek:deepseek-v4-flash, definitely not an id, openai" }),
      selected: { provider: "deepseek", model: "deepseek-v4-flash" }
    });
    expect(chain.chain.map(profile => profile.provider)).toEqual(["deepseek", "openai"]);
    expect(chain.ignoredEntries).toEqual(["definitely not an id"]);
  });

  it("records baseUrl only where settings provide one", () => {
    const chain = buildLlmProfileChain({
      config: configWith({ OPENAI_API_KEY: SECRET_MARKER, LLM_FALLBACK_CHAIN: "openai:gpt-4.1-mini" }),
      selected: { provider: "deepseek", model: "deepseek-v4-flash" }
    });
    expect(chain.chain[0]?.baseUrl).toBe("https://api.deepseek.com");
    expect(chain.chain[1]?.baseUrl).toBeUndefined();
  });

  it("returns an empty chain when no provider is selected", () => {
    expect(buildLlmProfileChain({ config: baseConfig })).toEqual({
      chain: [],
      candidates: [],
      fallbackConfigured: false,
      ignoredEntries: []
    });
  });
});

describe("computeLlmConfigRevision", () => {
  it("is deterministic for the same routing configuration", () => {
    const chain = buildLlmProfileChain({
      config: configWith({ LLM_FALLBACK_CHAIN: "openai:gpt-4.1-mini" }),
      selected: { provider: "deepseek", model: "deepseek-v4-flash" }
    });
    expect(computeLlmConfigRevision(baseConfig, chain.candidates))
      .toBe(computeLlmConfigRevision(baseConfig, chain.candidates));
  });

  it("changes when the model pin, the chain, or key presence changes", () => {
    const chain = buildLlmProfileChain({
      config: configWith({ LLM_FALLBACK_CHAIN: "openai:gpt-4.1-mini" }),
      selected: { provider: "deepseek", model: "deepseek-v4-flash" }
    });
    const baseline = computeLlmConfigRevision(baseConfig, chain.candidates);
    const differentModel = computeLlmConfigRevision(
      configWith({ DEEPSEEK_MODEL: "deepseek-v4-turbo", LLM_FALLBACK_CHAIN: "openai:gpt-4.1-mini" }),
      buildLlmProfileChain({
        config: configWith({ DEEPSEEK_MODEL: "deepseek-v4-turbo", LLM_FALLBACK_CHAIN: "openai:gpt-4.1-mini" }),
        selected: { provider: "deepseek", model: "deepseek-v4-turbo" }
      }).candidates
    );
    const differentChain = computeLlmConfigRevision(
      baseConfig,
      buildLlmProfileChain({ config: baseConfig, selected: { provider: "deepseek", model: "deepseek-v4-flash" } }).candidates
    );
    const differentKey = computeLlmConfigRevision(
      configWith({ DEEPSEEK_API_KEY: "" }),
      chain.candidates
    );
    expect(new Set([baseline, differentModel, differentChain, differentKey]).size).toBe(4);
  });

  it("never carries key material into the revision", () => {
    const chain = buildLlmProfileChain({ config: baseConfig, selected: { provider: "deepseek", model: "deepseek-v4-flash" } });
    const revision = computeLlmConfigRevision(baseConfig, chain.candidates);
    expect(revision).toMatch(/^cfgrev-[0-9a-f]{16}$/);
    expect(revision).not.toContain(SECRET_MARKER);
  });

  it("changes when the explicit catalog or request temperature changes", () => {
    const chain = buildLlmProfileChain({ config: baseConfig, selected: { provider: "deepseek", model: "deepseek-v4-flash" } });
    const baseline = computeLlmConfigRevision(baseConfig, chain.candidates);
    expect(computeLlmConfigRevision(configWith({ CONSISTENCY_LLM_TEMPERATURE: 0 }), chain.candidates)).not.toBe(baseline);
    expect(computeLlmConfigRevision({ ...baseConfig, piModelsPath: "/tmp/custom-models.json" }, chain.candidates)).not.toBe(baseline);
  });
});
