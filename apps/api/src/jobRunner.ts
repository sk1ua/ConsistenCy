import { resolve } from "node:path";
import type { ReviewJob, ReviewJobStore } from "./jobQueue";
import {
  buildPRReportWithPython,
  PythonBridgeError,
  repoRoot,
  type RunProcess
} from "./pythonBridge";
import { adaptLegacyReport } from "./review/legacyReportAdapter";

export class JobRunnerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "JobRunnerError";
  }
}

function sanitizeError(error: unknown): string {
  if (error instanceof PythonBridgeError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown job runner error";
}

function repoPathForJob(job: ReviewJob): string {
  return resolve(job.repoPath ?? process.env.CONSISTENCY_JOB_REPO_PATH ?? repoRoot);
}

function assertRunnablePullRequest(job: ReviewJob): asserts job is ReviewJob & {
  kind: "pull_request";
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
} {
  if (job.kind !== "pull_request") {
    throw new JobRunnerError("Only pull_request jobs can build PR reports in the demo runner", "UNSUPPORTED_JOB_KIND");
  }
  if (!job.repository || !job.pullRequestNumber || !job.baseSha || !job.headSha) {
    throw new JobRunnerError("Pull request job is missing repository, number, or base/head SHAs", "INVALID_JOB");
  }
}

export async function runReviewJob(
  jobs: ReviewJobStore,
  jobId: string,
  options: {
    runProcess?: RunProcess;
    timeoutMs?: number;
    alreadyClaimed?: boolean;
  } = {}
): Promise<ReviewJob> {
  const job = jobs.get(jobId);
  if (!job) {
    throw new JobRunnerError("Job not found", "JOB_NOT_FOUND", 404);
  }
  if (job.status === "running" && !options.alreadyClaimed) {
    throw new JobRunnerError("Job is already running", "JOB_ALREADY_RUNNING", 409);
  }
  if (job.status === "succeeded") {
    return job;
  }

  try {
    assertRunnablePullRequest(job);
    if (!options.alreadyClaimed) jobs.markRunning(job.id);
    const legacyReport = await buildPRReportWithPython(
      {
        repoPath: repoPathForJob(job),
        baseSha: job.baseSha,
        headSha: job.headSha
      },
      {
        runProcess: options.runProcess,
        timeoutMs: options.timeoutMs
      }
    );
    const result = adaptLegacyReport(legacyReport, {
      jobId: job.id,
      repositoryFullName: job.repository,
      pullRequestNumber: job.pullRequestNumber,
      baseSha: job.baseSha,
      headSha: job.headSha,
      createdAt: new Date().toISOString()
    });
    const updated = jobs.markSucceeded(job.id, result);
    if (!updated) {
      throw new JobRunnerError("Job disappeared while running", "JOB_NOT_FOUND", 404);
    }
    return updated;
  } catch (error) {
    jobs.markFailed(job.id, sanitizeError(error));
    throw error;
  }
}

export async function runNextReviewJob(
  jobs: ReviewJobStore,
  options: {
    runProcess?: RunProcess;
    timeoutMs?: number;
  } = {}
): Promise<ReviewJob | undefined> {
  const job = jobs.claimNextQueued();
  if (!job) {
    return undefined;
  }
  return runReviewJob(jobs, job.id, { ...options, alreadyClaimed: true });
}
