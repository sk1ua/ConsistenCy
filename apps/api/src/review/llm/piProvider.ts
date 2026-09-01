import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BaseLLMProvider, parseTokenUsage } from "./provider";
import type { LLMProvider, LLMStreamRequest } from "./types";

export interface PiRuntimeOptions {
  authPath?: string;
  modelsPath?: string;
  modelsStorePath?: string;
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

async function selectModel(runtime: ModelRuntime, requested?: string): Promise<PiModel> {
  if (!requested || requested === "auto") {
    const available = await runtime.getAvailable();
    const selected = available[0];
    if (!selected) throw new Error("Pi has no configured model");
    return selected;
  }

  const reference = parseReference(requested);
  if (!reference) throw new Error("Pi model must use provider/model format");
  const available = await runtime.getAvailable(reference.provider);
  const selected = available.find(model => model.id === reference.model);
  if (!selected) throw new Error("Pi model is unavailable or not authenticated");
  return selected;
}

export class PiRuntimeProvider extends BaseLLMProvider {
  readonly name = "pi" as const;
  override model: string;
  private readonly runtimePromise: Promise<ModelRuntime>;
  private readonly selectedModelPromise: Promise<PiModel>;
  private configured = false;
  private initializationError: string | undefined;

  private constructor(runtimePromise: Promise<ModelRuntime>, requestedModel?: string) {
    super();
    this.runtimePromise = runtimePromise;
    this.model = "auto";
    this.selectedModelPromise = runtimePromise
      .then(runtime => selectModel(runtime, requestedModel))
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

  static fromOptions(options: PiRuntimeOptions = {}): PiRuntimeProvider {
    return new PiRuntimeProvider(
      ModelRuntime.create({
        authPath: options.authPath,
        modelsPath: options.modelsPath,
        modelsStorePath: options.modelsStorePath,
        refreshOnCreate: options.refreshOnStart === true,
        allowModelNetwork: false
      }),
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
    const runtime = await this.runtimePromise;
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
      const message = await runtime.complete(await this.selectedModelPromise, {
        systemPrompt: input.systemPrompt,
        messages: [{ role: "user", content: input.userPrompt, timestamp: Date.now() }]
      });
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(errorText(message));
      }
      return { content: textContent(message), tokenUsage: usageFromMessage(message) };
    } catch {
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
    } catch (error) {
      yield { kind: "failed", error: "Pi LLM stream failed" };
    }
  }
}
