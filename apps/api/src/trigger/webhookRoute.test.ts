import { request } from "node:http";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../http";
import { InMemoryJobQueue } from "../jobQueue";
import { SQLiteAuditDomainStore } from "../audit/store";
import { openDatabase, type ConsistencyDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";

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

function signedWebhook(secret: string, fullName: string, deliveryId: string) {
  const payload = {
    action: "opened",
    repository: { full_name: fullName },
    installation: { id: 42 },
    sender: { login: "octocat" },
    pull_request: {
      number: 7,
      base: { sha: "a".repeat(7) },
      head: { sha: "b".repeat(7) }
    }
  };
  return {
    payload,
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex")}`
    }
  };
}

describe("POST /github/webhook canonical association route wiring", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];
  const databases: ConsistencyDatabase[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); })));
    servers.length = 0;
    for (const database of databases.splice(0)) database.close();
  });

  function serve(): { jobs: InMemoryJobQueue; repository: ReturnType<SQLiteAuditDomainStore["connectGitHubRepository"]>; server: ReturnType<typeof createApiServer> } {
    const jobs = new InMemoryJobQueue();
    const database = openDatabase(":memory:");
    databases.push(database);
    runMigrations(database);
    const auditStore = new SQLiteAuditDomainStore(database);
    const repository = auditStore.connectGitHubRepository({
      displayName: "ConsistenCy",
      source: "github",
      remoteFullName: "Sk1UA/ConsistenCy",
      defaultBranch: "main"
    });
    const server = createApiServer({ jobs, githubWebhookSecret: "webhook-secret", auditStore });
    servers.push(server);
    return { jobs, repository, server };
  }

  it("passes the audit store so enqueued webhook jobs carry the canonical repositoryId", async () => {
    const { jobs, repository, server } = serve();
    const port = await listen(server);
    const { payload, headers } = signedWebhook("webhook-secret", "sk1ua/CONSISTENCY", "delivery-route-canonical");

    const response = await post(port, "/github/webhook", payload, headers);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: "enqueued",
      job: { repositoryId: repository.id }
    });
    expect(jobs.listJobsForRepository(repository.id)).toHaveLength(1);
  });

  it("enqueues jobs for unconnected repositories without a repositoryId (no shadow records)", async () => {
    const { jobs, server } = serve();
    const port = await listen(server);
    const { payload, headers } = signedWebhook("webhook-secret", "octocat/hello-world", "delivery-route-unmatched");

    const response = await post(port, "/github/webhook", payload, headers);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: "enqueued", job: { repository: "octocat/hello-world" } });
    expect(response.body.job.repositoryId).toBeUndefined();
    expect(jobs.list()).toHaveLength(1);
  });
});
