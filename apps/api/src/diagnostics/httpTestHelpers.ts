/**
 * Minimal HTTP test helper for the diagnostics suite. Kept separate from
 * http.test.ts (which other workstreams edit heavily) so this module stays
 * stable; no network ever leaves localhost.
 */

import http from "node:http";

export function httpJson(
  port: number,
  method: string,
  requestPath: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  const raw = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers: {
          ...(raw === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) }),
          ...headers,
        },
      },
      res => {
        let responseBody = "";
        res.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString("utf8");
        });
        res.on("end", () => {
          let body: unknown = responseBody;
          try {
            body = responseBody.length > 0 ? JSON.parse(responseBody) : undefined;
          } catch {
            // Non-JSON body: keep the raw text.
          }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end(raw);
  });
}
