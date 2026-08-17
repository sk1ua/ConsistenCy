import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { HeartbeatPulse, HeartbeatStreamEvent } from "@consistency/schema";
import { createApiServer } from "../http";

const PULSE: HeartbeatPulse = {
  pulseId: "pulse_1",
  state: "idle",
  repository: { root: "D:/private/repo", provider: "local_git", branch: "v2" },
  observedAt: "2026-08-05T12:00:00.000Z",
  dirtyFileCount: 3,
  pendingEvents: 0,
  lastError: "Unable to inspect D:/private/repo/.git/index"
};

async function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");
  return address.port;
}

function getJson(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port, path, method: "GET", headers }, response => {
      let raw = "";
      response.on("data", chunk => { raw += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: raw.length > 0 ? JSON.parse(raw) : undefined
      }));
    });
    call.on("error", reject);
    call.end();
  });
}

describe("heartbeat endpoints", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise<void>(resolve => {
      // An open SSE connection would otherwise keep close() pending forever.
      server.closeAllConnections?.();
      server.close(() => resolve());
    })));
    servers.length = 0;
  });

  function serve(heartbeat?: {
    latest: () => HeartbeatPulse | undefined;
    subscribe: (subscriber: (event: HeartbeatStreamEvent) => void) => () => void;
  }) {
    const server = createApiServer({ apiToken: "api-secret", heartbeat });
    servers.push(server);
    return server;
  }

  it("returns the latest pulse", async () => {
    const port = await listen(serve({ latest: () => PULSE, subscribe: () => () => {} }));
    const response = await getJson(port, "/heartbeat", { authorization: "Bearer api-secret" });

    expect(response.status).toBe(200);
    expect(response.body.pulse).toMatchObject({
      pulseId: "pulse_1",
      dirtyFileCount: 3,
      repository: { root: "repo" }
    });
    expect(response.body.pulse.lastError).toContain("[PATH_REDACTED]");
    expect(JSON.stringify(response.body)).not.toContain("D:/");
  });

  it("returns null before the first pulse rather than 404", async () => {
    const port = await listen(serve({ latest: () => undefined, subscribe: () => () => {} }));
    const response = await getJson(port, "/heartbeat", { authorization: "Bearer api-secret" });

    expect(response.status).toBe(200);
    expect(response.body.pulse).toBeNull();
  });

  it("requires authentication", async () => {
    const port = await listen(serve({ latest: () => PULSE, subscribe: () => () => {} }));
    expect((await getJson(port, "/heartbeat")).status).toBe(401);
    expect((await getJson(port, "/heartbeat/stream")).status).toBe(401);
  });

  it("returns 404 when the heartbeat is not configured", async () => {
    const port = await listen(serve(undefined));
    const response = await getJson(port, "/heartbeat", { authorization: "Bearer api-secret" });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "HEARTBEAT_DISABLED" } });
  });

  it("streams pulses as server-sent events", async () => {
    let publish: ((event: HeartbeatStreamEvent) => void) | undefined;
    const port = await listen(serve({
      latest: () => PULSE,
      subscribe: subscriber => { publish = subscriber; return () => { publish = undefined; }; }
    }));

    const frames = await new Promise<string>((resolve, reject) => {
      const call = request(
        { host: "127.0.0.1", port, path: "/heartbeat/stream", method: "GET", headers: { authorization: "Bearer api-secret" } },
        response => {
          expect(response.statusCode).toBe(200);
          expect(response.headers["content-type"]).toContain("text/event-stream");
          let raw = "";
          response.on("data", chunk => {
            raw += chunk;
            // Skip the priming comment and wait for a real event frame.
            if (raw.includes("event: pulse")) {
              call.destroy();
              resolve(raw);
            }
          });
          response.on("error", () => resolve(raw));
        }
      );
      call.on("error", reject);
      call.end();
      // Give the handler a tick to register before publishing.
      setTimeout(() => publish?.({ event: "pulse", pulse: PULSE }), 50);
    });

    expect(frames).toContain("event: pulse");
    expect(frames).toContain("\"pulseId\":\"pulse_1\"");
    expect(frames).toContain("\"root\":\"repo\"");
    expect(frames).toContain("[PATH_REDACTED]");
    expect(frames).not.toContain("D:/");
  });

  it("unsubscribes when the client disconnects", async () => {
    let subscribed = 0;
    const port = await listen(serve({
      latest: () => undefined,
      subscribe: () => { subscribed += 1; return () => { subscribed -= 1; }; }
    }));

    // Wait for response headers: that proves the handler ran and subscribed.
    const call = await new Promise<ReturnType<typeof request>>((resolve, reject) => {
      const pending = request(
        { host: "127.0.0.1", port, path: "/heartbeat/stream", method: "GET", headers: { authorization: "Bearer api-secret" } },
        response => {
          response.on("data", () => {});
          resolve(pending);
        }
      );
      pending.on("error", reject);
      pending.end();
    });

    expect(subscribed).toBe(1);
    call.destroy();

    // Otherwise every dropped connection leaks a subscriber on the daemon.
    const deadline = Date.now() + 2_000;
    while (subscribed !== 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(subscribed).toBe(0);
  }, 10_000);
});
