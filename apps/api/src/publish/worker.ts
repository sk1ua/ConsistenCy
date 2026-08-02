import { randomUUID } from "node:crypto";
import type { PublishOutboxItem } from "@consistency/schema";
import type { ReviewJob, ReviewJobStore } from "../jobQueue";
import { PermanentPublishError, PublishError } from "./error";
import { classifyGitHubError, type PublishToGitHubOptions } from "./githubPublisher";
import { sanitizePublishFailure } from "../security/redact";

export type PublishWorkerDependencies = {
  jobStore: ReviewJobStore;
  tokenFetcher: (job: ReviewJob, signal: AbortSignal, options?: { forceRefresh?: boolean }) => Promise<string>;
  publisher: (options: PublishToGitHubOptions) => Promise<{ commentId: string }>;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  publishTimeoutMs?: number;
  safetyMarginMs?: number;
  maxAttempts?: number;
  concurrency?: number;
  backoffCalculator?: (attemptCount: number) => number;
  workerId?: string;
  onError?: (error: unknown, item: PublishOutboxItem) => void;
};

export class PublishWorker {
  private readonly jobStore: ReviewJobStore;
  private readonly tokenFetcher: (job: ReviewJob, signal: AbortSignal, options?: { forceRefresh?: boolean }) => Promise<string>;
  private readonly publisher: (options: PublishToGitHubOptions) => Promise<{ commentId: string }>;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly publishTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly concurrency: number;
  private readonly backoffCalculator?: (attemptCount: number) => number;
  private readonly workerId: string;
  private readonly onError: (error: unknown, item: PublishOutboxItem) => void;

  private running = false;
  private timer?: NodeJS.Timeout;
  private activeClaims = 0;
  private stopController?: AbortController;
  private activeTaskPromises = new Set<Promise<void>>();
  private loopPromise?: Promise<void>;
  private wakePoll?: () => void;

  constructor(deps: PublishWorkerDependencies) {
    this.jobStore = deps.jobStore;
    this.tokenFetcher = deps.tokenFetcher;
    this.publisher = deps.publisher;
    this.pollIntervalMs = deps.pollIntervalMs ?? 1000;
    this.leaseDurationMs = deps.leaseDurationMs ?? 30000;
    this.publishTimeoutMs = deps.publishTimeoutMs ?? 15000;
    const safetyMarginMs = deps.safetyMarginMs ?? 5000;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.concurrency = deps.concurrency ?? 1;
    this.backoffCalculator = deps.backoffCalculator;
    this.workerId = deps.workerId ?? `worker_pub_${randomUUID()}`;
    this.onError = deps.onError ?? ((error, item) => {
      console.error(`[PublishWorker ${this.workerId}] Unhandled task error for item ${item.id}:`, error);
    });

    if (this.leaseDurationMs <= this.publishTimeoutMs + safetyMarginMs) {
      throw new Error(`leaseDurationMs (${this.leaseDurationMs}) must be greater than publishTimeoutMs + safetyMarginMs (${this.publishTimeoutMs + safetyMarginMs})`);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopController = new AbortController();
    this.loopPromise = this.pollLoop();
  }

  async stop(): Promise<void> {
    if (!this.running && !this.loopPromise) return;
    this.running = false;
    this.stopController?.abort();
    this.wakePoll?.();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const loopPromise = this.loopPromise;
    try {
      await loopPromise;
    } finally {
      await Promise.allSettled([...this.activeTaskPromises]);
      if (this.loopPromise === loopPromise) {
        this.loopPromise = undefined;
      }
    }
  }

  status(): { running: boolean; activeClaims: number; workerId: string } {
    return {
      running: this.running,
      activeClaims: this.activeClaims,
      workerId: this.workerId
    };
  }

  private async pollLoop(): Promise<void> {
    while (this.running && !this.stopController?.signal.aborted) {
      try {
        await this.pollOnce();
      } catch (error) {
        console.error(`[PublishWorker ${this.workerId}] Unhandled polling error:`, error);
      }

      if (!this.running || this.stopController?.signal.aborted) break;

      await new Promise<void>((resolve) => {
        this.timer = setTimeout(resolve, this.pollIntervalMs);
        this.wakePoll = resolve;
      });
      this.wakePoll = undefined;
    }
  }

  private async pollOnce(): Promise<void> {
    const freeSlots = Math.max(0, this.concurrency - this.activeClaims);
    if (freeSlots === 0) {
      return; // Free slots formula guard: do NOT poll or claim when concurrency limit is reached!
    }

    const claimedItems = this.jobStore.claimPublishOutboxItem(
      this.workerId,
      this.leaseDurationMs,
      freeSlots
    );

    for (const item of claimedItems) {
      if (!this.running || this.stopController?.signal.aborted) break;
      const taskPromise = this.processClaimedItem(item);
      this.activeTaskPromises.add(taskPromise);
      void taskPromise.then(
        () => {
          this.activeTaskPromises.delete(taskPromise);
        },
        (error) => {
          this.activeTaskPromises.delete(taskPromise);
          try {
            this.onError(error, item);
          } catch {
            // Error reporting must never create a second rejected task.
          }
        }
      );
    }
  }

  private async processClaimedItem(item: PublishOutboxItem): Promise<void> {
    this.activeClaims += 1;
    const taskController = new AbortController();

    const onStopAbort = () => taskController.abort();
    this.stopController?.signal.addEventListener("abort", onStopAbort, { once: true });

    const timeoutTimer = setTimeout(() => {
      taskController.abort(new Error(`Publish attempt timed out after ${this.publishTimeoutMs}ms`));
    }, this.publishTimeoutMs);

    let currentToken: string | undefined;

    try {
      if (taskController.signal.aborted) {
        return;
      }

      const job = this.jobStore.get(item.jobId);
      if (!job || !job.result) {
        throw new PermanentPublishError(`Job or report missing for outbox item ${item.id}`);
      }

      currentToken = await this.tokenFetcher(job, taskController.signal);

      if (taskController.signal.aborted) {
        return;
      }

      try {
        const { commentId } = await this.publisher({
          report: job.result,
          repositoryFullName: job.repository,
          pullRequestNumber: job.pullRequestNumber!,
          token: currentToken,
          externalId: item.externalId,
          signal: taskController.signal
        });

        if (!taskController.signal.aborted) {
          const updated = this.jobStore.markPublishOutboxSuccess(
            item.id,
            this.workerId,
            item.leaseGeneration,
            "published",
            commentId
          );
          if (!updated) {
            console.warn(`[PublishWorker ${this.workerId}] Lost lease generation fencing token for item ${item.id}`);
          }
        }
      } catch (firstErr: any) {
        // Classify the error to check for 401
        const classified = firstErr instanceof PublishError ? firstErr : classifyGitHubError(firstErr);

        if (classified.status === 401) {
          // 401: try force-refresh once
          try {
            currentToken = await this.tokenFetcher(job, taskController.signal, { forceRefresh: true });

            const { commentId } = await this.publisher({
              report: job.result,
              repositoryFullName: job.repository,
              pullRequestNumber: job.pullRequestNumber!,
              token: currentToken,
              externalId: item.externalId,
              signal: taskController.signal
            });

            // Success after refresh
            if (!taskController.signal.aborted) {
              const updated = this.jobStore.markPublishOutboxSuccess(
                item.id,
                this.workerId,
                item.leaseGeneration,
                "published",
                commentId
              );
              if (!updated) {
                console.warn(`[PublishWorker ${this.workerId}] Lost lease generation fencing token for item ${item.id}`);
              }
            }
            return; // Successfully published after token refresh
          } catch (secondErr: any) {
            const secondClassified = secondErr instanceof PublishError ? secondErr : classifyGitHubError(secondErr);
            if (secondClassified.status === 401) {
              // 2nd 401 -> permanent failure
              throw new PermanentPublishError(
                `Authentication failed after token refresh: ${secondClassified.message}`,
                401
              );
            }
            // 5xx/network error on refresh -> normal transient retry
            throw secondClassified;
          }
        }

        // Not 401 -> rethrow for normal error handling
        throw classified;
      }
    } catch (caught: any) {
      if (taskController.signal.aborted && this.stopController?.signal.aborted) {
        // Shutdown abort: discard without mutating store
        return;
      }

      const err: PublishError = caught instanceof PublishError
        ? caught
        : classifyGitHubError(caught);

      const errorMessage = sanitizePublishFailure(err, currentToken);
      const isPermanent = err.kind === "permanent" || err instanceof PermanentPublishError;
      const isExhausted = item.attemptCount + 1 >= this.maxAttempts;

      if (isPermanent || isExhausted) {
        const updated = this.jobStore.markPublishOutboxFailed(
          item.id,
          this.workerId,
          item.leaseGeneration,
          errorMessage
        );
        if (!updated) {
          console.warn(`[PublishWorker ${this.workerId}] Lost lease generation fencing token during markFailed for item ${item.id}`);
        }
      } else {
        let backoffMs = this.backoffCalculator
          ? this.backoffCalculator(item.attemptCount)
          : Math.min(1000 * Math.pow(2, item.attemptCount) + Math.random() * 500, 60000);
        if (err.retryAt) {
          const delayFromRetryAt = err.retryAt.getTime() - Date.now();
          if (delayFromRetryAt > 0) {
            backoffMs = Math.max(backoffMs, delayFromRetryAt);
          }
        }

        const updated = this.jobStore.markPublishOutboxRetry(
          item.id,
          this.workerId,
          item.leaseGeneration,
          errorMessage,
          backoffMs
        );
        if (!updated) {
          console.warn(`[PublishWorker ${this.workerId}] Lost lease generation fencing token during markRetry for item ${item.id}`);
        }
      }
    } finally {
      clearTimeout(timeoutTimer);
      this.stopController?.signal.removeEventListener("abort", onStopAbort);
      this.activeClaims -= 1;
    }
  }
}
