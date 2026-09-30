/**
 * Additional requirement B — the model endpoint is configurable and never
 * hardcoded.
 *
 * Two independent surfaces are covered:
 *   - the process-wide shared runtime built from settings/env
 *     (`CONSISTENCY_LLM_BASE_URL`, plus `DEEPSEEK_BASE_URL` for DeepSeek),
 *   - an explicitly constructed runtime (`PiRuntimeOptions.baseUrl`).
 *
 * The fixture catalog points at a dead endpoint, so a call can only succeed if
 * the override actually retargeted the request.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PiRuntimeProvider } from "./piProvider";
import { resetPiRuntime, resolveBaseUrlOverride } from "./piCatalog";
import { loadEnv } from "../../config/env";

const fixtureAuth = "local-fixture";
/** A port nothing listens on: the catalog URL must NOT be reachable. */
const DEAD_BASE_URL = "http://127.0.0.1:1/v1";

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
      }
    }
  };
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

async function withFixture<T>(
  run: (options: { authPath: string; modelsPath: string; baseUrl: string; requests: IncomingMessage[] }) => Promise<T>
): Promise<T> {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    request.on("data", () => undefined);
    request.on("end", () => sendSse(response, JSON.stringify({ answer: "from-override" })));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");

  const directory = await mkdtemp(join(tmpdir(), "consistency-pi-baseurl-"));
  const authPath = join(directory, "auth.json");
  const modelsPath = join(directory, "models.json");
  await writeFile(authPath, JSON.stringify({ probe: { type: "api_key", key: fixtureAuth } }));
  // The catalog points at a dead endpoint; only the override can reach the server.
  await writeFile(modelsPath, JSON.stringify(modelsDocument(DEAD_BASE_URL)));

  try {
    return await run({
      authPath,
      modelsPath,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requests
    });
  } finally {
    // The Pi runtime may still be flushing its auth-file writes when the test
    // finishes; retry the tree removal instead of racing it.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const answerSchema = z.object({ answer: z.string() }).strict();
const answerRequest = {
  schema: answerSchema,
  schemaName: "pi-base-url",
  systemPrompt: "Return JSON",
  userPrompt: "Provide an answer"
};

describe("model base URL override", () => {
  it("resolves the configured override for the selected provider", () => {
    const explicit = loadEnv({ LLM_PROVIDER: "probe", CONSISTENCY_LLM_BASE_URL: "https://gateway.example.com/v1" });
    expect(resolveBaseUrlOverride(explicit)).toEqual({
      providerId: "probe",
      baseUrl: "https://gateway.example.com/v1"
    });

    // DEEPSEEK_BASE_URL now reaches the request instead of only a profile row.
    const deepseek = loadEnv({ DEEPSEEK_API_KEY: "k", DEEPSEEK_BASE_URL: "https://deepseek.example.com" });
    expect(resolveBaseUrlOverride(deepseek)).toEqual({
      providerId: "deepseek",
      baseUrl: "https://deepseek.example.com"
    });

    // The explicit generic override wins over the provider-specific one.
    const both = loadEnv({
      DEEPSEEK_API_KEY: "k",
      DEEPSEEK_BASE_URL: "https://deepseek.example.com",
      CONSISTENCY_LLM_BASE_URL: "https://gateway.example.com/v1"
    });
    expect(resolveBaseUrlOverride(both)?.baseUrl).toBe("https://gateway.example.com/v1");

    // No provider selected and no override configured: nothing to retarget.
    expect(resolveBaseUrlOverride(loadEnv({}))).toBeUndefined();
  });

  it("routes a shared-runtime call to the configured endpoint instead of the catalog default", async () => {
    await withFixture(async ({ authPath, modelsPath, baseUrl, requests }) => {
      const config = loadEnv({
        LLM_PROVIDER: "probe",
        LLM_API_KEY: fixtureAuth,
        CONSISTENCY_PI_CONFIG_DIR: dirname(authPath),
        CONSISTENCY_PI_MODELS_PATH: modelsPath,
        CONSISTENCY_LLM_BASE_URL: baseUrl
      });
      resetPiRuntime();
      try {
        const provider = PiRuntimeProvider.fromShared(config, "probe", "probe-model");
        const result = await provider.invokeWithSchema(answerRequest);

        expect(result.data).toEqual({ answer: "from-override" });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toBe("/v1/chat/completions");
      } finally {
        resetPiRuntime();
      }
    });
  });

  it("routes an explicitly constructed runtime through PiRuntimeOptions.baseUrl", async () => {
    await withFixture(async ({ authPath, modelsPath, baseUrl, requests }) => {
      const provider = await PiRuntimeProvider.create({
        authPath,
        modelsPath,
        providerId: "probe",
        model: "probe/probe-model",
        baseUrl
      });

      const result = await provider.invokeWithSchema({ ...answerRequest, schemaName: "pi-base-url-explicit" });

      expect(result.data).toEqual({ answer: "from-override" });
      expect(requests).toHaveLength(1);
    });
  });

  it("fails closed when the catalog endpoint is unreachable and no override is configured", async () => {
    await withFixture(async ({ authPath, modelsPath, requests }) => {
      const provider = await PiRuntimeProvider.create({
        authPath,
        modelsPath,
        providerId: "probe",
        model: "probe/probe-model"
      });

      await expect(provider.invokeWithSchema({ ...answerRequest, schemaName: "pi-base-url-unreachable" }))
        .rejects.toBeTruthy();
      expect(requests).toHaveLength(0);
    });
  });
});
