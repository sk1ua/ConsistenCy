import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiRuntimeProvider } from "./piProvider";

const fixtureAuth = "local-fixture";

function modelsDocument(baseUrl: string) {
  return {
    providers: {
      probe: {
        baseUrl,
        api: "openai-completions",
        models: [
          {
            id: "probe-model",
            name: "Probe Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4096,
            maxTokens: 512
          }
        ]
      },
      unauthenticated: {
        baseUrl,
        api: "openai-completions",
        models: [
          {
            id: "private-model",
            name: "Private Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4096,
            maxTokens: 512
          }
        ]
      }
    }
  };
}

async function withFixture<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (options: { authPath: string; modelsPath: string; requests: IncomingMessage[] }) => Promise<T>
): Promise<T> {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");

  const directory = await mkdtemp(join(tmpdir(), "consistency-pi-test-"));
  const authPath = join(directory, "auth.json");
  const modelsPath = join(directory, "models.json");
  await writeFile(authPath, JSON.stringify({ probe: { type: "api_key", key: fixtureAuth } }));
  await writeFile(modelsPath, JSON.stringify(modelsDocument(`http://127.0.0.1:${address.port}/v1`)));

  try {
    return await run({ authPath, modelsPath, requests });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function sendSse(response: ServerResponse, content: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    `data: ${JSON.stringify({
      id: "fixture-response",
      model: "probe-model",
      choices: [{ delta: { content }, finish_reason: null }]
    })}`,
    `data: ${JSON.stringify({
      id: "fixture-response",
      model: "probe-model",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
    })}`,
    "data: [DONE]",
    ""
  ].join("\n\n"));
}

describe("PiRuntimeProvider", () => {
  it("loads Pi models.json and auth.json through the official runtime", async () => {
    await withFixture(
      (_request, response) => response.end(),
      async ({ authPath, modelsPath }) => {
        const provider = await PiRuntimeProvider.create({
          authPath,
          modelsPath,
          model: "probe/probe-model"
        });

        expect(provider.isConfigured).toBe(true);
        expect(provider.model).toBe("probe/probe-model");
        expect(await provider.descriptor()).toEqual({
          provider: "probe",
          model: "probe-model",
          name: "Probe Model",
          configured: true,
          reasoning: false,
          contextWindow: 4096,
          maxTokens: 512
        });
      }
    );
  });

  it("describes authentication from Pi's available catalog", async () => {
    await withFixture(
      (_request, response) => response.end(),
      async ({ authPath, modelsPath }) => {
        const runtime = await ModelRuntime.create({
          authPath,
          modelsPath,
          refreshOnCreate: false,
          allowModelNetwork: false
        });
        const descriptors = await PiRuntimeProvider.describe(runtime);
        expect(descriptors.find(model => model.provider === "probe" && model.model === "probe-model"))
          .toMatchObject({ configured: true });
        expect(descriptors.find(model => model.provider === "unauthenticated" && model.model === "private-model"))
          .toMatchObject({ configured: false });
      }
    );
  });

  it("selects only an authenticated provider/model pair", async () => {
    await withFixture(
      (_request, response) => response.end(),
      async ({ authPath, modelsPath }) => {
        await expect(PiRuntimeProvider.create({
          authPath,
          modelsPath,
          model: "unauthenticated/private-model"
        })).rejects.toThrow("Pi model is unavailable or not authenticated");

        await expect(PiRuntimeProvider.create({
          authPath,
          modelsPath,
          model: "probe/missing-model"
        })).rejects.toThrow("Pi model is unavailable or not authenticated");

        await expect(PiRuntimeProvider.create({
          authPath,
          modelsPath,
          model: "probe-model"
        })).rejects.toThrow("Pi model must use provider/model format");
      }
    );
  });

  it("converts Pi completion text and usage into the structured provider contract", async () => {
    await withFixture(
      (_request, response) => sendSse(response, JSON.stringify({ answer: "from-pi" })),
      async ({ authPath, modelsPath, requests }) => {
        const provider = await PiRuntimeProvider.create({
          authPath,
          modelsPath,
          model: "probe/probe-model"
        });
        const result = await provider.invokeWithSchema({
          schema: z.object({ answer: z.string() }).strict(),
          schemaName: "pi-fixture",
          systemPrompt: "Return JSON",
          userPrompt: "Provide an answer"
        });

        expect(result.data).toEqual({ answer: "from-pi" });
        expect(result.tokenUsage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toBe("/v1/chat/completions");
        expect(requests[0]?.headers.authorization).toMatch(/^Bearer /);
      }
    );
  });

  it("converts Pi stream deltas, usage and completion into Notebook events", async () => {
    await withFixture(
      (_request, response) => sendSse(response, "streamed answer"),
      async ({ authPath, modelsPath }) => {
        const provider = await PiRuntimeProvider.create({
          authPath,
          modelsPath,
          model: "probe/probe-model"
        });
        const events = [] as Array<{ kind: string; [key: string]: unknown }>;
        for await (const event of provider.stream({
          systemPrompt: "system",
          userPrompt: "question"
        })) events.push(event);

        expect(events.filter(event => event.kind === "text_delta").map(event => event.text).join(""))
          .toBe("streamed answer");
        expect(events.find(event => event.kind === "usage"))
          .toMatchObject({ usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
        expect(events.at(-1)).toEqual({ kind: "completed" });
        expect(events.some(event => event.kind === "degraded")).toBe(false);
      }
    );
  });

  it("does not expose Pi credentials, paths or provider configuration in descriptors", async () => {
    await withFixture(
      (_request, response) => response.end(),
      async ({ authPath, modelsPath }) => {
        const provider = await PiRuntimeProvider.create({
          authPath,
          modelsPath,
          model: "probe/probe-model"
        });
        const descriptor = await provider.descriptor();
        const serialized = JSON.stringify(descriptor);

        expect(serialized).not.toContain(fixtureAuth);
        expect(serialized).not.toContain(authPath);
        expect(serialized).not.toContain(modelsPath);
        expect(serialized).not.toContain("127.0.0.1");
        expect(descriptor).not.toHaveProperty("headers");
        expect(descriptor).not.toHaveProperty("baseUrl");
      }
    );
  });

  it("maps upstream Pi failures to fixed public provider errors", async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "upstream-private-marker" } }));
      },
      async ({ authPath, modelsPath }) => {
        const provider = await PiRuntimeProvider.create({
          authPath,
          modelsPath,
          model: "probe/probe-model"
        });
        await expect(provider.invokeWithSchema({
          schema: z.object({ answer: z.string() }).strict(),
          schemaName: "pi-failure",
          systemPrompt: "Return JSON",
          userPrompt: "Provide an answer"
        })).rejects.toThrow("Pi LLM request failed");
        await expect(provider.invokeWithSchema({
          schema: z.object({ answer: z.string() }).strict(),
          schemaName: "pi-failure",
          systemPrompt: "Return JSON",
          userPrompt: "Provide an answer"
        })).rejects.not.toThrow("upstream-private-marker");
      }
    );
  });
});
