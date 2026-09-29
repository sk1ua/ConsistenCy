import { z } from "zod";

/**
 * H09 — settings user-flow contract.
 *
 * Two payloads support the grouped settings forms:
 *
 * 1. The effective-settings VIEW. It projects the H07 effective configuration
 *    resolution (`source: env | file | default`, restart requirement, lock
 *    state) for every settings field. Secret fields carry ONLY the
 *    `configured` presence flag — never a value. Filesystem-path fields
 *    (database path, workspace root, local review roots) are also reduced to
 *    presence metadata: local locations stay server-side, matching the
 *    renderer projection boundary the settings snapshot already upholds.
 * 2. The LLM connection-test probe. The user explicitly clicks "test" in the
 *    model settings; the probe is one bounded read-only request. An unsaved
 *    draft API key may be probed in place of the ACTIVE credential; the draft
 *    exists only for that single request and is never persisted, logged, or
 *    echoed back. The response distinguishes success, rejected credentials,
 *    and unreachable endpoints — statuses only, never a key, URL query, or
 *    upstream error text.
 */

export const effectiveSettingSourceSchema = z.enum(["env", "file", "default"]);
export type EffectiveSettingSource = z.infer<typeof effectiveSettingSourceSchema>;

/** Renderer-facing projection of one resolved setting. */
export const effectiveSettingItemViewSchema = z.object({
  /** Canonical setting key (e.g. "provider", "workerConcurrency"). */
  key: z.string().min(1),
  /** Primary environment variable name (e.g. "LLM_PROVIDER"). */
  envVar: z.string().min(1),
  source: effectiveSettingSourceSchema,
  /** Whether a usable value exists at the resolved source. */
  configured: z.boolean(),
  /** Secret fields NEVER carry `value`; callers see presence only. */
  isSecret: z.boolean(),
  /** True when an environment variable hard-overrides the field; UI must lock editing. */
  lockedByEnv: z.boolean(),
  /** Changing this field requires a process restart to take effect. */
  restartRequired: z.boolean(),
  /**
   * Effective value for non-secret, non-path fields only. Absent for secret
   * fields and for local filesystem-path fields (databasePath, workspaceRoot,
   * localReviewRoots) — presence stays truthful through `configured`.
   */
  value: z.union([z.string(), z.number(), z.boolean()]).optional()
}).strict();
export type EffectiveSettingItemView = z.infer<typeof effectiveSettingItemViewSchema>;

const groupShape = z.array(effectiveSettingItemViewSchema);

/** Grouped view consumed directly by the settings form sections. */
export const effectiveSettingsViewSchema = z.object({
  items: z.record(effectiveSettingItemViewSchema),
  groups: z.object({
    llm: groupShape,
    github: groupShape,
    runtime: groupShape,
    general: groupShape
  }).strict(),
  /** Environment variables that hard-override file/default configuration. */
  overriddenByEnvironment: z.array(z.string()),
  /** Canonical keys that need a restart when modified. */
  restartRequiredKeys: z.array(z.string())
}).strict();
export type EffectiveSettingsView = z.infer<typeof effectiveSettingsViewSchema>;

/** Bounded probe outcomes. Deliberately probe-level (not the run-error taxonomy):
 *  - connected: the endpoint answered OK for the credential.
 *  - auth_failed: the credential was rejected (401/403, invalid key).
 *  - unreachable: transport-level failure (DNS, refused, timeout, reset).
 *  - rate_limited: the provider throttled the probe.
 *  - model_not_found: pinned model unavailable at the provider (404 on model probe).
 *  - not_configured: no credential to probe.
 *  - unavailable: any other bounded failure (bad base URL, unexpected status).
 */
export const llmConnectionTestStatusSchema = z.enum([
  "connected",
  "auth_failed",
  "unreachable",
  "rate_limited",
  "model_not_found",
  "not_configured",
  "unavailable"
]);
export type LlmConnectionTestStatus = z.infer<typeof llmConnectionTestStatusSchema>;

/**
 * Request body for POST /settings/llm/test-connection. All fields describe
 * the DRAFT the user is looking at; an optional non-empty `apiKey` probes one
 * UNSAVED draft key instead of the ACTIVE runtime credential. Draft keys are
 * never persisted, logged, or echoed back.
 */
export const llmConnectionTestRequestSchema = z.object({
  /** Provider id under test (e.g. "deepseek", "openai", "anthropic"). */
  provider: z.string().trim().min(1).max(64),
  /** Optional draft base URL override (proxy / custom endpoint). */
  baseUrl: z.string().trim().min(1).max(2_048).optional(),
  /** Optional unsaved draft key; when absent the ACTIVE credential is probed. */
  apiKey: z.string().min(1).max(4_096).optional()
}).strict();
export type LlmConnectionTestRequest = z.infer<typeof llmConnectionTestRequestSchema>;

export const llmConnectionTestResponseSchema = z.object({
  status: llmConnectionTestStatusSchema,
  /** Echoed provider id only — never the key. */
  provider: z.string().min(1).max(64),
  testedAt: z.string().datetime(),
  /** Bounded probe latency; absent when the request never completed. */
  latencyMs: z.number().int().nonnegative().optional(),
  /** HTTP status of the probe when one was made; bounded to 400..599 plus 200. */
  httpStatus: z.number().int().optional()
}).strict();
export type LlmConnectionTestResponse = z.infer<typeof llmConnectionTestResponseSchema>;
