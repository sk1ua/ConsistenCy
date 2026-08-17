import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type ConsistencyDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { createApiServer } from "../http";
import { SQLiteAuditDomainStore } from "./store";

type JsonResponse = { status: number; body: any };

function call(
  port: number,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {}
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const pending = request({
      hostname: "127.0.0.1",
      port,
      method: "POST",
      path,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(raw)),
        ...headers
      }
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: body.length === 0 ? {} : JSON.parse(body)
      }));
    });
    pending.on("error", reject);
    pending.end(raw);
  });
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const pending = request({ hostname: "127.0.0.1", port, method: "GET", path, headers }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: body.length === 0 ? {} : JSON.parse(body)
      }));
    });
    pending.on("error", reject);
    pending.end();
  });
}

async function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected ephemeral port");
  return address.port;
}

describe("desktop-only local repository registration", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];
  const databases: ConsistencyDatabase[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    for (const database of databases.splice(0)) database.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function databaseStore(): { database: ConsistencyDatabase; store: SQLiteAuditDomainStore } {
    const database = openDatabase(":memory:");
    databases.push(database);
    runMigrations(database);
    return { database, store: new SQLiteAuditDomainStore(database) };
  }

  it("requires both constant-time credentials and returns only a renderer-safe Repository DTO", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "consistency-local-registration-"));
    directories.push(repositoryPath);
    execFileSync("git", ["init", "--quiet"], { cwd: repositoryPath, stdio: "ignore" });
    const nestedPath = join(repositoryPath, "nested");
    mkdirSync(nestedPath);
    const nonRepository = mkdtempSync(join(tmpdir(), "consistency-not-git-"));
    directories.push(nonRepository);

    const { store } = databaseStore();
    const reconciled = vi.fn(async () => {});
    const server = createApiServer({
      auditStore: store,
      apiToken: "api-secret",
      desktopControlToken: "desktop-secret",
      onAuditRepositoriesChanged: reconciled
    });
    servers.push(server);
    const port = await listen(server);
    const bearer = { authorization: "Bearer api-secret" };
    const both = { ...bearer, "x-consistency-desktop-control": "desktop-secret" };

    expect((await call(port, "/internal/repositories/local", { path: repositoryPath }, {
      "x-consistency-desktop-control": "desktop-secret"
    })).status).toBe(401);
    expect(await call(port, "/internal/repositories/local", { path: repositoryPath }, bearer))
      .toMatchObject({ status: 401, body: { error: { code: "DESKTOP_CONTROL_UNAUTHORIZED" } } });
    expect((await call(port, "/internal/repositories/local", { path: repositoryPath }, {
      ...bearer,
      "x-consistency-desktop-control": "wrong-secret"
    })).status).toBe(401);

    expect(await call(port, "/internal/repositories/local", { path: "relative/repository" }, both))
      .toMatchObject({ status: 400, body: { error: { code: "LOCAL_REPOSITORY_PATH_INVALID" } } });
    expect(await call(port, "/internal/repositories/local", { path: join(repositoryPath, "missing") }, both))
      .toMatchObject({ status: 400, body: { error: { code: "LOCAL_REPOSITORY_NOT_FOUND" } } });
    expect(await call(port, "/internal/repositories/local", { path: nonRepository }, both))
      .toMatchObject({ status: 400, body: { error: { code: "LOCAL_REPOSITORY_NOT_GIT_WORKTREE" } } });
    expect(await call(port, "/internal/repositories/local", { path: nestedPath }, both))
      .toMatchObject({ status: 400, body: { error: { code: "LOCAL_REPOSITORY_ROOT_REQUIRED" } } });

    const registered = await call(port, "/internal/repositories/local", {
      path: repositoryPath,
      displayName: "customer-project",
      monitoringEnabled: true
    }, both);
    expect(registered).toMatchObject({
      status: 201,
      body: {
        repository: {
          displayName: "customer-project",
          source: "local_git",
          trustLevel: "untrusted_readonly",
          monitoringEnabled: true
        }
      }
    });
    expect(registered.body.repository).not.toHaveProperty("path");
    expect(registered.body.repository).not.toHaveProperty("serverLocator");
    expect(JSON.stringify(registered.body)).not.toContain(repositoryPath);
    expect(reconciled).toHaveBeenCalledTimes(1);
    expect(store.listLocalRepositorySupervisionTargets()).toHaveLength(1);

    const duplicate = await call(port, "/internal/repositories/local", { path: repositoryPath }, both);
    expect(duplicate).toMatchObject({ status: 409, body: { error: { code: "REPOSITORY_ALREADY_EXISTS" } } });
    expect(JSON.stringify(duplicate.body)).not.toContain(repositoryPath);

    const capability = await get(port, "/audit/capabilities", bearer);
    expect(capability.body.localPathRegistration).toBe(false);
    const repositories = await get(port, "/repositories", bearer);
    expect(JSON.stringify(repositories.body)).not.toContain(repositoryPath);
  });

  it("returns unavailable when either server-side credential is not configured", async () => {
    const { store } = databaseStore();
    const withoutControl = createApiServer({ auditStore: store, apiToken: "api-secret", desktopControlToken: "" });
    const withoutBearer = createApiServer({ auditStore: store, apiToken: "", desktopControlToken: "desktop-secret" });
    servers.push(withoutControl, withoutBearer);
    const controlPort = await listen(withoutControl);
    const bearerPort = await listen(withoutBearer);

    expect(await call(controlPort, "/internal/repositories/local", { path: "C:/repo" }, {
      authorization: "Bearer api-secret"
    })).toMatchObject({ status: 503, body: { error: { code: "DESKTOP_CONTROL_UNAVAILABLE" } } });
    expect(await call(bearerPort, "/internal/repositories/local", { path: "C:/repo" }, {
      "x-consistency-desktop-control": "desktop-secret"
    })).toMatchObject({ status: 503, body: { error: { code: "DESKTOP_CONTROL_UNAVAILABLE" } } });
  });
});
