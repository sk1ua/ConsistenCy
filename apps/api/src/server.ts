import { createApiServer } from "./http";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);

export const server = createApiServer();

if (process.env.NODE_ENV !== "test") {
  server.listen(port, () => {
    console.log(`ConsistenCy API listening on http://127.0.0.1:${port}`);
  });
}
