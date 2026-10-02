import { z } from "zod";

/**
 * H08 — LLM Provider routing contract.
 *
 * Covers connection profiles (连接档), the bounded error taxonomy, and the
 * run-level route record that makes the SELECTED model and the ACTUALLY USED
 * model both visible for a run. This contract carries configuration
 * metadata only: provider ids, model ids, and pinned endpoint URLs are
 * recorded, but API keys and other credentials never are.
 */

/**
 * Bounded error taxonomy for provider failures. Deliberately closed: every
 * provider failure maps onto exactly one of these kinds (or "unknown" when
 * nothing else matches), so routing decisions and run records stay honest
 * and comparable.
 *
 * - auth_failed: the provider rejected the credential (401/403, invalid key,
 *   no authenticated model for the provider).
 * - model_not_found: the pinned model does not exist / is not available on
 *   the provider (404, unknown model, Pi pinned-model resolution failure).
 * - rate_limited: the provider throttled or reported quota exhaustion (429,
 *   rate limit, insufficient quota). Quota details stay "unknown" unless the
 *   provider explicitly returned them — never fabricated.
 * - network: transport-level failure (DNS, connect, reset, timeout, 5xx
 *   gateway responses).
 * - unknown: anything that matches no bounded rule.
 */
export const llmErrorKindSchema = z.enum([
  "auth_failed",
  "model_not_found",
  "rate_limited",
  "network",
  "unknown"
]);
export type LlmErrorKind = z.infer<typeof llmErrorKindSchema>;

/**
 * Fallback is bounded: a run may fall back at most twice across the whole
 * chain, and the budget is shared across all calls of the run — a later call
 * never re-opens a budget that earlier fallbacks already consumed.
 */
export const LLM_ROUTE_MAX_FALLBACKS = 2;
/** Selected profile + the bounded number of fallbacks. */
export const LLM_ROUTE_MAX_PROFILES = LLM_ROUTE_MAX_FALLBACKS + 1;

/** One user-visible connection profile (连接档). Credentials are never part of it. */
export const llmConnectionProfileSchema = z.object({
  /** Stable id within the routing chain ("primary", "fallback-1", …). */
  id: z.string().trim().min(1).max(64),
  /** Pi catalog provider id. */
  provider: z.string().trim().min(1).max(64),
  /** Pinned model id; absent = the runtime auto-selects. */
  model: z.string().trim().min(1).max(256).optional(),
  /** Optional provider endpoint. Recorded for the profile contract; the
   *  bundled Pi catalog owns the effective endpoint today. */
  baseUrl: z.string().trim().min(1).max(2_048).optional(),
  /** Disabled profiles are skipped by the router, never attempted. */
  enabled: z.boolean()
}).strict();
export type LlmConnectionProfile = z.infer<typeof llmConnectionProfileSchema>;

/** One provider endpoint reference inside a route record (no credentials, no URLs). */
export const llmRouteEndpointSchema = z.object({
  profileId: z.string().trim().min(1).max(64),
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(256).optional()
}).strict();
export type LlmRouteEndpoint = z.infer<typeof llmRouteEndpointSchema>;

/** One failed attempt against a profile, in the order the router tried them. */
export const llmRouteAttemptSchema = z.object({
  profileId: z.string().trim().min(1).max(64),
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(256).optional(),
  errorKind: llmErrorKindSchema,
  /** Bounded transport detail, never upstream response text or credentials. */
  failureReason: z.string().regex(/^(?:timeout(?: after \d+(?:\.\d+)?s)?|connection reset|connection refused|DNS lookup failed|network request failed)$/).optional(),
  /** HTTP status when the failure carried one; otherwise absent. */
  httpStatus: z.number().int().min(400).max(599).optional(),
  /** Provider-provided retry hint only — absent means the provider gave none. */
  retryAfterMs: z.number().int().positive().optional(),
  /**
   * Quota honesty: the contract only admits "unknown" in v1. Providers do
   * not expose remaining quota on these errors, so the record says so
   * instead of fabricating a number.
   */
  quota: z.literal("unknown"),
  at: z.string().datetime()
}).strict();
export type LlmRouteAttempt = z.infer<typeof llmRouteAttemptSchema>;

/**
 * Run-level route record. Pinned at run start (configRevision + selected)
 * and updated as the router resolves the actually-used profile. `selected`
 * is what the user chose; `used` is what actually served the calls; the
 * bounded attempts list keeps the full fallback trail.
 */
export const llmRouteRecordSchema = z.object({
  /** Routing-relevant configuration revision, fixed when the run starts. */
  configRevision: z.string().trim().min(1).max(64),
  /** The user-selected profile (what the run asked for). */
  selected: llmRouteEndpointSchema,
  /** The profile that actually served the calls; absent until one succeeds. */
  used: llmRouteEndpointSchema.optional(),
  /** Failed attempts in order; bounded by the profile count (max 5). */
  attempts: z.array(llmRouteAttemptSchema).max(16),
  /** How many fallbacks this run consumed (never above LLM_ROUTE_MAX_FALLBACKS). */
  fallbackCount: z.number().int().min(0).max(LLM_ROUTE_MAX_FALLBACKS),
  /** Quota honesty at run level: v1 only reports "unknown". */
  quota: z.literal("unknown")
}).strict();
export type LlmRouteRecord = z.infer<typeof llmRouteRecordSchema>;

/**
 * Canonical routing error codes. `LLM_NO_AVAILABLE_PROFILE` is returned when
 * no enabled connection profile exists or the bounded chain was exhausted —
 * instead of an opaque provider error.
 */
export const llmRoutingErrorCodeSchema = z.enum(["LLM_NO_AVAILABLE_PROFILE"]);
export type LlmRoutingErrorCode = z.infer<typeof llmRoutingErrorCodeSchema>;
