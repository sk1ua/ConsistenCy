import { randomUUID } from "node:crypto";
import type { AgentRun, ReviewReport } from "@consistency/schema";

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
  senderLogin?: string;
  action?: string;
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

export type WebhookDeliveryStatus = "enqueued" | "ignored" | "failed";
export type GitHubCommentStatus = "pending" | "published" | "failed" | "skipped";

export type WebhookDelivery = {
  deliveryId: string;
  event: string;
  action?: string;
  receivedAt: string;
  status: WebhookDeliveryStatus;
};

export type WebhookJobInput = {
  delivery: Omit<WebhookDelivery, "receivedAt" | "status">;
  job: Omit<CreateReviewJobInput, "deliveryId">;
};

export type WebhookAcceptance = {
  duplicate: boolean;
  delivery: WebhookDelivery;
  job?: ReviewJob;
};

export interface ReviewJobStore {
  enqueue(input: CreateReviewJobInput): ReviewJob;
  list(): ReviewJob[];
  get(id: string): ReviewJob | undefined;
  nextQueued(): ReviewJob | undefined;
  markRunning(id: string): ReviewJob | undefined;
  markSucceeded(id: string, result: ReviewReport): ReviewJob | undefined;
  markFailed(id: string, error: string): ReviewJob | undefined;
  updateStatus(id: string, status: JobStatus, error?: string): ReviewJob | undefined;
  acceptWebhookJob(input: WebhookJobInput): WebhookAcceptance;
  recordWebhookDelivery(input: Omit<WebhookDelivery, "receivedAt"> & { receivedAt?: string }): WebhookAcceptance;
  getWebhookDelivery(deliveryId: string): WebhookDelivery | undefined;
  saveAgentRun(agentRun: AgentRun): void;
  listAgentRuns(jobId: string): AgentRun[];
  recoverStaleRunningJobs(cutoff: Date): number;
  updateReportCommentStatus(jobId: string, status: GitHubCommentStatus, error?: string): void;
}

export class InMemoryJobQueue implements ReviewJobStore {
  private readonly jobs = new Map<string, ReviewJob>();
  private readonly deliveries = new Map<string, WebhookDelivery>();
  private readonly agentRuns = new Map<string, AgentRun>();
  private readonly commentStatuses = new Map<string, { status: GitHubCommentStatus; error?: string }>();
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

  acceptWebhookJob(input: WebhookJobInput): WebhookAcceptance {
    const existing = this.deliveries.get(input.delivery.deliveryId);
    if (existing) {
      return { duplicate: true, delivery: existing };
    }

    const delivery: WebhookDelivery = {
      ...input.delivery,
      receivedAt: new Date().toISOString(),
      status: "enqueued"
    };
    const job = this.enqueue({ ...input.job, deliveryId: delivery.deliveryId });
    this.deliveries.set(delivery.deliveryId, delivery);
    return { duplicate: false, delivery, job };
  }

  recordWebhookDelivery(
    input: Omit<WebhookDelivery, "receivedAt"> & { receivedAt?: string }
  ): WebhookAcceptance {
    const existing = this.deliveries.get(input.deliveryId);
    if (existing) {
      return { duplicate: true, delivery: existing };
    }
    const delivery: WebhookDelivery = {
      ...input,
      receivedAt: input.receivedAt ?? new Date().toISOString()
    };
    this.deliveries.set(delivery.deliveryId, delivery);
    return { duplicate: false, delivery };
  }

  getWebhookDelivery(deliveryId: string): WebhookDelivery | undefined {
    return this.deliveries.get(deliveryId);
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

  saveAgentRun(agentRun: AgentRun): void {
    this.agentRuns.set(agentRun.id, agentRun);
  }

  listAgentRuns(jobId: string): AgentRun[] {
    return [...this.agentRuns.values()]
      .filter(agentRun => agentRun.jobId === jobId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  recoverStaleRunningJobs(cutoff: Date): number {
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "running" && job.startedAt && new Date(job.startedAt) < cutoff) {
        this.jobs.set(job.id, {
          ...job,
          status: "queued",
          startedAt: undefined,
          finishedAt: undefined,
          updatedAt: new Date().toISOString(),
          error: "Recovered after an interrupted worker run"
        });
        recovered += 1;
      }
    }
    return recovered;
  }

  updateReportCommentStatus(jobId: string, status: GitHubCommentStatus, error?: string): void {
    this.commentStatuses.set(jobId, { status, error });
  }

  getReportCommentStatus(jobId: string): { status: GitHubCommentStatus; error?: string } | undefined {
    return this.commentStatuses.get(jobId);
  }
}
