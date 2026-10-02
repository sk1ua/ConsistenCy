import {
  LLM_ROUTE_MAX_FALLBACKS,
  mergeTokenUsage,
  markTokenUsageIncomplete,
  tokenUsageStatus,
  tokenUsageFromError,
  recordTokenUsageOnError,
  findingScoresFromError,
  recordFindingScoresOnError,
  type FindingScore,
  type TokenUsage,
  type AgentRun,
  type LLMStreamEvent,
  type LlmConnectionProfile,
  type LlmRouteAttempt,
  type LlmRouteEndpoint,
  type LlmRouteRecord,
  type ReviewFinding
} from "@consistency/schema";
import { classifyLlmError, LlmProviderError } from "./errors";
import type {
  FindingGenerationRequest,
  LLMProvider,
  LLMStreamRequest,
  StructuredInvocation,
  StructuredResult
} from "./types";

/**
 * H08 — bounded, user-configured fallback chain over connection profiles.
 *
 * Invariants:
 * - At most {@link LLM_ROUTE_MAX_FALLBACKS} fallbacks per RUN; the budget is
 *   shared across every call the provider serves — later calls never re-open
 *   a budget earlier fallbacks already consumed.
 * - Cancellation (an aborted signal) NEVER triggers a fallback: it is checked
 *   before every attempt and after every failure, and it rethrows the abort
 *   reason untouched.
 * - When no enabled profile exists, or the whole bounded chain failed, the
 *   canonical LLM_NO_AVAILABLE_PROFILE error is thrown with the attempt trail.
 * - Quota is never fabricated: attempts record quota "unknown" unless the
 *   provider itself returned a retry hint.
 * - The route record keeps the SELECTED profile (what the run asked for) and
 *   the ACTUALLY USED profile (what served the calls) side by side, and
 *   carries no credentials, keys, or endpoint URLs.
 */

/** Hard cap for the attempts trail; the chain length bounds it well below this. */
const MAX_ROUTE_ATTEMPTS = 16;

/** Canonical routing error: no enabled profile / bounded chain exhausted. */
export class LlmRoutingError extends Error {
  override readonly name = "LlmRoutingError";
  readonly code = "LLM_NO_AVAILABLE_PROFILE" as const;
  readonly route: LlmRouteRecord;

  constructor(route: LlmRouteRecord, message: string) {
    super(message);
    this.route = route;
  }
}

function endpointOf(profile: LlmConnectionProfile): LlmRouteEndpoint {
  return {
    profileId: profile.id,
    provider: profile.provider,
    ...(profile.model ? { model: profile.model } : {})
  };
}

function describeEndpoint(endpoint: LlmRouteEndpoint): string {
  return `${endpoint.profileId}(${endpoint.provider}${endpoint.model ? `/${endpoint.model}` : ""})`;
}

function describeAttempt(attempt: LlmRouteAttempt): string {
  let detail = attempt.errorKind;
  if (attempt.httpStatus !== undefined) detail += `(${attempt.httpStatus})`;
  if (attempt.failureReason) detail += `: ${attempt.failureReason}`;
  // Quota honesty: a rate limit without a provider-provided retry hint means
  // the quota state is UNKNOWN — say so instead of implying a known budget.
  if (attempt.errorKind === "rate_limited" && attempt.retryAfterMs === undefined) detail += "，额度未知";
  if (attempt.errorKind === "rate_limited" && attempt.retryAfterMs !== undefined) detail += `，${attempt.retryAfterMs}ms 后可重试`;
  return `${describeEndpoint({ profileId: attempt.profileId, provider: attempt.provider, ...(attempt.model ? { model: attempt.model } : {}) })}=${detail}`;
}

function abortReason(signal: AbortSignal, fallback?: unknown): unknown {
  return signal.reason ?? fallback ?? new Error("LLM request was cancelled");
}

/** Underlying provider that could not even be created for a chain profile. */
class UnavailableProfileProvider implements LLMProvider {
  readonly name: string;
  readonly model?: string;

  constructor(private readonly profile: LlmConnectionProfile) {
    this.name = profile.provider;
    this.model = profile.model;
  }

  private fail(): never {
    throw new LlmProviderError(`LLM provider for profile '${this.profile.id}' is unavailable`, { kind: "unknown" });
  }

  invokeWithSchema<T>(_request: StructuredInvocation<T>): Promise<StructuredResult<T>> {
    this.fail();
  }

  generateStructuredFinding(_request: FindingGenerationRequest): Promise<StructuredResult<ReviewFinding[]>> {
    this.fail();
  }

  generateAgentRun(_request: FindingGenerationRequest): Promise<StructuredResult<Pick<AgentRun, "findings">>> {
    this.fail();
  }

  generateSummary(_request: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }): Promise<StructuredResult<{ summary: string }>> {
    this.fail();
  }

  async *stream(): AsyncIterable<LLMStreamEvent> {
    this.fail();
  }
}

export interface RoutedLLMProviderOptions {
  /** The user-selected active profile (what the run asked for). */
  selected: LlmConnectionProfile;
  /** Enabled profiles in fallback order; the router only walks these. */
  chain: LlmConnectionProfile[];
  /** Routing config revision, fixed at run start (provider construction). */
  configRevision: string;
  /** Lazily builds the underlying single-profile provider for a chain entry. */
  spawn: (profile: LlmConnectionProfile) => LLMProvider | undefined;
}

export class RoutedLLMProvider implements LLMProvider {
  private readonly chain: LlmConnectionProfile[];
  private readonly spawnProfile: (profile: LlmConnectionProfile) => LLMProvider | undefined;
  private readonly underlyingByIndex = new Map<number, LLMProvider>();
  /** Async mutex serializing chain resolution; pinned calls run unserialized. */
  private resolutionTail: Promise<void> = Promise.resolve();
  private pinnedIndex: number | undefined;
  private remainingFallbacks = LLM_ROUTE_MAX_FALLBACKS;
  private readonly routeRecord: LlmRouteRecord;

  constructor(options: RoutedLLMProviderOptions) {
    this.chain = options.chain;
    this.spawnProfile = options.spawn;
    this.routeRecord = {
      configRevision: options.configRevision,
      selected: endpointOf(options.selected),
      attempts: [],
      fallbackCount: 0,
      quota: "unknown"
    };
  }

  /** Live route record: selected vs used profile, bounded attempts, revision. */
  get route(): LlmRouteRecord {
    return this.routeRecord;
  }

  get name(): string {
    return this.routeRecord.used?.provider ?? this.routeRecord.selected.provider;
  }

  get model(): string | undefined {
    return this.routeRecord.used?.model ?? this.routeRecord.selected.model;
  }

  async invokeWithSchema<T>(request: StructuredInvocation<T>): Promise<StructuredResult<T>> {
    return this.dispatch(provider => provider.invokeWithSchema(request), request.signal);
  }

  async generateStructuredFinding(request: FindingGenerationRequest): Promise<StructuredResult<ReviewFinding[]>> {
    return this.dispatch(provider => provider.generateStructuredFinding(request), request.signal);
  }

  async generateAgentRun(request: FindingGenerationRequest): Promise<StructuredResult<Pick<AgentRun, "findings">>> {
    return this.dispatch(provider => provider.generateAgentRun(request), request.signal);
  }

  async generateSummary(request: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }): Promise<StructuredResult<{ summary: string }>> {
    return this.dispatch(provider => provider.generateSummary(request), request.signal);
  }

  /**
   * Streams are never re-routed mid-flight: a partially delivered stream
   * cannot be rewound, so replaying it on another profile would duplicate
   * output. The pinned (or first enabled) profile serves the stream directly.
   */
  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    if (request.signal?.aborted) {
      throw abortReason(request.signal);
    }
    const index = this.pinnedIndex ?? (this.chain.length > 0 ? 0 : undefined);
    if (index === undefined) {
      throw this.noAvailableProfileError();
    }
    const provider = this.underlying(index);
    this.markUsed(this.chain[index]!);
    if (!provider.stream) {
      throw new LlmProviderError("LLM provider does not support streaming", { kind: "unknown" });
    }
    yield* provider.stream(request);
  }

  private async acquireResolution(): Promise<() => void> {
    const wait = this.resolutionTail.then(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.resolutionTail = gate;
    await wait;
    return release;
  }

  private async dispatch<T>(
    call: (provider: LLMProvider) => Promise<StructuredResult<T>>,
    signal?: AbortSignal
  ): Promise<StructuredResult<T>> {
    let failedUsage: TokenUsage | undefined;
    let hasUnknownFailedUsage = false;
    const failedScores = new Map<string, FindingScore>();
    const trackedCall = async (provider: LLMProvider): Promise<StructuredResult<T>> => {
      try {
        const result = await call(provider);
        const combined = mergeTokenUsage(failedUsage, result.tokenUsage);
        return { ...result, tokenUsage: hasUnknownFailedUsage || tokenUsageStatus(result.tokenUsage) === "unknown"
          ? markTokenUsageIncomplete(combined) : combined };
      } catch (error) {
        const usage = tokenUsageFromError(error);
        if (tokenUsageStatus(usage) === "unknown") hasUnknownFailedUsage = true;
        failedUsage = mergeTokenUsage(failedUsage, usage);
        for (const score of findingScoresFromError(error)) failedScores.set(score.id, score);
        throw error;
      }
    };
    try {
      if (signal?.aborted) throw abortReason(signal);
      if (this.chain.length === 0) throw this.noAvailableProfileError();
      if (this.pinnedIndex === undefined) {
        const release = await this.acquireResolution();
        try {
          // A concurrent call may have resolved the chain while we waited.
          if (this.pinnedIndex === undefined) return await this.walkChain(trackedCall, signal);
        } finally {
          release();
        }
      }
      return await this.callPinned(trackedCall, signal);
    } catch (error) {
      // Preserve canonical routing/cancellation error identity and semantics.
      recordTokenUsageOnError(error, hasUnknownFailedUsage ? markTokenUsageIncomplete(failedUsage) : failedUsage);
      recordFindingScoresOnError(error, [...failedScores.values()]);
      throw error;
    }
  }

  /**
   * First resolution: walk the enabled chain in order. Success pins the
   * profile for the rest of the run; every failure is recorded (bounded
   * classification) and the next profile is tried while the shared budget
   * lasts. Abort rethrows — never classifies, never falls back.
   */
  private async walkChain<T>(
    call: (provider: LLMProvider) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    for (let index = 0; index < this.chain.length; index += 1) {
      const profile = this.chain[index]!;
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      try {
        const result = await call(this.underlying(index));
        this.pinnedIndex = index;
        this.markUsed(profile);
        return result;
      } catch (error) {
        if (signal?.aborted) {
          // 取消绝不触发 fallback：aborted runs surface the cancellation
          // itself, not a routing decision.
          throw abortReason(signal, error);
        }
        this.recordAttempt(profile, classifyLlmError(error));
        if (index + 1 >= this.chain.length) break;
        if (this.remainingFallbacks <= 0) break;
        this.consumeFallback();
      }
    }
    throw this.noAvailableProfileError();
  }

  /**
   * Calls after pinning go straight to the pinned profile; a failure may
   * still fall forward, but only while the run's shared fallback budget
   * lasts. Budget exhausted → the underlying error propagates unchanged.
   */
  private async callPinned<T>(
    call: (provider: LLMProvider) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    const index = this.pinnedIndex!;
    try {
      const result = await call(this.underlying(index));
      this.markUsed(this.chain[index]!);
      return result;
    } catch (error) {
      if (signal?.aborted) {
        throw abortReason(signal, error);
      }
      if (this.remainingFallbacks <= 0 || index + 1 >= this.chain.length) {
        throw error;
      }
      this.recordAttempt(this.chain[index]!, classifyLlmError(error));
      this.consumeFallback();
      this.pinnedIndex = index + 1;
      return this.callPinned(call, signal);
    }
  }

  private underlying(index: number): LLMProvider {
    const cached = this.underlyingByIndex.get(index);
    if (cached) return cached;
    const profile = this.chain[index]!;
    const created = this.spawnProfile(profile) ?? new UnavailableProfileProvider(profile);
    this.underlyingByIndex.set(index, created);
    return created;
  }

  private markUsed(profile: LlmConnectionProfile): void {
    this.routeRecord.used = endpointOf(profile);
  }

  private consumeFallback(): void {
    this.remainingFallbacks -= 1;
    this.routeRecord.fallbackCount += 1;
  }

  private recordAttempt(profile: LlmConnectionProfile, classification: ReturnType<typeof classifyLlmError>): void {
    if (this.routeRecord.attempts.length >= MAX_ROUTE_ATTEMPTS) return;
    const attempt: LlmRouteAttempt = {
      profileId: profile.id,
      provider: profile.provider,
      ...(profile.model ? { model: profile.model } : {}),
      errorKind: classification.kind,
      ...(classification.failureReason ? { failureReason: classification.failureReason } : {}),
      ...(classification.httpStatus !== undefined ? { httpStatus: classification.httpStatus } : {}),
      ...(classification.retryAfterMs !== undefined ? { retryAfterMs: classification.retryAfterMs } : {}),
      quota: "unknown",
      at: new Date().toISOString()
    };
    this.routeRecord.attempts.push(attempt);
  }

  private noAvailableProfileError(): LlmRoutingError {
    const attempts = [...this.routeRecord.attempts];
    const message = attempts.length === 0
      ? `LLM_NO_AVAILABLE_PROFILE: 当前没有可用的模型连接档（已选档 ${describeEndpoint(this.routeRecord.selected)} 未启用，回退链中没有其他已启用的连接档）。请检查各连接档的 API 密钥配置。`
      : `LLM_NO_AVAILABLE_PROFILE: 已按序尝试 ${attempts.length} 个连接档均失败：${attempts.map(describeAttempt).join(" → ")}。请检查各连接档的密钥、模型与网络配置。`;
    return new LlmRoutingError(
      { ...this.routeRecord, attempts },
      message
    );
  }
}
