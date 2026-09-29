/**
 * Host-side LLM entry for paths that do not run inside ReviewWorkload
 * (Notebook, Workflow Copilot). Audit P1-03 / P2-04 / P2-05:
 *
 *   - every user-visible prompt is redacted by the same model-content policy
 *     the review workload uses, so a secret that leaked into a Notebook
 *     search excerpt cannot re-enter a model request;
 *   - token usage is returned to the caller instead of being discarded;
 *   - an AbortSignal reaches the provider transport (SSE disconnect, HTTP
 *     abort) the same way review cancelRun does.
 *
 * Review agents still go through CapabilityBoundLLMFacade — this helper is
 * the host equivalent for those two product surfaces, not a second review
 * runtime.
 */

import { redactModelVisibleText } from "@consistency/workload-review";
import type { LLMStreamEvent, TokenUsage } from "@consistency/schema";
import type { z } from "zod";
import type { LLMProvider, StructuredResult } from "./types";

export function hostVisiblePrompt(text: string): string {
  return redactModelVisibleText(text);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("LLM request was cancelled");
  }
}

export async function invokeHostStructured<T>(
  provider: LLMProvider,
  request: {
    schema: z.ZodType<T>;
    schemaName: string;
    systemPrompt: string;
    userPrompt: string;
    signal?: AbortSignal;
  }
): Promise<StructuredResult<T>> {
  throwIfAborted(request.signal);
  return provider.invokeWithSchema({
    ...request,
    systemPrompt: hostVisiblePrompt(request.systemPrompt),
    userPrompt: hostVisiblePrompt(request.userPrompt)
  });
}

export async function invokeHostSummary(
  provider: LLMProvider,
  request: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }
): Promise<StructuredResult<{ summary: string }>> {
  throwIfAborted(request.signal);
  return provider.generateSummary({
    ...request,
    systemPrompt: hostVisiblePrompt(request.systemPrompt),
    userPrompt: hostVisiblePrompt(request.userPrompt)
  });
}

export async function* streamHostEvents(
  provider: LLMProvider,
  request: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }
): AsyncIterable<LLMStreamEvent> {
  throwIfAborted(request.signal);
  const redacted = {
    systemPrompt: hostVisiblePrompt(request.systemPrompt),
    userPrompt: hostVisiblePrompt(request.userPrompt),
    signal: request.signal
  };
  if (provider.stream) {
    yield* provider.stream(redacted);
    return;
  }
  const completion = await invokeHostSummary(provider, redacted);
  yield { kind: "text_delta", text: completion.data.summary };
  if (completion.tokenUsage) yield { kind: "usage", usage: completion.tokenUsage };
  yield { kind: "completed" };
}

export function usageOrUndefined(usage?: TokenUsage): TokenUsage | undefined {
  if (!usage) return undefined;
  const hasValue = [usage.inputTokens, usage.outputTokens, usage.totalTokens].some(
    value => typeof value === "number"
  );
  return hasValue ? usage : undefined;
}
