/**
 * CapabilityBoundLLMFacade — the ONLY llm.invoke path a Review Agent gets.
 *
 * Every invocation performs a fresh Kernel authorization
 * (SyscallGateway → CapabilityBroker.authorise, action llm.invoke) and only
 * then calls the TRUSTED backend (ModelDriver bridge) which lives below the
 * gateway. The Agent never holds the backend, API keys, or provider objects.
 *
 * Usage reporting follows PR-1.1 trusted-usage semantics: the backend's
 * token usage is committed by the gateway, never self-reported by the Agent.
 */

import {
  type CapabilityHandle,
  type LLMResource,
  type Principal,
  type SyscallGateway,
} from "@consistency/kernel";
import type { z } from "zod";
import type { ReviewAgentName, ReviewFinding, TokenUsage } from "@consistency/schema";

/** Trusted Ring-1 backend surface (implemented by the workload runtime). */
export interface TrustedLLMBackend {
  invokeStructured<T>(request: {
    schema: z.ZodType<T>;
    schemaName: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ data: T; tokenUsage?: TokenUsage }>;
  invokeAgentFindings(request: {
    agent: ReviewAgentName;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ findings: ReviewFinding[]; tokenUsage?: TokenUsage }>;
  invokeText(request: {
    systemPrompt: string;
    userPrompt: string;
    schemaName: string;
  }): Promise<{ text: string; tokenUsage?: TokenUsage }>;
}

export interface CapabilityBoundLLMFacadeOptions {
  readonly principal: Principal;
  readonly handle: CapabilityHandle;
  readonly resource: LLMResource;
  readonly gateway: SyscallGateway;
  /** Trusted backend — supplied by the runtime, invisible to the Agent. */
  readonly backend: TrustedLLMBackend;
}

export class CapabilityBoundLLMFacade {
  readonly #principal: Principal;
  readonly #handle: CapabilityHandle;
  readonly #resource: LLMResource;
  readonly #gateway: SyscallGateway;
  readonly #backend: TrustedLLMBackend;

  constructor(options: CapabilityBoundLLMFacadeOptions) {
    this.#principal = options.principal;
    this.#handle = options.handle;
    this.#resource = options.resource;
    this.#gateway = options.gateway;
    this.#backend = options.backend;
  }

  /**
   * Agent-facing structured model invocation.
   *
   * @throws CapabilityError with a typed reason when the Kernel denies
   *   (revoked/expired/mismatched capability) — the backend is never called
   *   on denial, even from a stale facade.
   */
  invokeStructured<T>(request: {
    schema: z.ZodType<T>;
    schemaName: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ data: T; tokenUsage?: TokenUsage }> {
    return this.#gateway.invoke(
      {
        principal: this.#principal,
        handle: this.#handle,
        action: "llm.invoke",
        resource: this.#resource,
      },
      async () => {
        const outcome = await this.#backend.invokeStructured(request);
        return {
          value: { data: outcome.data, tokenUsage: outcome.tokenUsage },
          usage: { tokens: outcome.tokenUsage?.totalTokens ?? 0 },
        };
      },
    );
  }

  /** Agent-facing finding generation (structured, Review-domain schema). */
  invokeAgentFindings(request: {
    agent: ReviewAgentName;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ findings: ReviewFinding[]; tokenUsage?: TokenUsage }> {
    return this.#gateway.invoke(
      {
        principal: this.#principal,
        handle: this.#handle,
        action: "llm.invoke",
        resource: this.#resource,
      },
      async () => {
        const outcome = await this.#backend.invokeAgentFindings(request);
        return {
          value: { findings: outcome.findings, tokenUsage: outcome.tokenUsage },
          usage: { tokens: outcome.tokenUsage?.totalTokens ?? 0 },
        };
      },
    );
  }

  /** Agent-facing text invocation. */
  invokeText(request: {
    systemPrompt: string;
    userPrompt: string;
    schemaName: string;
  }): Promise<{ text: string; tokenUsage?: TokenUsage }> {
    return this.#gateway.invoke(
      {
        principal: this.#principal,
        handle: this.#handle,
        action: "llm.invoke",
        resource: this.#resource,
      },
      async () => {
        const outcome = await this.#backend.invokeText(request);
        return {
          value: { text: outcome.text, tokenUsage: outcome.tokenUsage },
          usage: { tokens: outcome.tokenUsage?.totalTokens ?? 0 },
        };
      },
    );
  }
}
