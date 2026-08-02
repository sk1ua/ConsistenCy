import { randomUUID } from "node:crypto";
import { publishOutboxItemSchema, reviewReportSchema, type AgentRun, type PublishOutboxItem, type PublicationPolicy, type ReviewAccessMode, type ReviewReport } from "@consistency/schema";

export type JobStatus =
  | "queued"
  | "running"
  | "awaiting_publish"
  | "publishing"
  | "succeeded"
  | "failed"
  | "publish_failed"
  | "cancelled";

export type PublishOutboxStatus =
  | "pending"
  | "leased"
  | "retrying"
  | "published"
  | "failed"
  | "skipped";

export type ReviewJobKind = "pull_request" | "push";

export type ReviewJob = {
  id: string;
  kind: ReviewJobKind;
  status: JobStatus;
  deliveryId?: string;
  repository: string;
  repoPath?: string;
  installationId?: number;
  accessMode: ReviewAccessMode;
  senderLogin?: string;
  action?: string;
  pullRequestNumber?: number;
  baseSha?: string;
  headSha?: string;
  ref?: string;
  publicationPolicy: PublicationPolicy;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: ReviewReport;
  error?: string;
};

export type CreateReviewJobInput = Omit<ReviewJob, "id" | "status" | "createdAt" | "updatedAt" | "publicationPolicy" | "accessMode">
  & { publicationPolicy?: PublicationPolicy; accessMode?: ReviewAccessMode };

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
  claimNextQueued(): ReviewJob | undefined;
  markRunning(id: string): ReviewJob | undefined;
  markSucceeded(id: string, result: ReviewReport): ReviewJob | undefined;
  markFailed(id: string, error: string): ReviewJob | undefined;
  persistReportAndEnqueuePublish(id: string, result: ReviewReport): ReviewJob | undefined;
  getPublishOutbox(jobId: string): PublishOutboxItem[];
  claimPublishOutboxItem(owner: string, leaseDurationMs: number, limit?: number): PublishOutboxItem[];
  markPublishOutboxSuccess(id: string, owner: string, leaseGeneration: number, status: "published" | "skipped", externalId?: string): boolean;
  markPublishOutboxRetry(id: string, owner: string, leaseGeneration: number, error: string, backoffMs: number): boolean;
  markPublishOutboxFailed(id: string, owner: string, leaseGeneration: number, error: string): boolean;
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
  private readonly publishOutbox = new Map<string, PublishOutboxItem[]>();

  enqueue(input: CreateReviewJobInput): ReviewJob {
    const now = new Date().toISOString();
    const accessMode = input.accessMode ?? "github_app";
    const job: ReviewJob = {
      ...input,
      installationId: accessMode === "public_read" ? undefined : input.installationId,
      publicationPolicy: accessMode === "public_read" ? "disabled" : input.publicationPolicy ?? "github_comment",
      accessMode,
      id: `job_${randomUUID()}`,
      status: "queued",
      createdAt: now,
      updatedAt: now
    };
    this.jobs.set(job.id, job);
    return job;
  }

  list(): ReviewJob[] {
    return Array.from(this.jobs.values()).sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    );
  }

  get(id: string): ReviewJob | undefined {
    return this.jobs.get(id);
  }

  nextQueued(): ReviewJob | undefined {
    return this.list().find(job => job.status === "queued");
  }

  claimNextQueued(): ReviewJob | undefined {
    const job = this.nextQueued();
    if (!job) return undefined;
    return this.markRunning(job.id);
  }

  markRunning(id: string): ReviewJob | undefined {
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued") return undefined;
    const now = new Date().toISOString();
    const updated: ReviewJob = {
      ...job,
      status: "running",
      startedAt: now,
      updatedAt: now
    };
    this.jobs.set(id, updated);
    return updated;
  }

  markSucceeded(id: string, result: ReviewReport): ReviewJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const validatedReport = reviewReportSchema.parse(result);
    const now = new Date().toISOString();
    const updated: ReviewJob = {
      ...job,
      status: "succeeded",
      result: validatedReport,
      finishedAt: now,
      updatedAt: now
    };
    this.jobs.set(id, updated);
    return updated;
  }

  markFailed(id: string, error: string): ReviewJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
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

  persistReportAndEnqueuePublish(id: string, result: ReviewReport): ReviewJob | undefined {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Job not found for persistReportAndEnqueuePublish: ${id}`);
    }

    if (job.status === "publishing" || job.status === "succeeded" || job.status === "publish_failed") {
      // Terminal or active publish phase: complete no-op without report validation or state mutation
      return job;
    }

    if (job.status !== "running" && job.status !== "awaiting_publish") {
      throw new Error(`Invalid job status '${job.status}' for persistReportAndEnqueuePublish`);
    }

    // Validate report schema AFTER passing job status checks
    const validatedReport = reviewReportSchema.parse(result);

    const now = new Date().toISOString();
    if (job.publicationPolicy === "disabled") {
      const updated: ReviewJob = {
        ...job,
        status: "succeeded",
        result: validatedReport,
        finishedAt: now,
        updatedAt: now
      };
      this.jobs.set(id, updated);
      this.commentStatuses.set(id, { status: "skipped" });
      return updated;
    }

    const updated: ReviewJob = {
      ...job,
      status: "awaiting_publish",
      result: validatedReport,
      updatedAt: now
    };
    this.jobs.set(id, updated);
    this.commentStatuses.set(id, { status: "pending" });

    // Deduplicated Outbox insertion (target: 'github_comment')
    const existingOutbox = this.publishOutbox.get(id) ?? [];
    if (!existingOutbox.some(item => item.target === "github_comment")) {
      const outboxItem: PublishOutboxItem = {
        id: `outbox_${randomUUID()}`,
        jobId: id,
        target: "github_comment",
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseGeneration: 0,
        lastError: null,
        externalId: null,
        createdAt: now,
        updatedAt: now
      };
      this.publishOutbox.set(id, [...existingOutbox, outboxItem]);
    }

    return updated;
  }

  getPublishOutbox(jobId: string): PublishOutboxItem[] {
    const items = this.publishOutbox.get(jobId) ?? [];
    return items.map(item => publishOutboxItemSchema.parse(item));
  }

  claimPublishOutboxItem(owner: string, leaseDurationMs: number, limit = 1): PublishOutboxItem[] {
    if (limit <= 0) return [];
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAtIso = new Date(now.getTime() + leaseDurationMs).toISOString();

    const claimedItems: PublishOutboxItem[] = [];

    for (const [jobId, outboxItems] of this.publishOutbox.entries()) {
      const job = this.jobs.get(jobId);
      if (!job) continue;

      for (let i = 0; i < outboxItems.length; i++) {
        if (claimedItems.length >= limit) break;
        const item = outboxItems[i]!;

        const isPendingOrRetrying =
          (item.status === "pending" || item.status === "retrying") &&
          (item.nextAttemptAt === null || item.nextAttemptAt <= nowIso) &&
          job.status === "awaiting_publish";

        const isExpiredLease =
          item.status === "leased" &&
          Boolean(item.leaseExpiresAt) &&
          item.leaseExpiresAt! <= nowIso &&
          job.status === "publishing";

        if (isPendingOrRetrying || isExpiredLease) {
          const updatedItem: PublishOutboxItem = {
            ...item,
            status: "leased",
            leaseOwner: owner,
            leaseExpiresAt: leaseExpiresAtIso,
            leaseGeneration: item.leaseGeneration + 1,
            updatedAt: nowIso
          };
          outboxItems[i] = updatedItem;
          claimedItems.push(publishOutboxItemSchema.parse(updatedItem));

          // Update job status to publishing
          if (job.status === "awaiting_publish") {
            this.jobs.set(jobId, { ...job, status: "publishing", updatedAt: nowIso });
          }
        }
      }
      if (claimedItems.length >= limit) break;
    }

    return claimedItems;
  }

  markPublishOutboxSuccess(
    id: string,
    owner: string,
    leaseGeneration: number,
    status: "published" | "skipped",
    externalId?: string
  ): boolean {
    const nowIso = new Date().toISOString();
    for (const [jobId, outboxItems] of this.publishOutbox.entries()) {
      const index = outboxItems.findIndex(item => item.id === id);
      if (index !== -1) {
        const item = outboxItems[index]!;
        const job = this.jobs.get(jobId);

        // Fencing token & job status checks
        if (item.status !== "leased" || item.leaseOwner !== owner || item.leaseGeneration !== leaseGeneration || !job || job.status !== "publishing") {
          return false;
        }

        const updatedItem: PublishOutboxItem = {
          ...item,
          status,
          externalId: externalId ?? item.externalId,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: nowIso
        };
        outboxItems[index] = updatedItem;

        this.jobs.set(jobId, {
          ...job,
          status: "succeeded",
          finishedAt: nowIso,
          updatedAt: nowIso
        });
        this.commentStatuses.set(jobId, { status });
        return true;
      }
    }
    return false;
  }

  markPublishOutboxRetry(
    id: string,
    owner: string,
    leaseGeneration: number,
    error: string,
    backoffMs: number
  ): boolean {
    const now = new Date();
    const nowIso = now.toISOString();
    const nextAttemptAtIso = new Date(now.getTime() + backoffMs).toISOString();

    for (const [jobId, outboxItems] of this.publishOutbox.entries()) {
      const index = outboxItems.findIndex(item => item.id === id);
      if (index !== -1) {
        const item = outboxItems[index]!;
        const job = this.jobs.get(jobId);

        if (item.status !== "leased" || item.leaseOwner !== owner || item.leaseGeneration !== leaseGeneration || !job || job.status !== "publishing") {
          return false;
        }

        const updatedItem: PublishOutboxItem = {
          ...item,
          attemptCount: item.attemptCount + 1,
          status: "retrying",
          nextAttemptAt: nextAttemptAtIso,
          lastError: error.slice(0, 500),
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: nowIso
        };
        outboxItems[index] = updatedItem;

        this.jobs.set(jobId, {
          ...job,
          status: "awaiting_publish",
          updatedAt: nowIso
        });
        this.commentStatuses.set(jobId, { status: "pending", error: error.slice(0, 500) });
        return true;
      }
    }
    return false;
  }

  markPublishOutboxFailed(
    id: string,
    owner: string,
    leaseGeneration: number,
    error: string
  ): boolean {
    const nowIso = new Date().toISOString();
    for (const [jobId, outboxItems] of this.publishOutbox.entries()) {
      const index = outboxItems.findIndex(item => item.id === id);
      if (index !== -1) {
        const item = outboxItems[index]!;
        const job = this.jobs.get(jobId);

        if (item.status !== "leased" || item.leaseOwner !== owner || item.leaseGeneration !== leaseGeneration || !job || job.status !== "publishing") {
          return false;
        }

        const updatedItem: PublishOutboxItem = {
          ...item,
          attemptCount: item.attemptCount + 1,
          status: "failed",
          lastError: error.slice(0, 500),
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: nowIso
        };
        outboxItems[index] = updatedItem;

        this.jobs.set(jobId, {
          ...job,
          status: "publish_failed",
          error: error.slice(0, 500),
          finishedAt: nowIso,
          updatedAt: nowIso
        });
        this.commentStatuses.set(jobId, { status: "failed", error: error.slice(0, 500) });
        return true;
      }
    }
    return false;
  }

  updateStatus(id: string, status: JobStatus, error?: string): ReviewJob | undefined {
    if (status === "running") return this.markRunning(id);
    if (status === "failed") return this.markFailed(id, error ?? "Job failed");
    const now = new Date().toISOString();
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const updated: ReviewJob = {
      ...job,
      status,
      error,
      updatedAt: now
    };
    this.jobs.set(id, updated);
    return updated;
  }

  acceptWebhookJob(input: WebhookJobInput): WebhookAcceptance {
    const existing = this.deliveries.get(input.delivery.deliveryId);
    if (existing) {
      const job = Array.from(this.jobs.values()).find(item => item.deliveryId === input.delivery.deliveryId);
      return { duplicate: true, delivery: existing, job };
    }
    const delivery = this.recordWebhookDelivery({ ...input.delivery, status: "enqueued" }).delivery;
    const job = this.enqueue({ ...input.job, deliveryId: input.delivery.deliveryId });
    return { duplicate: false, delivery, job };
  }

  recordWebhookDelivery(input: Omit<WebhookDelivery, "receivedAt"> & { receivedAt?: string }): WebhookAcceptance {
    const existing = this.deliveries.get(input.deliveryId);
    if (existing) {
      return { duplicate: true, delivery: existing };
    }
    const delivery: WebhookDelivery = {
      ...input,
      receivedAt: input.receivedAt ?? new Date().toISOString()
    };
    this.deliveries.set(input.deliveryId, delivery);
    return { duplicate: false, delivery };
  }

  getWebhookDelivery(deliveryId: string): WebhookDelivery | undefined {
    return this.deliveries.get(deliveryId);
  }

  saveAgentRun(agentRun: AgentRun): void {
    this.agentRuns.set(agentRun.id, agentRun);
  }

  listAgentRuns(jobId: string): AgentRun[] {
    return Array.from(this.agentRuns.values()).filter(run => run.jobId === jobId);
  }

  recoverStaleRunningJobs(cutoff: Date): number {
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "running" && job.startedAt && new Date(job.startedAt) < cutoff) {
        this.markFailed(job.id, "Job execution timed out while running");
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
