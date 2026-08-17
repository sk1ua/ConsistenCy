import type { ReviewJob, ReviewReport } from "@consistency/schema";

export type ReportBinding =
  | { status: "missing" }
  | { status: "bound"; report: ReviewReport }
  | { status: "mismatch" };

/**
 * Treat reports as evidence only after every stable identity field and every
 * nested agent run points at the selected job. This prevents a fast job
 * switch from briefly rendering the previous report under the new heading.
 */
export function bindReportToJob(job: ReviewJob, report?: ReviewReport): ReportBinding {
  if (!report) return { status: "missing" };

  const sameJob = report.jobId === job.id &&
    report.repositoryFullName === job.repositoryFullName &&
    report.pullRequestNumber === job.pullRequestNumber &&
    report.baseSha === job.baseSha &&
    report.headSha === job.headSha;
  const runsBelongToJob = report.agentRuns.every(run => run.jobId === job.id);

  return sameJob && runsBelongToJob
    ? { status: "bound", report }
    : { status: "mismatch" };
}
