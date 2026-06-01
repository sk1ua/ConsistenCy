import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildHealthPayload } from "./health";
import { processGitHubWebhook, WebhookError } from "./githubWebhook";
import { InMemoryJobQueue } from "./jobQueue";
import { analyzeFileWithPython, parseAnalyzeFileRequest, PythonBridgeError, type RunProcess } from "./pythonBridge";

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  if (body.length === 0) {
    return {};
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new PythonBridgeError("Request body must be valid JSON", "INVALID_JSON");
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof WebhookError) {
    sendJson(response, error.statusCode, {
      error: error.message,
      code: error.code
    });
    return;
  }
  if (error instanceof PythonBridgeError) {
    sendJson(response, error.code.startsWith("INVALID_") ? 400 : 502, {
      error: error.message,
      code: error.code
    });
    return;
  }
  sendJson(response, 500, {
    error: "Unexpected API error",
    code: "INTERNAL_ERROR"
  });
}

function routePath(url: string | undefined): string {
  return new URL(url ?? "/", "http://localhost").pathname;
}

export function createApiServer(
  options: {
    runProcess?: RunProcess;
    jobs?: InMemoryJobQueue;
    githubWebhookSecret?: string;
  } = {}
) {
  const jobs = options.jobs ?? new InMemoryJobQueue();
  const githubWebhookSecret = options.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;

  return createServer(async (request, response) => {
    try {
      const path = routePath(request.url);

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, buildHealthPayload());
        return;
      }

      if (request.method === "POST" && path === "/analyze-file") {
        const body = await readJson(request);
        const analysisRequest = parseAnalyzeFileRequest(body);
        const report = await analyzeFileWithPython(analysisRequest, {
          runProcess: options.runProcess
        });
        sendJson(response, 200, report);
        return;
      }

      if (request.method === "POST" && path === "/github/webhook") {
        const body = await readBody(request);
        const result = processGitHubWebhook({
          headers: request.headers,
          body,
          secret: githubWebhookSecret,
          jobs
        });
        sendJson(response, result.status === "enqueued" ? 202 : 200, result);
        return;
      }

      if (request.method === "GET" && path === "/jobs") {
        sendJson(response, 200, { jobs: jobs.list() });
        return;
      }

      if (request.method === "GET" && path.startsWith("/jobs/")) {
        const id = decodeURIComponent(path.slice("/jobs/".length));
        const job = jobs.get(id);
        if (!job) {
          sendJson(response, 404, { error: "Job not found", code: "JOB_NOT_FOUND" });
          return;
        }
        sendJson(response, 200, { job });
        return;
      }

      sendJson(response, 404, { error: "Not found", code: "NOT_FOUND" });
    } catch (error) {
      sendError(response, error);
    }
  });
}
