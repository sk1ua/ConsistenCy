import type { ReviewJob, ReviewJobStore } from "../jobQueue";
import type { ReviewWorkflowDependencies } from "../review/graph/workflow";
import { runReviewWorkflow } from "../review/graph/workflow";

export type WorkerStatus = {
  running: boolean;
  activeJobs: number;
  concurrency: number;
  lastPollAt?: string;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown review worker failure";
}

function workflowInput(job: ReviewJob) {
  if (!job.pullRequestNumber || !job.installationId || !job.baseSha || !job.headSha) {
    throw new Error("PR review job is missing pull request metadata or installation id");
  }
  return {
    jobId: job.id,
    repositoryFullName: job.repository,
    pullRequestNumber: job.pullRequestNumber,
    installationId: job.installationId,
    baseSha: job.baseSha,
    headSha: job.headSha
  };
}

export class ReviewWorker {
  private running = false;
  private activeJobs = 0;
  private lastPollAt?: string;
  private loopPromise?: Promise<void>;

  constructor(private readonly options: {
    jobStore: ReviewJobStore;
    workflow: Omit<ReviewWorkflowDependencies, "jobStore">;
    concurrency?: number;
    pollIntervalMs?: number;
    onError?: (error: unknown, job?: ReviewJob) => void;
  }) {}

  status(): WorkerStatus {
    return {
      running: this.running,
      activeJobs: this.activeJobs,
      concurrency: this.options.concurrency ?? 1,
      lastPollAt: this.lastPollAt
    };
  }

  async execute(job: ReviewJob): Promise<void> {
    this.activeJobs += 1;
    try {
      await runReviewWorkflow(workflowInput(job), {
        ...this.options.workflow,
        jobStore: this.options.jobStore
      });
    } catch (error) {
      const current = this.options.jobStore.get(job.id);
      if (current?.status !== "succeeded") {
        this.options.jobStore.markFailed(job.id, errorMessage(error));
      }
      this.options.onError?.(error, job);
    } finally {
      this.activeJobs -= 1;
    }
  }

  async runOnce(): Promise<number> {
    this.lastPollAt = new Date().toISOString();
    const claimed: ReviewJob[] = [];
    const concurrency = this.options.concurrency ?? 1;
    while (claimed.length < concurrency) {
      const job = this.options.jobStore.claimNextQueued();
      if (!job) break;
      claimed.push(job);
    }
    await Promise.all(claimed.map(job => this.execute(job)));
    return claimed.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const processed = await this.runOnce();
      if (this.running && processed === 0) {
        await delay(this.options.pollIntervalMs ?? 1_000);
      }
    }
  }
}
