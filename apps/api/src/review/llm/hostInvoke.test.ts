/**
 * Host LLM entry (audit P1-03 / P2-04 / P2-05): Notebook and Copilot share
 * one redaction + abort + usage surface instead of calling the provider raw.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  hostVisiblePrompt,
  invokeHostStructured,
  streamHostEvents,
  throwIfAborted
} from "./hostInvoke";

/** Same synthetic shape the content-policy tests use; never a real credential. */
const FAKE_TOKEN = `ghp_${"F".repeat(36)}`;
import type { LLMProvider, StructuredInvocation, StructuredResult } from "./types";

class RecordingProvider implements LLMProvider {
  readonly name = "openai" as const;
  last?: { systemPrompt: string; userPrompt: string; signal?: AbortSignal };

  async invokeWithSchema<T>(request: StructuredInvocation<T>): Promise<StructuredResult<T>> {
    this.last = { systemPrompt: request.systemPrompt, userPrompt: request.userPrompt, signal: request.signal };
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("cancelled");
    return { data: request.schema.parse({ summary: "ok" }) as T, tokenUsage: { totalTokens: 42 } };
  }

  generateStructuredFinding(): Promise<StructuredResult<never[]>> {
    throw new Error("unused");
  }
  generateAgentRun(): Promise<StructuredResult<{ findings: never[] }>> {
    throw new Error("unused");
  }
  generateSummary(request: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }): Promise<StructuredResult<{ summary: string }>> {
    this.last = request;
    return Promise.resolve({ data: { summary: "ok" }, tokenUsage: { totalTokens: 7 } });
  }
  async *stream(request: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }) {
    this.last = request;
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("cancelled");
    yield { kind: "text_delta" as const, text: "ok" };
    yield { kind: "usage" as const, usage: { totalTokens: 7 } };
    yield { kind: "completed" as const };
  }
}

describe("hostVisiblePrompt (audit P1-03)", () => {
  it("redacts token-shaped values that would otherwise enter a Notebook/Copilot prompt", () => {
    const redacted = hostVisiblePrompt(`const token = "${FAKE_TOKEN}";\nINTERNAL_SERVICE_TICKET=qq-771234`);
    expect(redacted).not.toContain(FAKE_TOKEN);
    expect(redacted).toContain("[REDACTED]");
  });
});

describe("invokeHostStructured (audit P2-04 / P2-05)", () => {
  it("redacts the user prompt, forwards the abort signal, and returns token usage", async () => {
    const provider = new RecordingProvider();
    const schema = z.object({ summary: z.string() }).strict();
    const abort = new AbortController();
    const result = await invokeHostStructured(provider, {
      schema,
      schemaName: "review-summary",
      systemPrompt: "sys",
      userPrompt: `token="${FAKE_TOKEN}"`,
      signal: abort.signal
    });
    expect(result.tokenUsage).toEqual({ totalTokens: 42 });
    expect(provider.last?.userPrompt).not.toContain(FAKE_TOKEN);
    expect(provider.last?.signal).toBe(abort.signal);
  });

  it("refuses to dispatch when already aborted", async () => {
    const provider = new RecordingProvider();
    const abort = new AbortController();
    abort.abort(new Error("disconnected"));
    await expect(invokeHostStructured(provider, {
      schema: z.object({ summary: z.string() }).strict(),
      schemaName: "review-summary",
      systemPrompt: "sys",
      userPrompt: "hi",
      signal: abort.signal
    })).rejects.toThrow(/disconnected/);
    expect(provider.last).toBeUndefined();
  });
});

describe("streamHostEvents (audit P2-05)", () => {
  it("aborts before the first chunk when the signal is already fired", async () => {
    const provider = new RecordingProvider();
    const abort = new AbortController();
    abort.abort(new Error("notebook client disconnected"));
    const chunks: unknown[] = [];
    await expect((async () => {
      for await (const event of streamHostEvents(provider, {
        systemPrompt: "sys",
        userPrompt: "q",
        signal: abort.signal
      })) chunks.push(event);
    })()).rejects.toThrow(/disconnected/);
    expect(chunks).toEqual([]);
  });
});

describe("throwIfAborted", () => {
  it("is a no-op when the signal is live", () => {
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });
});
