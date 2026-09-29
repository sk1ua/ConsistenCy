import type { ReviewJob, ReviewJobStore } from "../jobQueue";
import { ReviewCancelledError } from "@consistency/workload-review";
import { createReviewRuntime, type ReviewWorkflowDependencies } from "../review/workloadRuntime";
import { PublicPrSnapshotChangedError } from "../review/context/buildPRContext";
import { PublicPrError } from "../review/publicPr";
import { sanitizePublicError } from "../security/redact";

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
  if (error instanceof PublicPrSnapshotChangedError) return `${error.code}: ${error.message}`;
  if (error instanceof PublicPrError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? sanitizePublicError(error.message) : "Unknown review worker failure";
}

function workflowInput(job: ReviewJob) {
  if (!job.baseSha || !job.headSha) {
    throw new Error("Review job is missing revision metadata");
  }
  if (job.accessMode === "local_git") {
    if (!job.repoPath) {
      throw new Error("Local review job is missing repoPath");
    }
  } else {
    if (!job.pullRequestNumber) {
      throw new Error("PR review job is missing pull request metadata");
    }
    if (job.accessMode === "github_app" && !job.installationId) {
      throw new Error("GitHub App review job is missing installation id");
    }
  }
  return {
    jobId: job.id,
    repositoryFullName: job.repository,
    pullRequestNumber: job.pullRequestNumber,
    repoPath: job.repoPath,
    installationId: job.installationId,
    accessMode: job.accessMode,
    baseSha: job.baseSha,
    headSha: job.headSha
  };
}

export class ReviewWorker {
  private running = false;
  private activeJobs = 0;
  private lastPollAt?: string;
  private loopPromise?: Promise<void>;
  /** Generation guard: a loop abandoned by a timed-out stop() must not resurrect alongside a fresh start(). */
  private loopGeneration = 0;

  constructor(private readonly options: {
    jobStore: ReviewJobStore;
    workflow: Omit<ReviewWorkflowDependencies, "jobStore">;
    concurrency?: number;
    pollIntervalMs?: number;
    onError?: (error: unknown, job?: ReviewJob) => void;
    onSucceeded?: (job: ReviewJob) => void;
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
      let jobProvider = this.options.workflow.provider;
      if (this.options.workflow.providerFactory && (job.llmProvider || job.llmModel)) {
        jobProvider = this.options.workflow.providerFactory({
          provider: job.llmProvider,
          model: job.llmModel
        }) ?? jobProvider;
      }
      const runtime = createReviewRuntime({
        ...this.options.workflow,
        provider: jobProvider,
        jobStore: this.options.jobStore
      });
      await runtime.run({ ...workflowInput(job), publicationPolicy: job.publicationPolicy });
      this.options.onSucceeded?.(job);
    } catch (error) {
      const current = this.options.jobStore.get(job.id);
      const cancelled = error instanceof ReviewCancelledError || current?.status === "cancelled";
      if (
        !cancelled &&
        current?.status !== "succeeded" &&
        current?.status !== "awaiting_publish" &&
        current?.status !== "publishing"
      ) {
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
    this.loopGeneration += 1;
    this.loopPromise = this.loop(this.loopGeneration);
  }

  /**
   * Stop the worker loop (audit P1-07③ shutdown deadline).
   *
   * Without a grace period this waits for the current review to COMPLETE —
   * a hung provider call would block process shutdown forever. With one:
   * wait up to `graceMs`; on expiry fire `onExpiry` (the host cancels every
   * live run so in-flight provider calls abort), then wait one more grace
   * window for the loop to unwind; if it still has not, return anyway — the
   * caller logs and the process exits (a hard hang cannot be forced out of
   * a promise, but shutdown no longer blocks indefinitely on it).
   */
  async stop(grace?: { ms?: number; onExpiry?: () => void }): Promise<void> {
    this.running = false;
    const loop = this.loopPromise;
    if (!loop) return;
    const graceMs = grace?.ms ?? 0;

    if (graceMs <= 0) {
      await loop.catch(() => undefined);
    } else {
      const wait = (ms: number) => new Promise<"expired">(resolve => {
        const timer = setTimeout(() => resolve("expired"), ms);
        if (typeof timer === "object" && "unref" in timer) timer.unref();
      });
      const settle = () => loop.catch(() => undefined);
      const first = await Promise.race([loop.then(() => "done" as const), wait(graceMs)]);
      if (first === "done") {
        await settle();
      } else {
        grace?.onExpiry?.();
        // The abort should unwind the in-flight call quickly; this second
        // window bounds even a provider that ignores cancellation. If it
        // ALSO expires, give up: the loop stays detached (its own error
        // handling settles the job) and shutdown proceeds.
        const second = await Promise.race([loop.then(() => "done" as const), wait(graceMs)]);
        if (second === "done") await settle();
      }
    }

    this.loopPromise = undefined;
  }

  private async loop(generation: number): Promise<void> {
    while (this.running && generation === this.loopGeneration) {
      let processed = 0;
      try {
        processed = await this.runOnce();
      } catch (error) {
        this.options.onError?.(error);
      }
      if (this.running && generation === this.loopGeneration && processed === 0) {
        await delay(this.options.pollIntervalMs ?? 1_000);
      }
    }
  }
}
