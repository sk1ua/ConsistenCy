import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WORKING_TREE_REV } from "@consistency/schema";
import { createApiServer } from "../http";
import { InMemoryJobQueue } from "../jobQueue";
import { SQLiteAuditDomainStore } from "../audit/store";
import { openDatabase, type ConsistencyDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { LocalTriggerError } from "./local";

async function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");
  return address.port;
}

function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const call = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers } },
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

describe("POST /reviews/local", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];
  const databases: ConsistencyDatabase[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); })));
    servers.length = 0;
    for (const database of databases.splice(0)) database.close();
  });

  function serve(localReview?: (input: { repoPath: string; baseRef?: string; headRef?: string }) => Promise<{ jobId: string }>) {
    const jobs = new InMemoryJobQueue();
    const database = openDatabase(":memory:");
    databases.push(database);
    runMigrations(database);
    const auditStore = new SQLiteAuditDomainStore(database);
    const repository = auditStore.createRepository({
      displayName: "ConsistenCy",
      source: "local_git",
      monitoringEnabled: true
    }, {
      serverLocator: "D:/workspaces/ConsistenCy",
      trustLevel: "trusted_local"
    });
    const server = createApiServer({ jobs, apiToken: "api-secret", localReview, auditStore });
    servers.push(server);
    return { jobs, repository, server };
  }

  it("queues a local review and echoes the persisted job", async () => {
    const { jobs, repository, server } = serve(async ({ repoPath }) => {
      const job = jobs.enqueue({
        kind: "pull_request",
        repository: "ConsistenCy",
        repoPath,
        accessMode: "local_git",
        publicationPolicy: "disabled",
        baseSha: "a".repeat(40),
        headSha: WORKING_TREE_REV,
        action: "local_trigger"
      });
      return { jobId: job.id };
    });
    const port = await listen(server);

    const response = await post(port, "/reviews/local", { repositoryId: repository.id }, {
      authorization: "Bearer api-secret"
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      repository: "ConsistenCy",
      headSha: WORKING_TREE_REV,
      publicationPolicy: "disabled",
      status: "queued"
    });
    expect(response.body).not.toHaveProperty("repoPath");
    expect(JSON.stringify(response.body)).not.toContain("D:/workspaces/ConsistenCy");
    expect(jobs.get(response.body.jobId)?.accessMode).toBe("local_git");
  });

  it("requires the management bearer token", async () => {
    const { repository, server } = serve(async () => ({ jobId: "job_x" }));
    const port = await listen(server);

    const response = await post(port, "/reviews/local", { repositoryId: repository.id });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("maps a disallowed path to 403 rather than leaking that the path exists", async () => {
    const { repository, server } = serve(async () => {
      throw new LocalTriggerError("Repository path is outside the configured review roots", "PATH_NOT_ALLOWED");
    });
    const port = await listen(server);

    const response = await post(port, "/reviews/local", { repositoryId: repository.id }, {
      authorization: "Bearer api-secret"
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: "PATH_NOT_ALLOWED" } });
  });

  it("maps a clean worktree to 409", async () => {
    const { repository, server } = serve(async () => {
      throw new LocalTriggerError("The working tree is clean", "NOTHING_TO_REVIEW");
    });
    const port = await listen(server);

    const response = await post(port, "/reviews/local", { repositoryId: repository.id }, {
      authorization: "Bearer api-secret"
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "NOTHING_TO_REVIEW" } });
  });

  it("rejects a malformed body", async () => {
    const { server } = serve(async () => ({ jobId: "job_x" }));
    const port = await listen(server);

    const response = await post(port, "/reviews/local", { repo: "typo" }, {
      authorization: "Bearer api-secret"
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "INVALID_LOCAL_REVIEW_REQUEST" } });
  });

  it("returns 503 when local review is not configured", async () => {
    const { repository, server } = serve(undefined);
    const port = await listen(server);

    const response = await post(port, "/reviews/local", { repositoryId: repository.id }, {
      authorization: "Bearer api-secret"
    });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: "LOCAL_REVIEW_UNAVAILABLE" } });
  });
});
