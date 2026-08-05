import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiServer } from "../http";
import { InMemoryJobQueue } from "../jobQueue";
import { WorkflowStore } from "./store";
import { workflowSpecSchema } from "@consistency/schema";

async function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");
  return address.port;
}

function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const call = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
          ...headers
        }
      },
      response => {
        let raw = "";
        response.on("data", chunk => { raw += chunk; });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : undefined });
        });
      }
    );
    call.on("error", reject);
    call.end(payload);
  });
}

describe("workflow CRUD routes", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "workflow-route-"));
  });

  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); })));
    servers.length = 0;
    rmSync(root, { recursive: true, force: true });
  });

  function serve() {
    const jobs = new InMemoryJobQueue();
    const workflows = new WorkflowStore({
      builtinDirectory: join(root, "builtins"),
      draftDirectory: join(root, "drafts")
    });
    const server = createApiServer({ jobs, apiToken: "api-secret", workflows });
    servers.push(server);
    return { server, workflows };
  }

  const spec = workflowSpecSchema.parse({
    version: 2,
    name: "custom-check",
    description: "Custom draft",
    nodes: [{ id: "security", uses: "engine.security", timeoutMs: 120000 }],
    verifiers: [],
    synthesizer: { needs: ["security"], timeoutMs: 120000 }
  });

  it("lists workflows, saves a draft, reads it back, and deletes it", async () => {
    const { server } = serve();
    const port = await listen(server);
    const auth = { authorization: "Bearer api-secret" };

    const listBefore = await call(port, "GET", "/workflows", undefined, auth);
    expect(listBefore.status).toBe(200);
    expect(listBefore.body.workflows).toEqual([]);

    const saved = await call(port, "PUT", "/workflows/custom-check", spec, auth);
    expect(saved.status).toBe(200);
    expect(saved.body.source).toBe("draft");

    const read = await call(port, "GET", "/workflows/custom-check", undefined, auth);
    expect(read.status).toBe(200);
    expect(read.body.workflow.name).toBe("custom-check");
    expect(read.body.source).toBe("draft");

    const listAfter = await call(port, "GET", "/workflows", undefined, auth);
    expect(listAfter.body.workflows).toEqual([{
      name: "custom-check",
      description: "Custom draft",
      source: "draft",
      nodeCount: 1,
      verifierCount: 0
    }]);

    const deleted = await call(port, "DELETE", "/workflows/custom-check", undefined, auth);
    expect(deleted.status).toBe(204);
    expect((await call(port, "GET", "/workflows/custom-check", undefined, auth)).status).toBe(404);
  });

  it("rejects an invalid graph with issue details", async () => {
    const { server } = serve();
    const port = await listen(server);
    const invalid = workflowSpecSchema.safeParse({
      version: 2,
      name: "cyclic",
      nodes: [{ id: "a", uses: "engine.security", needs: ["b"], timeoutMs: 120000 }],
      verifiers: [],
      synthesizer: { needs: ["a"], timeoutMs: 120000 }
    });
    if (invalid.success) throw new Error("expected the cyclic spec to fail schema validation");
    const response = await call(port, "PUT", "/workflows/cyclic", {
      version: 2,
      name: "cyclic",
      nodes: [{ id: "a", uses: "engine.security", needs: ["b"], timeoutMs: 120000 }],
      verifiers: [],
      synthesizer: { needs: ["a"], timeoutMs: 120000 }
    }, { authorization: "Bearer api-secret" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_WORKFLOW");
    expect(response.body.error.details.issues.length).toBeGreaterThan(0);
  });

  it("rejects a name mismatch and requires auth", async () => {
    const { server } = serve();
    const port = await listen(server);
    const mismatched = await call(port, "PUT", "/workflows/other-name", spec, { authorization: "Bearer api-secret" });
    expect(mismatched.status).toBe(400);
    const unauthenticated = await call(port, "GET", "/workflows");
    expect(unauthenticated.status).toBe(401);
  });
});
