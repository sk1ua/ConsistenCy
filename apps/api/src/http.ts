import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildHealthPayload } from "./health";
import { analyzeFileWithPython, parseAnalyzeFileRequest, PythonBridgeError, type RunProcess } from "./pythonBridge";

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PythonBridgeError("Request body must be valid JSON", "INVALID_JSON");
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendError(response: ServerResponse, error: unknown): void {
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

export function createApiServer(options: { runProcess?: RunProcess } = {}) {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, buildHealthPayload());
        return;
      }

      if (request.method === "POST" && request.url === "/analyze-file") {
        const body = await readJson(request);
        const analysisRequest = parseAnalyzeFileRequest(body);
        const report = await analyzeFileWithPython(analysisRequest, {
          runProcess: options.runProcess
        });
        sendJson(response, 200, report);
        return;
      }

      sendJson(response, 404, { error: "Not found", code: "NOT_FOUND" });
    } catch (error) {
      sendError(response, error);
    }
  });
}
