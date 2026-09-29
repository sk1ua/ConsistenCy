import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type ConsistencyDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { createApiServer } from "../http";
import { SQLiteAuditDomainStore } from "../audit/store";
import { GitHubApiError } from "./client";
import { connectPublicGitHubRepository } from "./publicRepository";

function post(
  port: number,
  payload: unknown,
  path = "/repositories/connect-public"
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const pending = request({
      hostname: "127.0.0.1",
      port,
      method: "POST",
      path,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) }
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }));
    });
    pending.on("error", reject);
    pending.end(raw);
  });
}

async function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected ephemeral port");
  return address.port;
}

describe("public repository connection HTTP API", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];
  const databases: ConsistencyDatabase[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    for (const database of databases.splice(0)) database.close();
  });

  async function fixture(getRepository: () => Promise<{ fullName: string; name: string; defaultBranch: string; private: boolean }>) {
    const database = openDatabase(":memory:");
    databases.push(database);
    runMigrations(database);
    const store = new SQLiteAuditDomainStore(database);
    const server = createApiServer({
      auditStore: store,
      publicRepositoryConnect: input => connectPublicGitHubRepository({
        input,
        store,
        clientFactory: () => ({ getRepository })
      })
    });
    servers.push(server);
    return { port: await listen(server), store };
  }

  it("rejects unverified GitHub records on the generic repository route", async () => {
    let reads = 0;
    const { port, store } = await fixture(async () => {
      reads += 1;
      return { fullName: "Acme/Repository", name: "Repository", defaultBranch: "main", private: false };
    });
    const response = await post(port, {
      displayName: "Repository",
      source: "github",
      remoteFullName: "Acme/Repository"
    }, "/repositories");
    expect(response).toMatchObject({
      status: 422,
      body: { error: { code: "GITHUB_REPOSITORY_VERIFICATION_REQUIRED" } }
    });
    expect(reads).toBe(0);
    expect(store.listRepositories()).toHaveLength(0);
  });

  it("creates once, returns the canonical match, and exposes no provider URL or local path", async () => {
    let reads = 0;
    const { port, store } = await fixture(async () => {
      reads += 1;
      return { fullName: "Acme/Repository", name: "Repository", defaultBranch: "main", private: false };
    });
    const created = await post(port, { input: "https://github.com/Acme/Repository" });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ repository: { source: "github", remoteFullName: "Acme/Repository", defaultBranch: "main" } });
    expect(JSON.stringify(created.body)).not.toContain("https://");
    expect(JSON.stringify(created.body)).not.toMatch(/[A-Za-z]:[\\/]/);

    const existing = await post(port, { input: "acme/repository" });
    expect(existing.status).toBe(200);
    expect((existing.body.repository as { id: string }).id).toBe((created.body.repository as { id: string }).id);
    expect(store.listRepositories()).toHaveLength(1);
    expect(reads).toBe(2);
  });

  it("verifies pre-existing rows and leaves them unchanged when the provider rejects access", async () => {
    const { port, store } = await fixture(async () => {
      throw new GitHubApiError("private provider detail", 404);
    });
    const existing = store.connectGitHubRepository({
      displayName: "Unverified",
      source: "github",
      remoteFullName: "Acme/Repository",
      defaultBranch: "legacy"
    });
    const response = await post(port, { input: "acme/repository" });
    expect(response).toMatchObject({
      status: 404,
      body: { error: { code: "PUBLIC_REPOSITORY_NOT_FOUND" } }
    });
    expect(JSON.stringify(response.body)).not.toContain("private provider detail");
    expect(store.getRepository(existing.id)).toEqual(existing);
  });

  it("verifies and refreshes an existing local row while preserving its opaque ID", async () => {
    const { port, store } = await fixture(async () => ({
      fullName: "Acme/Repository",
      name: "Provider Name",
      defaultBranch: "trunk",
      private: false
    }));
    const existing = store.registerLocalRepository({
      displayName: "Local Name",
      source: "local_git",
      remoteFullName: "acme/repository",
      defaultBranch: "main",
      monitoringEnabled: true
    }, { serverLocator: "D:/private/public-connect-local" });
    const response = await post(port, { input: "ACME/REPOSITORY" });
    expect(response).toMatchObject({
      status: 200,
      body: {
        repository: {
          id: existing.id,
          source: "local_git",
          displayName: "Provider Name",
          remoteFullName: "Acme/Repository",
          defaultBranch: "trunk"
        }
      }
    });
    expect(store.listRepositories()).toHaveLength(1);
  });

  it("surfaces a sanitized typed conflict when verified canonical metadata belongs to another row", async () => {
    const { port, store } = await fixture(async () => ({
      fullName: "Acme/Canonical",
      name: "Canonical",
      defaultBranch: "main",
      private: false
    }));
    const requested = store.connectGitHubRepository({
      displayName: "Requested",
      source: "github",
      remoteFullName: "Acme/Requested",
      defaultBranch: "legacy"
    });
    const canonical = store.connectGitHubRepository({
      displayName: "Canonical",
      source: "github",
      remoteFullName: "Acme/Canonical",
      defaultBranch: "main"
    });
    const before = store.listRepositories();
    const response = await post(port, { input: "acme/requested" });
    expect(response).toMatchObject({
      status: 409,
      body: { error: { code: "REPOSITORY_RECONCILIATION_CONFLICT" } }
    });
    expect(JSON.stringify(response.body)).not.toMatch(/D:[\\/]/);
    expect(store.listRepositories()).toEqual(before);
    expect(store.getRepository(requested.id)).toEqual(requested);
    expect(store.getRepository(canonical.id)).toEqual(canonical);
  });

  it.each([
    ["https://gitlab.com/acme/repository", 422, "PUBLIC_REPOSITORY_UNSUPPORTED_HOST"],
    ["https://github.com/acme/./repository", 400, "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["https://github.com/acme/segment/../repository", 400, "PUBLIC_REPOSITORY_INVALID_INPUT"],
    [String.raw`https://github.com/acme\repository`, 400, "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["invalid", 400, "PUBLIC_REPOSITORY_INVALID_INPUT"]
  ])("rejects invalid input %s without creating a record", async (input, status, code) => {
    let reads = 0;
    const { port, store } = await fixture(async () => {
      reads += 1;
      throw new Error("must not run");
    });
    const response = await post(port, { input });
    expect(response).toMatchObject({ status, body: { error: { code } } });
    expect(reads).toBe(0);
    expect(store.listRepositories()).toHaveLength(0);
  });

  it.each([
    [new GitHubApiError("secret provider detail", 404), 404, "PUBLIC_REPOSITORY_NOT_FOUND"],
    [new GitHubApiError("secret provider detail", 403), 403, "PUBLIC_REPOSITORY_AUTH_REQUIRED"],
    [new GitHubApiError("secret provider detail", 403, "1770000000", "30", "0"), 429, "PUBLIC_REPOSITORY_RATE_LIMITED"],
    [new GitHubApiError("secret provider detail", 503), 502, "PUBLIC_REPOSITORY_PROVIDER_UNAVAILABLE"]
  ])("maps provider failure to a safe typed response", async (error, status, code) => {
    const { port, store } = await fixture(async () => { throw error; });
    const response = await post(port, { input: "acme/repository" });
    expect(response).toMatchObject({ status, body: { error: { code } } });
    expect(JSON.stringify(response.body)).not.toContain("secret provider detail");
    expect(store.listRepositories()).toHaveLength(0);
  });
});
