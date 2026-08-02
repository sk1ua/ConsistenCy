import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../http";
import { InMemoryJobQueue } from "../jobQueue";
import { MockLLMProvider } from "../review/llm/mockProvider";
import { RepositorySnapshotIndexer } from "./indexer";
import { NotebookGraph } from "./graph";
import { InMemoryNotebookStore } from "./store";

function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Expected ephemeral port"));
      resolve(address.port);
    });
  });
}

function httpRequest(port: number, method: string, path: string, payload?: unknown): Promise<{ status: number; body: string; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const raw = payload === undefined ? "" : JSON.stringify(payload);
    const req = request({ hostname: "127.0.0.1", port, path, method, headers: { ...(raw ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } : {}) } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body, contentType: response.headers["content-type"] }));
    });
    req.on("error", reject);
    req.end(raw);
  });
}

describe("public PR and Notebook HTTP routes", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("creates an analysis-only job and streams a SHA-bound Notebook response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-http-notebook-"));
    directories.push(directory);
    writeFileSync(join(directory, "README.md"), "# Repository evidence\n\nThis file anchors the notebook citation.\n", "utf8");
    const jobs = new InMemoryJobQueue();
    const notebooks = new InMemoryNotebookStore();
    const indexer = new RepositorySnapshotIndexer({ store: notebooks });
    const graph = new NotebookGraph({ provider: new MockLLMProvider(), jobs, notebookStore: notebooks, indexer });
    const server = createApiServer({
      jobs,
      notebookStore: notebooks,
      notebookGraph: graph,
      publicPrAnalysisEnabled: true,
      publicPr: async () => ({
        coordinates: { repository: "example/repo", owner: "example", repo: "repo", pullRequestNumber: 9 },
        job: jobs.enqueue({ kind: "pull_request", deliveryId: "public-http-1", repository: "example/repo", pullRequestNumber: 9, accessMode: "public_read", baseSha: "base", headSha: "head", repoPath: directory, publicationPolicy: "github_comment" })
      })
    });
    servers.push(server);
    const port = await listen(server);

    const created = await httpRequest(port, "POST", "/reviews/public-pr", { url: "https://github.com/example/repo/pull/9" });
    expect(created.status).toBe(202);
    const response = JSON.parse(created.body) as { jobId: string; notebookId: string; publicationPolicy: string };
    expect(response.publicationPolicy).toBe("disabled");
    expect(jobs.get(response.jobId)).toMatchObject({ accessMode: "public_read", publicationPolicy: "disabled" });

    const notebook = await httpRequest(port, "GET", `/notebooks/${response.notebookId}`);
    expect(notebook.status).toBe(200);
    expect(JSON.parse(notebook.body)).toMatchObject({ notebook: { repository: "example/repo" } });

    const stream = await httpRequest(port, "POST", `/notebooks/${response.notebookId}/messages`, { content: "What is in this repository?", sourceJobIds: [response.jobId] });
    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain("text/event-stream");
    expect(stream.body).toContain("event: run.started");
    expect(stream.body).toContain("event: citation");
    expect(stream.body).toContain("event: text.delta");
    expect(stream.body).toContain("event: run.completed");
  });
});
