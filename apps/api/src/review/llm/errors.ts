import { tokenUsageFromError, type LlmErrorKind, type TokenUsage } from "@consistency/schema";

/**
 * H08 — bounded LLM error classification.
 *
 * The taxonomy is the closed five-kind set from the schema contract. Rules
 * are bounded on purpose: a numeric HTTP status property, a Retry-After style
 * property, or a fixed set of message patterns. Nothing else is interpreted,
 * and no upstream message text is ever embedded in the public error message —
 * classification rides as structured fields so run records stay honest
 * without leaking provider detail or credentials.
 */

export type LlmErrorClassification = {
  kind: LlmErrorKind;
  httpStatus?: number;
  retryAfterMs?: number;
  /** Closed, credential-free detail such as "timeout after 300s". */
  failureReason?: string;
};

/**
 * Typed provider transport error. The message MUST stay a fixed public
 * string (piProvider keeps "Pi LLM request failed"); the classification is
 * attached as fields, never as free-form upstream text.
 */
export class LlmProviderError extends Error {
  override readonly name = "LlmProviderError";
  readonly kind: LlmErrorKind;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly tokenUsage?: TokenUsage;
  readonly failureReason?: string;

  constructor(message: string, classification: LlmErrorClassification, options?: { cause?: unknown; tokenUsage?: TokenUsage; failureReason?: string }) {
    super(message);
    this.kind = classification.kind;
    if (classification.httpStatus !== undefined) this.httpStatus = classification.httpStatus;
    if (classification.retryAfterMs !== undefined) this.retryAfterMs = classification.retryAfterMs;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    this.tokenUsage = options?.tokenUsage ?? tokenUsageFromError(options?.cause);
    this.failureReason = transportFailureReason(options?.failureReason ?? classification.failureReason ?? options?.cause);
  }
}

/** Extract only an allowlisted reason/duration, never copy upstream text. */
export function transportFailureReason(error: unknown): string | undefined {
  let current: unknown = error;
  let fallback: string | undefined;
  for (let depth = 0; depth < 4; depth += 1) {
    const value = current !== null && typeof current === "object" ? current as Record<string, unknown> : undefined;
    const text = (typeof current === "string" ? current : typeof value?.failureReason === "string" ? value.failureReason : typeof value?.message === "string" ? value.message : "").slice(0, 2000);
    if (text === "DNS lookup failed" || text === "network request failed") fallback ??= text;
    if (/timeout|timed out|etimedout/i.test(text) || value?.name === "TimeoutError") {
      const duration = /(?:timeout|timed out)[^\r\n]{0,40}?\b(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s)\b/i.exec(text);
      if (duration) {
        const seconds = Number(duration[1]) / (/^(?:ms|milliseconds?)$/i.test(duration[2]!) ? 1000 : 1);
        if (seconds > 0 && seconds <= 86400) return `timeout after ${seconds}s`;
      }
      if (typeof value?.timeoutMs === "number" && value.timeoutMs > 0 && value.timeoutMs <= 86400000) return `timeout after ${value.timeoutMs / 1000}s`;
      fallback = "timeout";
    } else if (/econnreset|connection reset|socket hang up/i.test(text)) fallback ??= "connection reset";
    else if (/econnrefused|connection refused/i.test(text)) fallback ??= "connection refused";
    else if (/enotfound|eai_again|getaddrinfo/i.test(text)) fallback ??= "DNS lookup failed";
    else if (/fetch failed|network error/i.test(text)) fallback ??= "network request failed";
    if (!value || value.cause === current) break;
    current = value.cause;
  }
  return fallback;
}

function kindFromStatus(status: number): LlmErrorKind {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "model_not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "network";
  return "unknown";
}

/** Numeric status carried as an error property (fetch/OpenAI-SDK style). */
function extractStatus(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  for (const key of ["status", "statusCode", "httpStatus"] as const) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) {
      return candidate;
    }
  }
  return undefined;
}

/** Provider-provided retry hint; absent means the provider gave none. */
function extractRetryAfterMs(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>).retryAfterMs;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    return Math.floor(candidate);
  }
  return undefined;
}

// Status text extraction is bounded to explicit "status/code/http" markers
// plus the four decisive standalone codes, to avoid false positives from
// model ids or unrelated numbers in provider messages.
const STATUS_TEXT_PATTERNS: RegExp[] = [
  /\bstatus(?:\s*code)?\s*[:=]?\s*(\d{3})\b/i,
  /\bhttp(?:\s+status)?\s*[:=]?\s*(\d{3})\b/i,
  /\b(?:error\s*)?code\s*[:=]\s*(\d{3})\b/i,
  /\b(401|403|404|429)\b/
];

// Pi runtime fixed messages carry two distinct meanings; they are matched
// before the generic patterns because "not authenticated" inside the model
// message must not win over the pinned-model failure it describes.
const PI_SPECIFIC_PATTERNS: ReadonlyArray<{ kind: LlmErrorKind; pattern: RegExp }> = [
  { kind: "model_not_found", pattern: /pi model is unavailable or not authenticated/i },
  { kind: "auth_failed", pattern: /pi has no authenticated model for provider/i }
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[ _-]?limit/i,
  /too many requests/i,
  /insufficient[ _-]?quota/i,
  /\bquota\b/i,
  /resource_exhausted/i,
  /throttl/i,
  /overloaded/i
];

const AUTH_PATTERNS: RegExp[] = [
  /unauthorized/i,
  /invalid[ _-]api[ _-]key/i,
  /incorrect api key/i,
  /invalid x-api-key/i,
  /api key[^.\n]*(?:invalid|not valid|missing|required)/i,
  /authentication/i,
  /not authenticated/i,
  /forbidden/i,
  /permission denied/i
];

const MODEL_NOT_FOUND_PATTERNS: RegExp[] = [
  /model not found/i,
  /model_not_found/i,
  /no such model/i,
  /unknown model/i,
  /\bmodel\b[^.\n]*(?:does not exist|is unavailable|not available|not found)/i,
  /decommissioned/i
];

const NETWORK_PATTERNS: RegExp[] = [
  /econnrefused/i,
  /econnreset/i,
  /econnaborted/i,
  /etimedout/i,
  /timeout/i,
  /timed out/i,
  /enotfound/i,
  /eai_again/i,
  /epipe/i,
  /getaddrinfo/i,
  /fetch failed/i,
  /network error/i,
  /socket hang up/i,
  /connection (?:refused|reset|closed|terminated|error)/i,
  /operation was aborted/i
];

function firstMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

/** Bounded text-only classification (used when no structured fields exist). */
export function classifyLlmText(text: string, retryAfterMs?: number): LlmErrorClassification {
  for (const { kind, pattern } of PI_SPECIFIC_PATTERNS) {
    if (pattern.test(text)) return retryAfterMs ? { kind, retryAfterMs } : { kind };
  }
  for (const pattern of STATUS_TEXT_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const status = Number(match[1]);
      return { kind: kindFromStatus(status), httpStatus: status, ...(retryAfterMs ? { retryAfterMs } : {}) };
    }
  }
  const kind = firstMatch(text, RATE_LIMIT_PATTERNS) ? "rate_limited"
    : firstMatch(text, AUTH_PATTERNS) ? "auth_failed"
    : firstMatch(text, MODEL_NOT_FOUND_PATTERNS) ? "model_not_found"
    : firstMatch(text, NETWORK_PATTERNS) ? "network"
    : "unknown";
  return retryAfterMs ? { kind, retryAfterMs } : { kind };
}

/**
 * Classify an unknown provider error: prefer a typed {@link LlmProviderError},
 * then numeric status properties on the error or its bounded cause chain,
 * then bounded message patterns.
 */
export function classifyLlmError(error: unknown): LlmErrorClassification {
  let retryAfterMs: number | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof LlmProviderError) {
      const retry = current.retryAfterMs ?? retryAfterMs;
      return {
        kind: current.kind,
        ...(current.failureReason ? { failureReason: current.failureReason } : {}),
        ...(current.httpStatus !== undefined ? { httpStatus: current.httpStatus } : {}),
        ...(retry !== undefined ? { retryAfterMs: retry } : {})
      };
    }
    if (current === null || typeof current !== "object") break;
    const status = extractStatus(current);
    if (status !== undefined) {
      const retry = extractRetryAfterMs(current) ?? retryAfterMs;
      return {
        kind: kindFromStatus(status),
        httpStatus: status,
        ...(retry !== undefined ? { retryAfterMs: retry } : {})
      };
    }
    retryAfterMs = extractRetryAfterMs(current) ?? retryAfterMs;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) break;
    current = next;
  }
  const text = error instanceof Error ? error.message : String(error);
  const classification = classifyLlmText(text, retryAfterMs);
  const failureReason = transportFailureReason(error);
  return { ...classification, ...(failureReason ? { failureReason } : {}) };
}
