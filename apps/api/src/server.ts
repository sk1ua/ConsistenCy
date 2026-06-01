import { createServer } from "node:http";
import { buildHealthPayload } from "./health";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);

export const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(buildHealthPayload()));
    return;
  }

  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Not found" }));
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, () => {
    console.log(`ConsistenCy API listening on http://127.0.0.1:${port}`);
  });
}
