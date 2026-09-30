import { tokenUsageSchema, type AgentRun, type TokenUsage } from "./review";

/** Only known counters are summed; missing provider usage is not fabricated. */
export function mergeTokenUsage(left: TokenUsage | undefined, right: TokenUsage | undefined): TokenUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const result: TokenUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedTokens", "promptTokens"] as const) {
    if (left[key] !== undefined || right[key] !== undefined) result[key] = (left[key] ?? 0) + (right[key] ?? 0);
  }
  if (left.cacheReadStatus !== undefined || right.cacheReadStatus !== undefined) {
    result.cacheReadStatus = left.cacheReadStatus === "reported" || right.cacheReadStatus === "reported" ? "reported" : "unavailable_or_zero";
  }
  return result;
}

// Preserve error identity (including frozen cancellation reasons). Each caller
// records its request-local aggregate, rather than accumulating it a second time.
const failureUsage = new WeakMap<object, TokenUsage>();

export function recordTokenUsageOnError(error: unknown, usage: TokenUsage | undefined): void {
  if (error !== null && typeof error === "object" && usage) failureUsage.set(error, usage);
}

export function tokenUsageFromError(error: unknown): TokenUsage | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const recorded = failureUsage.get(error);
  if (recorded) return recorded;
  if (!("tokenUsage" in error)) return undefined;
  const parsed = tokenUsageSchema.safeParse(error.tokenUsage);
  return parsed.success && Object.values(parsed.data).some(value => value !== undefined) ? parsed.data : undefined;
}

/** Includes every persisted run: successful, failed, Planner and Synthesizer. */
export function promptTokensForAgentRuns(runs: readonly Pick<AgentRun, "tokenUsage">[]): number | undefined {
  let total: number | undefined;
  for (const { tokenUsage: usage } of runs) {
    const prompt = usage?.inputTokens !== undefined
      ? usage.inputTokens + (usage.cachedTokens ?? 0)
      : usage?.promptTokens;
    if (prompt !== undefined) total = (total ?? 0) + prompt;
  }
  return total;
}
