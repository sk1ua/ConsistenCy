/**
 * Review job cancellation (audit P1-07①).
 *
 * Cancellation must reach three layers, not just the database row:
 *   1. the live Kernel run — stop further agent admission AND abort the
 *      in-flight provider request (RuntimeRegistry → workload.cancelRun);
 *   2. the queue/store row — `cancelled` is a real JobStatus, the worker
 *      refuses to overwrite it with `failed` afterwards;
 *   3. honest refusals — unknown jobs 404, terminal jobs 409 (including
 *      publication in flight, which is not cancellable).
 */

import { ApiError } from "../http";
import type { JobStatus, ReviewJob, ReviewJobStore } from "../jobQueue";
import type { RunCancelSignal, RuntimeRegistry } from "./runtimeRegistry";

/** Statuses after which cancellation is meaningless or unsafe. */
const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "publish_failed",
  "awaiting_publish",
  "publishing",
]);

export function jobIsCancellable(status: JobStatus): boolean {
  return !TERMINAL_JOB_STATUSES.has(status);
}

/** H13: the job row plus the honest cancel causal record for the response. */
export interface JobCancelResult {
  readonly job: ReviewJob;
  readonly cancellation: RunCancelSignal;
}

export async function cancelReviewJob(
  jobId: string,
  dependencies: { jobs: ReviewJobStore; runtimeRegistry?: RuntimeRegistry }
): Promise<JobCancelResult> {
  const job = dependencies.jobs.get(jobId);
  if (!job) throw new ApiError("Job not found", "JOB_NOT_FOUND", 404);
  if (!jobIsCancellable(job.status)) {
    throw new ApiError(`Job is already ${job.status}`, "JOB_ALREADY_TERMINAL", 409);
  }

  // Live-run signal first: a running workload stops admitting agents, its
  // in-flight provider call aborts at the transport level, and its budget
  // ledger settles (H13). A queued job (or a running job without a live
  // registration) simply never starts. The signal record is surfaced to the
  // caller — `externalOutcome: "unknown"` means exactly that: the registry
  // does NOT promise the provider call or child process has stopped.
  const cancellation = dependencies.runtimeRegistry?.requestCancelByJob(jobId) ?? {
    signalled: false,
    cancelId: "jobcancel_unregistered",
    mode: "unregistered" as const,
    externalOutcome: "unknown" as const,
  };

  const updated = dependencies.jobs.updateStatus(jobId, "cancelled", "Cancelled by request");
  if (!updated) throw new ApiError("Job not found", "JOB_NOT_FOUND", 404);
  return { job: updated, cancellation };
}
