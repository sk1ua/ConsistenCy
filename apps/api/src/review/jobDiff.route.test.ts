import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { VcsChangedFile } from "@consistency/schema";
import { createApiServer } from "../http";
import { InMemoryJobQueue } from "../jobQueue";
import { JobDiffError } from "./jobDiff";

async function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");
  return address.port;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port, path, method: "GET", headers }, response => {
      let raw = "";
      response.on("data", chunk => { raw += chunk; });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : undefined });
      });
    });
    call.on("error", reject);
    call.end();
  });
}

describe("GET /jobs/:id/diff", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];
  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); })));
    servers.length = 0;
  });

  it("returns the computed diff for a job", async () => {
    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request",
      repository: "repo",
      repoPath: "D:/repo",
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      action: "local_trigger"
    });
    const file: VcsChangedFile = {
      path: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
      hunks: [{ header: "@@ -1 +1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: "+export const x = 1;\n" }]
    };
    const server = createApiServer({
      jobs,
      apiToken: "api-secret",
      jobDiff: async () => ({ files: [file], available: true })
    });
    servers.push(server);
    const port = await listen(server);

    const response = await get(port, `/jobs/${job.id}/diff`, { authorization: "Bearer api-secret" });
    expect(response.status).toBe(200);
    expect(response.body.jobId).toBe(job.id);
    expect(response.body.available).toBe(true);
    expect(response.body.files[0].path).toBe("src/a.ts");
  });

  it("maps diff errors to their status codes", async () => {
    const server = createApiServer({
      jobs: new InMemoryJobQueue(),
      apiToken: "api-secret",
      jobDiff: async () => { throw new JobDiffError("Workspace missing", "JOB_WORKSPACE_MISSING", 404); }
    });
    servers.push(server);
    const port = await listen(server);
    const response = await get(port, "/jobs/job_1/diff", { authorization: "Bearer api-secret" });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("JOB_WORKSPACE_MISSING");
  });
});
