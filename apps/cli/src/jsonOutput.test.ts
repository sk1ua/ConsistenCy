/**
 * `consistency review --json` must print parseable JSON on stdout.
 *
 * Regression: the llm.invoke usage log was written to stdout by pino, so the
 * JSON report was preceded by log lines and `--json | jq` broke. The logger now
 * writes to stderr. This test runs the REAL CLI as a child process — so fd 1 is
 * observed exactly as a shell pipeline would see it — against a local
 * OpenAI-compatible fixture endpoint.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX_CLI = join(workspaceRoot, "node_modules", "tsx", "dist", "cli.mjs");
const PROVIDER = "probe";

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
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

/**
 * The OpenAI-compatible request names the structured-output tool either flat
 * or nested under `function`, depending on the API shape Pi selects.
 */
function toolNameOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { tools?: Array<{ name?: string; function?: { name?: string } }> };
    const tool = parsed.tools?.[0];
    return tool?.name ?? tool?.function?.name ?? "";
  } catch {
    return "";
  }
}

/** Minimal valid payload per review schema, chosen from the requested tool. */
function payloadFor(toolName: string): unknown {
  if (toolName.includes("review-plan")) {
    return {
      enabledAgents: ["Security"],
      skippedAgents: ["Correctness", "Maintainability", "Test", "Style", "ArchitectureAuditor"],
      riskAreas: ["changed code"],
      reason: "fixture plan",
      focusAreas: []
    };
  }
  if (toolName.includes("review-summary")) {
    return { summary: "Fixture summary.", scores: [] };
  }
  return { findings: [] };
}

describe("consistency review --json", () => {
  it("prints a report whose stdout parses as JSON, with usage logs kept off stdout", async () => {
    const repo = await mkdtemp(join(tmpdir(), "consistency-cli-json-"));
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.on("data", chunk => { body += String(chunk); });
      request.on("end", () => {
        const toolName = toolNameOf(body);
        sendSse(response, JSON.stringify(payloadFor(toolName)));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");

    try {
      const modelsPath = join(repo, "models.json");
      await writeFile(modelsPath, JSON.stringify({
        providers: {
          [PROVIDER]: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            models: [{
              id: "probe-model",
              name: "Probe Model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 4096,
              maxTokens: 512
            }]
          }
        }
      }));

      git(repo, "init", "-q");
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "Test");
      await writeFile(join(repo, "main.py"), "def run(value):\n    return value\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");
      const baseSha = git(repo, "rev-parse", "HEAD");
      await writeFile(join(repo, "main.py"), "def run(value):\n    return value + 1\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "head");
      const headSha = git(repo, "rev-parse", "HEAD");

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LLM_PROVIDER: PROVIDER,
        LLM_API_KEY: "fixture-key",
        LLM_MODEL: "probe-model",
        CONSISTENCY_PI_MODELS_PATH: modelsPath,
        CONSISTENCY_PI_CONFIG_DIR: join(repo, "pi"),
        CONSISTENCY_LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        LOG_LEVEL: "info",
        NO_COLOR: "1"
      };

      // Async spawn, not spawnSync: the fixture endpoint is served by THIS
      // process, so blocking the event loop would deadlock the child.
      const child = spawn(process.execPath, [
        TSX_CLI, "apps/cli/src/main.ts", "review",
        "--repo", repo,
        "--base", baseSha,
        "--head", headSha,
        "--language", "en-US",
        "--json"
      ], {
        cwd: workspaceRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
        const guard = setTimeout(() => {
          child.kill();
          rejectExit(new Error(`CLI did not finish.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, 180_000);
        child.once("error", error => { clearTimeout(guard); rejectExit(error); });
        child.once("close", code => { clearTimeout(guard); resolveExit(code); });
      });
      expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBeLessThan(2);

      // The whole stdout is ONE JSON document: no log line, no progress text.
      expect(stdout).not.toContain("llm.invoke");
      const parsed = JSON.parse(stdout) as { jobId?: string; findings?: unknown[] };
      expect(typeof parsed.jobId).toBe("string");
      expect(Array.isArray(parsed.findings)).toBe(true);
      // The usage log did happen, it just went to stderr.
      expect(stderr).toContain("llm.invoke");
    } finally {
      await rm(repo, { recursive: true, force: true });
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 240_000);
});
