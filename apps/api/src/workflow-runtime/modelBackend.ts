/**
 * H17 — bridge from the unified LLM entry (H08: `createReviewLLMProvider`,
 * RoutedLLMProvider fallback chain) to the trusted model backend surface the
 * Kernel capability facade expects (`TrustedLLMBackend`).
 *
 * Authority flow for a workflow model node stays exactly the review pipeline's:
 *
 *   agent → CapabilityBoundLLMFacade (Kernel authorizes llm.invoke per call)
 *         → TrustedLLMBackend (this adapter, host side, no key material)
 *         → LLMProvider (H08 routed provider — the ONLY provider construction
 *           point; workflow nodes never build their own provider)
 *
 * Cancellation (H13): the EXECUTOR owns the run-scoped AbortSignal and wraps
 * the backend (see executor.ts) so a scheduler cancelRun reaches the provider
 * transport mid-call; nodes never set signals themselves.
 */

import { z } from "zod";
import type { TrustedLLMBackend } from "@consistency/workload-review";
import type { LLMProvider } from "../review/llm/types";

const textEnvelopeSchema = z.object({ text: z.string().trim().min(1).max(200_000) }).strict();

/** Adapter: unified-entry provider → trusted backend (usage preserved). */
export function backendFromProvider(provider: LLMProvider): TrustedLLMBackend {
  return {
    invokeStructured: async (request) => {
      const result = await provider.invokeWithSchema({
        schema: request.schema,
        schemaName: request.schemaName,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      return { data: result.data, ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }) };
    },
    invokeAgentFindings: async (request) => {
      const result = await provider.generateStructuredFinding({
        agent: request.agent,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      return { findings: result.data, ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }) };
    },
    invokeText: async (request) => {
      const result = await provider.invokeWithSchema({
        schema: textEnvelopeSchema,
        schemaName: request.schemaName,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      return { text: result.data.text, ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }) };
    },
  };
}
