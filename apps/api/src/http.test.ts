import { request } from "node:http";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "./http";
import { InMemoryJobQueue } from "./jobQueue";
import type { RunProcess } from "./pythonBridge";
import prReportFixture from "../../../tests/fixtures/pr_report_minimal.json";

const validAnalysisResult = {
  risk_score: 0.1,
  raw_score: 0.1,
  risk_level: "Minor Drift",
  risk_colour: "YELLOW",
  breakdown: { semantic: 0.1 },
  signal_results: {
    semantic: {
      signal_name: "semantic",
      score: 0.1,
      evidence: [],
      confidence: 1,
      metadata: {}
    }
  },
  signal_composition: { semantic: 1 },
  dominant_signals: ["semantic"],
  confidence: 0.8,
  explainability: {
    dominant_signals: ["semantic"],
    contributions: { semantic: 1 },
    evidence_chain: [{ signal_name: "semantic", text: "changed" }],
    confidence: 0.8
  },
  agent_collaboration: {
    scope: "file.py",
    decision: "monitor",
    consensus_score: 0.1,
    confidence: 0.8,
    quorum: "5/5",
    participants: ["SemanticAgent"],
    protocol: "parallel_agents -> evidence_normalization -> weighted_consensus -> reviewer_handoff"
  },
  evidence: [],
  agent_details: {
    SemanticAgent: {
      score: 0.1,
      evidence: [],
      elapsed_ms: 1
    }
  }
};

function httpJson(
  port: number,
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const raw = payload === undefined ? "" : JSON.stringify(payload);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
          ...(raw.length === 0 ? {} : { "content-length": String(Buffer.byteLength(raw)) }),
          ...headers
        }
      },
      res => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", chunk => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(responseBody) });
        });
      }
    );
    req.on("error", reject);
    req.end(raw);
  });
}

function postJson(
  port: number,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  return httpJson(port, "POST", path, payload, headers);
}

function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return httpJson(port, "GET", path);
}

function githubSignature(payload: unknown, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex")}`;
}

async function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }
  return address.port;
}

function enqueuePullRequestJob(jobs: InMemoryJobQueue) {
  return jobs.enqueue({
    kind: "pull_request",
    deliveryId: "delivery-queued",
    repository: "sk1ua/ConsistenCy",
    pullRequestNumber: 31,
    baseSha: "base123",
    headSha: "head456",
    installationId: 123
  });
}

describe("createApiServer", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        server =>
          new Promise<void>(resolve => {
            server.close(() => resolve());
          })
      )
    );
    servers.length = 0;
  });

  it("serves POST /analyze-file through the Python bridge", async () => {
    const runProcess: RunProcess = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(validAnalysisResult),
      stderr: ""
    });
    const server = createApiServer({ runProcess });
    servers.push(server);
    const port = await listen(server);

    const response = await postJson(port, "/analyze-file", {
      currentFile: "examples/demo_new.py",
      baselineFile: "examples/demo_base.py"
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ risk_score: 0.1 });
  });

  it("verifies GitHub pull_request webhooks and enqueues review jobs", async () => {
    const jobs = new InMemoryJobQueue();
    const server = createApiServer({ jobs, githubWebhookSecret: "secret" });
    servers.push(server);
    const port = await listen(server);

    const payload = {
      action: "synchronize",
      repository: { full_name: "sk1ua/ConsistenCy" },
      installation: { id: 123 },
      sender: { login: "octocat" },
      pull_request: {
        number: 31,
        base: { sha: "base123" },
        head: { sha: "head456" }
      }
    };

    const response = await postJson(port, "/github/webhook", payload, {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": githubSignature(payload, "secret")
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: "enqueued",
      event: "pull_request",
      job: {
        kind: "pull_request",
        status: "queued",
        repository: "sk1ua/ConsistenCy",
        pullRequestNumber: 31,
        baseSha: "base123",
        headSha: "head456",
        installationId: 123
      }
    });

    const jobsResponse = await getJson(port, "/jobs");
    expect(jobsResponse.status).toBe(200);
    expect(jobsResponse.body).toMatchObject({
      jobs: [
        {
          deliveryId: "delivery-1",
          repository: "sk1ua/ConsistenCy"
        }
      ]
    });

    const duplicate = await postJson(port, "/github/webhook", payload, {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": githubSignature(payload, "secret")
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ status: "duplicate" });
    expect(jobs.list()).toHaveLength(1);
  });

  it("records push deliveries as ignored without creating a job", async () => {
    const jobs = new InMemoryJobQueue();
    const server = createApiServer({ jobs, githubWebhookSecret: "secret" });
    servers.push(server);
    const port = await listen(server);
    const payload = { ref: "refs/heads/main", repository: { full_name: "sk1ua/ConsistenCy" } };

    const response = await postJson(port, "/github/webhook", payload, {
      "x-github-event": "push",
      "x-github-delivery": "delivery-push",
      "x-hub-signature-256": githubSignature(payload, "secret")
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ignored", reason: "push reviews are not supported" });
    expect(jobs.list()).toHaveLength(0);
    expect(jobs.getWebhookDelivery("delivery-push")?.status).toBe("ignored");
  });

  it("rejects webhook requests when no secret is configured", async () => {
    const server = createApiServer({ githubWebhookSecret: "" });
    servers.push(server);
    const port = await listen(server);

    const response = await postJson(port, "/github/webhook", {}, {
      "x-github-event": "ping",
      "x-github-delivery": "delivery-unconfigured"
    });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "WEBHOOK_NOT_CONFIGURED" });
  });

  it("rejects GitHub webhooks with an invalid signature", async () => {
    const jobs = new InMemoryJobQueue();
    const server = createApiServer({ jobs, githubWebhookSecret: "secret" });
    servers.push(server);
    const port = await listen(server);

    const response = await postJson(
      port,
      "/github/webhook",
      { zen: "Keep it logically awesome." },
      {
        "x-github-event": "ping",
        "x-github-delivery": "delivery-2",
        "x-hub-signature-256": "sha256=bad"
      }
    );

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "INVALID_SIGNATURE" });
    expect(jobs.list()).toHaveLength(0);
  });

  it("runs the next queued PR job and exposes the generated report", async () => {
    const jobs = new InMemoryJobQueue();
    const queued = enqueuePullRequestJob(jobs);
    const calls: Array<{ command: string; args: string[] }> = [];
    const runProcess: RunProcess = async (command, args) => {
      calls.push({ command, args });
      return {
        exitCode: 0,
        stdout: JSON.stringify(prReportFixture),
        stderr: ""
      };
    };
    const server = createApiServer({ jobs, runProcess });
    servers.push(server);
    const port = await listen(server);

    const notReady = await getJson(port, `/jobs/${queued.id}/report`);
    expect(notReady.status).toBe(409);
    expect(notReady.body).toMatchObject({ code: "JOB_NOT_READY" });

    const response = await postJson(port, "/jobs/run-next", {});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      job: {
        id: queued.id,
        status: "succeeded",
        result: {
          jobId: queued.id,
          repositoryFullName: "sk1ua/ConsistenCy",
          pullRequestNumber: 31,
          baseSha: "base123",
          headSha: "head456"
        }
      }
    });
    expect(calls[0]?.command).toBe("python");
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(["pr-report", "--base", "base123", "--head", "head456", "--json-output"])
    );

    const report = await getJson(port, `/jobs/${queued.id}/report`);
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({
      jobId: queued.id,
      baseSha: "base123",
      headSha: "head456",
      findings: [{ file: "docs/EVALUATION.md", confidence: "hypothesis" }]
    });
  });

  it("marks a job failed when Python PR report generation fails", async () => {
    const jobs = new InMemoryJobQueue();
    const queued = enqueuePullRequestJob(jobs);
    const runProcess: RunProcess = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "fatal: bad revision"
    });
    const server = createApiServer({ jobs, runProcess });
    servers.push(server);
    const port = await listen(server);

    const response = await postJson(port, `/jobs/${queued.id}/run`, {});
    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ code: "PYTHON_PR_REPORT_EXIT_NONZERO" });

    const job = await getJson(port, `/jobs/${queued.id}`);
    expect(job.status).toBe(200);
    expect(job.body).toMatchObject({
      job: {
        id: queued.id,
        status: "failed"
      }
    });
  });
});
