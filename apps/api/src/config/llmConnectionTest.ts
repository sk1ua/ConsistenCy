import type { LlmConnectionTestRequest, LlmConnectionTestResponse } from "@consistency/schema";
import { classifyLlmError } from "../review/llm/errors";

/**
 * H09 — bounded, user-triggered LLM connection probe for the settings dialog.
 *
 * Mirrors the GitHub connection-test posture: exactly ONE outbound read-only
 * request per explicit click, hard 8s ceiling, no retries. All network seams
 * are injectable so unit tests never touch the network. The draft key exists
 * only for the duration of one probe — it is never persisted, logged, or
 * echoed back; the response carries status enums and bounded metadata only.
 */

const PROBE_TIMEOUT_MS = 8_000;

export interface LlmConnectionTestInput {
  readonly provider: string;
  /** Draft base URL override (proxy / custom endpoint). */
  readonly baseUrl?: string;
  /** Unsaved draft key (explicit opt-in): when set, ONLY this key is probed. */
  readonly draftApiKey?: string;
  /** ACTIVE runtime credential for the provider, when one exists. */
  readonly activeApiKey?: string;
  readonly signal?: AbortSignal;
}

export interface LlmConnectionTestDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com"
};

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Resolve the probe URL. Anthropic exposes the model catalog under /v1;
 * DeepSeek and OpenAI-compatible endpoints expose /models on the base URL.
 */
function resolveProbeUrl(provider: string, baseUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  const base = trimTrailingSlash(baseUrl);
  if (provider === "anthropic") {
    return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  }
  return `${base}/models`;
}

function authHeaders(provider: string, apiKey: string): Record<string, string> {
  if (provider === "anthropic") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { authorization: `Bearer ${apiKey}` };
}

/**
 * Truthful single-probe connection test. Without `draftApiKey` the probe
 * targets the ACTIVE runtime credential; with it, only the unsaved draft is
 * probed. The response never contains the key, upstream error text, or any
 * credential material.
 */
export async function testLlmConnection(
  input: LlmConnectionTestInput,
  deps: LlmConnectionTestDeps = {}
): Promise<LlmConnectionTestResponse> {
  const now = deps.now ?? (() => Date.now());
  const testedAt = new Date(now()).toISOString();
  const provider = input.provider;

  const respond = (status: LlmConnectionTestResponse["status"], extras?: Partial<LlmConnectionTestResponse>): LlmConnectionTestResponse =>
    ({ status, provider, testedAt, ...extras });

  const apiKey = input.draftApiKey?.trim() ? input.draftApiKey.trim() : input.activeApiKey?.trim() ? input.activeApiKey.trim() : undefined;
  if (!apiKey || provider === "none" || provider === "") {
    return respond("not_configured");
  }

  const baseUrl = input.baseUrl?.trim() || DEFAULT_BASE_URLS[provider];
  const probeUrl = baseUrl ? resolveProbeUrl(provider, baseUrl) : undefined;
  if (!probeUrl) return respond("unavailable");

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const startedAt = now();

  let response: Response;
  try {
    // The key is injected directly into the request headers and is never
    // logged, stored, or included in any error path below.
    response = await fetchImpl(probeUrl, {
      method: "GET",
      headers: authHeaders(provider, apiKey),
      signal
    });
  } catch (error) {
    const latencyMs = Math.max(0, now() - startedAt);
    const kind = classifyLlmError(error).kind;
    if (kind === "auth_failed") return respond("auth_failed", { latencyMs });
    if (kind === "network") return respond("unreachable", { latencyMs });
    return respond("unavailable", { latencyMs });
  }

  const latencyMs = Math.max(0, now() - startedAt);
  if (response.ok) return respond("connected", { latencyMs, httpStatus: response.status });
  // Body text is intentionally never read into the response: upstream error
  // payloads can echo credential fragments; the status code is enough.
  await response.arrayBuffer().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    return respond("auth_failed", { latencyMs, httpStatus: response.status });
  }
  if (response.status === 404) {
    return respond("model_not_found", { latencyMs, httpStatus: response.status });
  }
  if (response.status === 429) {
    return respond("rate_limited", { latencyMs, httpStatus: response.status });
  }
  return respond("unavailable", { latencyMs, httpStatus: response.status });
}
