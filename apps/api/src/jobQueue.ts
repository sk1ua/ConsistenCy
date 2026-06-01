export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export type ReviewJobKind = "pull_request" | "push";

export type ReviewJob = {
  id: string;
  kind: ReviewJobKind;
  status: JobStatus;
  deliveryId: string;
  repository: string;
  installationId?: number;
  pullRequestNumber?: number;
  baseSha?: string;
  headSha?: string;
  ref?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
};

export type CreateReviewJobInput = Omit<ReviewJob, "id" | "status" | "createdAt" | "updatedAt">;

export class InMemoryJobQueue {
  private readonly jobs = new Map<string, ReviewJob>();
  private nextId = 1;

  enqueue(input: CreateReviewJobInput): ReviewJob {
    const now = new Date().toISOString();
    const job: ReviewJob = {
      ...input,
      id: `job_${this.nextId++}`,
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

  updateStatus(id: string, status: JobStatus, error?: string): ReviewJob | undefined {
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
