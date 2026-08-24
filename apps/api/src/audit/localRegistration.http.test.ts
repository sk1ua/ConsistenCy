import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type ConsistencyDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { createApiServer } from "../http";
import { SQLiteAuditDomainStore } from "./store";
import { validateLocalRepositoryRegistration } from "./localRegistration";

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
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repositoryPath, stdio: "ignore" });
    writeFileSync(join(repositoryPath, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/Acme/Repository.git"], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: repositoryPath, stdio: "ignore" });
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
          remoteFullName: "Acme/Repository",
          defaultBranch: "main",
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
    expect(duplicate).toMatchObject({
      status: 201,
      body: { repository: { id: registered.body.repository.id, remoteFullName: "Acme/Repository", defaultBranch: "main" } }
    });
    expect(store.listRepositories()).toHaveLength(1);
    expect(JSON.stringify(duplicate.body)).not.toContain(repositoryPath);

    const beforeConflict = store.getRepository(registered.body.repository.id as string);
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/Acme/Different.git"], {
      cwd: repositoryPath,
      stdio: "ignore"
    });
    const conflict = await call(port, "/internal/repositories/local", { path: repositoryPath }, both);
    expect(conflict).toMatchObject({
      status: 409,
      body: { error: { code: "REPOSITORY_RECONCILIATION_CONFLICT" } }
    });
    expect(JSON.stringify(conflict.body)).not.toContain(repositoryPath);
    expect(store.getRepository(registered.body.repository.id as string)).toEqual(beforeConflict);
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/Acme/Repository.git"], {
      cwd: repositoryPath,
      stdio: "ignore"
    });

    const legacyPath = mkdtempSync(join(tmpdir(), "consistency-local-registration-legacy-"));
    directories.push(legacyPath);
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: legacyPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: legacyPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: legacyPath, stdio: "ignore" });
    writeFileSync(join(legacyPath, "README.md"), "legacy fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: legacyPath, stdio: "ignore" });
    execFileSync("git", ["commit", "--quiet", "-m", "legacy fixture"], { cwd: legacyPath, stdio: "ignore" });
    const legacy = store.createRepository({
      displayName: "legacy-project",
      source: "local_git",
      monitoringEnabled: true
    }, { serverLocator: legacyPath });
    execFileSync("git", ["remote", "add", "upstream", "https://github.com/Acme/Legacy.git"], { cwd: legacyPath, stdio: "ignore" });
    execFileSync("git", ["update-ref", "refs/remotes/upstream/develop", "HEAD"], { cwd: legacyPath, stdio: "ignore" });
    execFileSync("git", ["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/develop"], { cwd: legacyPath, stdio: "ignore" });
    const upgraded = await call(port, "/internal/repositories/local", { path: legacyPath }, both);
    expect(upgraded).toMatchObject({
      status: 201,
      body: { repository: { id: legacy.id, remoteFullName: "Acme/Legacy", defaultBranch: "develop" } }
    });
    expect(store.listRepositories()).toHaveLength(2);
    expect(JSON.stringify(upgraded.body)).not.toContain(legacyPath);

    const capability = await get(port, "/audit/capabilities", bearer);
    expect(capability.body.localPathRegistration).toBe(false);
    const repositories = await get(port, "/repositories", bearer);
    expect(JSON.stringify(repositories.body)).not.toContain(repositoryPath);
  });

  it("keeps valid local registration truthful when remote and branch discovery fail", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "consistency-local-discovery-failure-"));
    directories.push(repositoryPath);
    const validated = await validateLocalRepositoryRegistration({ path: repositoryPath }, {
      createProbe: root => ({
        getRepositoryRoot: async () => root,
        getRemotes: async () => { throw new Error("remote discovery unavailable"); },
        resolveRemoteDefaultBranch: async () => { throw new Error("branch discovery unavailable"); }
      })
    });
    expect(validated).toMatchObject({ serverLocator: repositoryPath, monitoringEnabled: true });
    expect(validated).not.toHaveProperty("remoteFullName");
    expect(validated).not.toHaveProperty("defaultBranch");
  });

  it("persists no default branch when the selected remote has no verified symbolic HEAD", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "consistency-local-no-remote-head-"));
    directories.push(repositoryPath);
    const resolveRemoteDefaultBranch = vi.fn(async () => undefined);
    const validated = await validateLocalRepositoryRegistration({ path: repositoryPath }, {
      createProbe: root => ({
        getRepositoryRoot: async () => root,
        getRemotes: async () => [{
          name: "origin",
          fetchUrl: "https://github.com/acme/repository.git",
          githubFullName: "acme/repository"
        }],
        resolveRemoteDefaultBranch
      })
    });
    expect(validated.remoteFullName).toBe("acme/repository");
    expect(validated.defaultBranch).toBeUndefined();
    expect(resolveRemoteDefaultBranch).toHaveBeenCalledWith("origin");
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
