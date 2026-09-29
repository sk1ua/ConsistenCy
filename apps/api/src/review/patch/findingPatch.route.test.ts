import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../../http";
import { FindingPatchError } from "./findingPatch";

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
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, response => {
      let raw = "";
      response.on("data", chunk => { raw += chunk; });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : undefined });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("finding patch routes", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];
  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); })));
    servers.length = 0;
  });

  it("GET preview returns the unified diff payload", async () => {
    const server = createApiServer({
      apiToken: "api-secret",
      findingPatchPreview: async () => ({
        jobId: "job_1",
        findingId: "finding_1",
        accessMode: "local_git",
        patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
        touchedPaths: ["a.ts"],
        applyAvailable: true,
        verification: { policyOk: true, violations: [], applies: true }
      })
    });
    servers.push(server);
    const port = await listen(server);
    const response = await call(port, "GET", "/jobs/job_1/findings/finding_1/patch", {
      authorization: "Bearer api-secret"
    });
    expect(response.status).toBe(200);
    expect(response.body.applyAvailable).toBe(true);
    expect(response.body.patch).toContain("diff --git");
  });

  it("POST apply returns applied:true committed:false", async () => {
    const server = createApiServer({
      apiToken: "api-secret",
      findingPatchApply: async () => ({
        jobId: "job_1",
        findingId: "finding_1",
        applied: true as const,
        touchedPaths: ["a.ts"],
        committed: false as const,
        message: "Patch applied to the local working tree (unstaged; not committed)"
      })
    });
    servers.push(server);
    const port = await listen(server);
    const response = await call(port, "POST", "/jobs/job_1/findings/finding_1/patch/apply", {
      authorization: "Bearer api-secret"
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ applied: true, committed: false });
  });

  it("maps FindingPatchError to API status codes", async () => {
    const server = createApiServer({
      apiToken: "api-secret",
      findingPatchApply: async () => {
        throw new FindingPatchError("Apply is only available for local_git jobs", "PATCH_APPLY_UNAVAILABLE", 403);
      }
    });
    servers.push(server);
    const port = await listen(server);
    const response = await call(port, "POST", "/jobs/job_1/findings/finding_1/patch/apply", {
      authorization: "Bearer api-secret"
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PATCH_APPLY_UNAVAILABLE");
  });
});
