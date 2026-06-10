import { randomUUID } from "node:crypto";
import type { ReviewReport } from "@consistency/schema";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export type ReviewJobKind = "pull_request" | "push";

export type ReviewJob = {
  id: string;
  kind: ReviewJobKind;
  status: JobStatus;
  deliveryId: string;
  repository: string;
  repoPath?: string;
  installationId?: number;
  pullRequestNumber?: number;
  baseSha?: string;
  headSha?: string;
  ref?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: ReviewReport;
  error?: string;
};

export type CreateReviewJobInput = Omit<ReviewJob, "id" | "status" | "createdAt" | "updatedAt">;

export class InMemoryJobQueue {
  private readonly jobs = new Map<string, ReviewJob>();
  enqueue(input: CreateReviewJobInput): ReviewJob {
    const now = new Date().toISOString();
    const job: ReviewJob = {
      ...input,
      id: `job_${randomUUID()}`,
      status: "queued",
      createdAt: now,
      updatedAt: now
    };
    this.jobs.set(job.id, job);
    return job;
  }

  list(): ReviewJob[] {
    return [...this.jobs.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  get(id: string): ReviewJob | undefined {
    return this.jobs.get(id);
  }

  nextQueued(): ReviewJob | undefined {
    return this.list().find(job => job.status === "queued");
  }

  markRunning(id: string): ReviewJob | undefined {
    const job = this.jobs.get(id);
    if (!job) {
      return undefined;
    }
    const now = new Date().toISOString();
    const updated: ReviewJob = {
      ...job,
      status: "running",
      startedAt: job.startedAt ?? now,
      updatedAt: now,
      error: undefined
    };
    this.jobs.set(id, updated);
    return updated;
  }

  markSucceeded(id: string, result: ReviewReport): ReviewJob | undefined {
    const job = this.jobs.get(id);
    if (!job) {
      return undefined;
    }
    const now = new Date().toISOString();
    const updated: ReviewJob = {
      ...job,
      status: "succeeded",
      result,
      finishedAt: now,
      updatedAt: now,
      error: undefined
    };
    this.jobs.set(id, updated);
    return updated;
  }

  markFailed(id: string, error: string): ReviewJob | undefined {
    const job = this.jobs.get(id);
    if (!job) {
      return undefined;
    }
    const now = new Date().toISOString();
    const updated: ReviewJob = {
      ...job,
      status: "failed",
      error,
      finishedAt: now,
      updatedAt: now
    };
    this.jobs.set(id, updated);
    return updated;
  }

  updateStatus(id: string, status: JobStatus, error?: string): ReviewJob | undefined {
    if (status === "running") {
      return this.markRunning(id);
    }
    if (status === "failed") {
      return this.markFailed(id, error ?? "Job failed");
    }
    const job = this.jobs.get(id);
    if (!job) {
      return undefined;
    }
    const updated: ReviewJob = {
      ...job,
      status,
      error,
      updatedAt: new Date().toISOString()
    };
    this.jobs.set(id, updated);
    return updated;
  }
}
