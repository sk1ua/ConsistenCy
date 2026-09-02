import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BaseLLMProvider, parseTokenUsage } from "./provider";
import { piRuntime } from "./piCatalog";
import type { AppConfig } from "../../config/env";
import type { LLMProvider, LLMStreamRequest } from "./types";

export type PiManagedProviderId = string;

export interface PiManagedOptions {
  /** Isolated auth-storage path inside the ConsistenCy data directory. */
  authPath: string;
  provider: PiManagedProviderId;
  /** Provider API key injected in-memory; never persisted to Pi config. */
  apiKey: string;
  /** Optional pinned model id from Pi's built-in catalog. */
  model?: string;
}

export interface PiRuntimeOptions {
  authPath?: string;
  modelsPath?: string | null;
  modelsStorePath?: string;
  /** Restricts auto-selection to this provider id from Pi's catalog. */
  providerId?: string;
  model?: string;
  refreshOnStart?: boolean;
}

export interface PiModelDescriptor {
  provider: string;
  model: string;
  name: string;
  configured: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
type PiMessage = Awaited<ReturnType<ModelRuntime["complete"]>>;
type PiStream = ReturnType<ModelRuntime["stream"]>;
type PiEvent = PiStream extends AsyncIterable<infer Event> ? Event : never;

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(trimmed)
    ? trimmed
    : undefined;
}

function parseReference(value: string): { provider: string; model: string } | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const provider = cleanText(value.slice(0, separator), 128);
  const model = cleanText(value.slice(separator + 1), 256);
  return provider && model ? { provider, model } : undefined;
}

function textContent(message: PiMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map(part => part.text)
    .join("");
}

function usageFromMessage(message: PiMessage) {
  return parseTokenUsage({
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    totalTokens: message.usage.totalTokens
  });
}

function errorText(_message: PiMessage): string {
  return "Pi LLM request failed";
}

async function selectModel(runtime: ModelRuntime, providerId: string | undefined, requested?: string): Promise<PiModel> {
  if (!requested || requested === "auto") {
    const available = await runtime.getAvailable(providerId);
    const selected = available[0];
    if (!selected) {
      throw new Error(providerId
        ? `Pi has no authenticated model for provider '${providerId}'`
        : "Pi has no configured model");
    }
    return selected;
  }

  // A bare model id resolves within the configured provider; a full
  // "provider/model" reference resolves across the catalog.
  const reference = parseReference(requested) ?? (providerId ? { provider: providerId, model: requested } : undefined);
  if (!reference) throw new Error("Pi model must use provider/model format");
  const available = await runtime.getAvailable(reference.provider);
  const selected = available.find(model => model.id === reference.model);
  if (!selected) throw new Error("Pi model is unavailable or not authenticated");
  return selected;
}

export class PiRuntimeProvider extends BaseLLMProvider {
  override readonly name: string;
  override model: string;
  private readonly runtimePromise: Promise<ModelRuntime>;
  private readonly selectedModelPromise: Promise<PiModel>;
  private configured = false;
  private initializationError: string | undefined;

  private constructor(
    runtimePromise: Promise<ModelRuntime>,
    private readonly providerId: string | undefined,
    requestedModel?: string
  ) {
    super();
    this.name = providerId ?? "pi";
    this.runtimePromise = runtimePromise;
    this.model = "auto";
    this.selectedModelPromise = runtimePromise
      .then(runtime => selectModel(runtime, providerId, requestedModel))
      .then(selected => {
        this.configured = true;
        this.model = `${selected.provider}/${selected.id}`;
        return selected;
      })
      .catch(error => {
        this.initializationError = error instanceof Error ? error.message : "Pi model configuration is unavailable";
        throw error;
      });
  }

  /**
   * Adapter over the shared API-wide runtime (piCatalog.ts). The runtime
   * already carries every settings-injected provider key; the adapter only
   * pins the provider/model selection. With no pinned model the runtime
   * selects the provider's first authenticated catalog model.
   */
  static fromShared(config: AppConfig, provider: string, model?: string): PiRuntimeProvider {
    return new PiRuntimeProvider(piRuntime(config), provider, model);
  }

  static createManaged(options: PiManagedOptions): PiRuntimeProvider {
    const runtimePromise = ModelRuntime.create({
      authPath: options.authPath,
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false
    }).then(async runtime => {
      // setRuntimeApiKey is a non-persistent in-memory credential (see Pi's
      // RuntimeCredentials); it never touches disk.
      await runtime.setRuntimeApiKey(options.provider, options.apiKey);
      return runtime;
    });
    return new PiRuntimeProvider(runtimePromise, options.provider, options.model);
  }

  static fromOptions(options: PiRuntimeOptions = {}): PiRuntimeProvider {
    return new PiRuntimeProvider(
      ModelRuntime.create({
        authPath: options.authPath,
        modelsPath: options.modelsPath,
        modelsStorePath: options.modelsStorePath,
        refreshOnCreate: options.refreshOnStart === true,
        allowModelNetwork: false
      }),
      options.providerId,
      options.model
    );
  }

  static async create(options: PiRuntimeOptions = {}): Promise<PiRuntimeProvider> {
    const provider = PiRuntimeProvider.fromOptions(options);
    await provider.ready();
    return provider;
  }

  static async probe(options: PiRuntimeOptions = {}): Promise<PiModelDescriptor | undefined> {
    try {
      const provider = await PiRuntimeProvider.create(options);
      return await provider.descriptor();
    } catch {
      return undefined;
    }
  }

  ready(): Promise<void> {
    return this.selectedModelPromise.then(() => undefined);
  }

  get isConfigured(): boolean {
    return this.configured;
  }

  get setupError(): string | undefined {
    return this.initializationError;
  }

  static async describe(runtime: ModelRuntime): Promise<PiModelDescriptor[]> {
    const models = runtime.getModels();
    const providers = [...new Set(models.map(model => model.provider))];
    const availableByProvider = new Map<string, Set<string>>();
    await Promise.all(providers.map(async provider => {
      try {
        const available = await runtime.getAvailable(provider);
        availableByProvider.set(provider, new Set(available.map(model => model.id)));
      } catch {
        availableByProvider.set(provider, new Set());
      }
    }));
    return models.map(model => ({
      provider: model.provider,
      model: model.id,
      name: model.name,
      configured: availableByProvider.get(model.provider)?.has(model.id) === true,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens
    }));
  }

  async descriptor(): Promise<PiModelDescriptor> {
    const selected = await this.selectedModelPromise;
    return {
      provider: selected.provider,
      model: selected.id,
      name: selected.name,
      configured: true,
      reasoning: selected.reasoning,
      contextWindow: selected.contextWindow,
      maxTokens: selected.maxTokens
    };
  }

  protected override async complete(input: {
    systemPrompt: string;
    userPrompt: string;
    schemaName: string;
    jsonSchema: unknown;
  }): Promise<{ content: string; tokenUsage?: ReturnType<typeof parseTokenUsage> }> {
    try {
      const runtime = await this.runtimePromise;
      const toolName = `submit_${input.schemaName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48)}`;
      // zod-to-json-schema(name) returns a {$ref, definitions} wrapper. Tool
      // parameters must be the referenced object schema itself (providers
      // reject a wrapper whose top-level type is absent).
      const wrappedSchema = input.jsonSchema as { definitions?: Record<string, unknown>; $defs?: Record<string, unknown> } | undefined;
      const toolSchema = wrappedSchema?.definitions?.[input.schemaName]
        ?? wrappedSchema?.$defs?.[input.schemaName]
        ?? input.jsonSchema;
      const message = await runtime.completeSimple(await this.selectedModelPromise, {
        systemPrompt: `${input.systemPrompt}

You must return the answer by calling the ${toolName} tool exactly once. Do not write prose outside the tool call.`,
        messages: [{ role: "user", content: input.userPrompt, timestamp: Date.now() }],
        tools: [{
          name: toolName,
          description: `Submit the schema-valid ${input.schemaName} response.`,
          // Pi consumes TypeBox/JSON Schema structurally; ConsistenCy's schema
          // is already a strict JSON Schema object generated by Zod.
          parameters: toolSchema as never
        }]
      }, { toolChoice: "auto" });
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        if (process.env.CONSISTENCY_LLM_SMOKE_DEBUG === "true") {
          const detail = cleanText(message.errorMessage, 500) ?? "no provider detail";
          process.stderr.write(`[llm-smoke-provider-detail] ${detail.replace(/(?:sk|key|token)[-_][A-Za-z0-9_-]+/gi, "[REDACTED]")}
`);
        }
        throw new Error(errorText(message));
      }
      const toolCall = message.content.find((part): part is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } => part.type === "toolCall" && part.name === toolName);
      const content = toolCall ? JSON.stringify(toolCall.arguments) : textContent(message);
      return { content, tokenUsage: usageFromMessage(message) };
    } catch (error) {
      if (process.env.CONSISTENCY_LLM_SMOKE_DEBUG === "true") {
        const message = error instanceof Error ? error.message : "unknown";
        process.stderr.write(`[llm-smoke-debug] ${message.replace(/(?:sk|key|token)[-_][A-Za-z0-9_-]+/gi, "[REDACTED]").slice(0, 500)}
`);
      }
      throw new Error("Pi LLM request failed");
    }
  }

  override async *stream(request: LLMStreamRequest): AsyncIterable<import("@consistency/schema").LLMStreamEvent> {
    try {
      const runtime = await this.runtimePromise;
      const stream = runtime.stream(await this.selectedModelPromise, {
        systemPrompt: request.systemPrompt,
        messages: [{ role: "user", content: request.userPrompt, timestamp: Date.now() }]
      }, { signal: request.signal });
      let completed = false;
      for await (const event of stream) {
        if (event.type === "text_delta") yield { kind: "text_delta", text: event.delta };
        if (event.type === "done") {
          completed = true;
          const usage = usageFromMessage(event.message);
          if (usage) yield { kind: "usage", usage };
        }
        if (event.type === "error") throw new Error(errorText(event.error));
      }
      if (!completed) yield { kind: "degraded", reason: "Pi stream ended without a completed assistant response" };
      yield { kind: "completed" };
    } catch {
      yield { kind: "failed", error: "Pi LLM stream failed" };
    }
  }
}
