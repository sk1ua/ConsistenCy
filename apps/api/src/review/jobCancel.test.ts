/**
 * Review job cancellation (audit P1-07①).
 *
 * Unit coverage for the cancel semantics (queued/running/terminal/refused)
 * plus the HTTP route contract. The live-run abort path itself (workload →
 * provider transport) is covered by review-workload.test.ts.
 */

import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../http";
import { InMemoryJobQueue } from "../jobQueue";
import { cancelReviewJob } from "./jobCancel";
import type { RuntimeRegistry } from "./runtimeRegistry";

function enqueueJob(jobs: InMemoryJobQueue, pullRequestNumber = 1) {
  return jobs.enqueue({
    kind: "pull_request",
    repository: "owner/repo",
    pullRequestNumber,
    installationId: 1,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40)
  });
}

describe("cancelReviewJob", () => {
  it("cancels a queued job", async () => {
    const jobs = new InMemoryJobQueue();
    const job = enqueueJob(jobs);
    const cancelled = await cancelReviewJob(job.id, { jobs });
    expect(cancelled.job.status).toBe("cancelled");
    expect(jobs.get(job.id)?.status).toBe("cancelled");
  });

  it("signals a live run before flipping the store row", async () => {
    const jobs = new InMemoryJobQueue();
    const job = enqueueJob(jobs);
    jobs.markRunning(job.id);
    const requestCancelByJob = vi.fn(() => true);
    const registry = { requestCancelByJob } as unknown as RuntimeRegistry;

    const cancelled = await cancelReviewJob(job.id, { jobs, runtimeRegistry: registry });
    expect(cancelled.job.status).toBe("cancelled");
    expect(requestCancelByJob).toHaveBeenCalledWith(job.id);
  });

  it("refuses unknown jobs with 404 and terminal jobs with 409", async () => {
    const jobs = new InMemoryJobQueue();
    await expect(cancelReviewJob("job_missing", { jobs })).rejects.toMatchObject({
      code: "JOB_NOT_FOUND", statusCode: 404
    });

    const job = enqueueJob(jobs);
    jobs.markRunning(job.id);
    jobs.markFailed(job.id, "boom");
    await expect(cancelReviewJob(job.id, { jobs })).rejects.toMatchObject({
      code: "JOB_ALREADY_TERMINAL", statusCode: 409
    });
  });
});

async function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");
  return address.port;
}

function post(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port, path, method: "POST", headers }, response => {
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

describe("POST /jobs/:id/cancel", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];
  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); })));
    servers.length = 0;
  });

  it("cancels a queued job over HTTP", async () => {
    const jobs = new InMemoryJobQueue();
    const job = enqueueJob(jobs);
    const server = createApiServer({
      jobs,
      apiToken: "api-secret",
      jobCancel: jobId => cancelReviewJob(jobId, { jobs })
    });
    servers.push(server);
    const port = await listen(server);

    const response = await post(port, `/jobs/${job.id}/cancel`, { authorization: "Bearer api-secret" });
    expect(response.status).toBe(200);
    expect(response.body.job).toMatchObject({ id: job.id, status: "cancelled" });
  });

  it("returns 409 for terminal jobs and 404 for unknown ones", async () => {
    const jobs = new InMemoryJobQueue();
    const job = enqueueJob(jobs);
    jobs.markRunning(job.id);
    jobs.markFailed(job.id, "boom");
    const server = createApiServer({
      jobs,
      apiToken: "api-secret",
      jobCancel: jobId => cancelReviewJob(jobId, { jobs })
    });
    servers.push(server);
    const port = await listen(server);

    const terminal = await post(port, `/jobs/${job.id}/cancel`, { authorization: "Bearer api-secret" });
    expect(terminal.status).toBe(409);
    expect(terminal.body.error.code).toBe("JOB_ALREADY_TERMINAL");

    const missing = await post(port, "/jobs/job_missing/cancel", { authorization: "Bearer api-secret" });
    expect(missing.status).toBe(404);
  });
});
