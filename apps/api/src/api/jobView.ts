import type { ReviewJob as ApiReviewJob, ReviewReport, RiskLevel, StatsResponse } from "@consistency/schema";
import type { ReviewJob } from "../jobQueue";
import { sanitizePublicError } from "../security/redact";

export function toApiJob(job: ReviewJob): ApiReviewJob {
  return {
    id: job.id,
    type: "PR_REVIEW",
    status: job.status,
    repositoryFullName: job.repository,
    pullRequestNumber: job.pullRequestNumber!,
    installationId: job.installationId,
    accessMode: job.accessMode,
    baseSha: job.baseSha!,
    headSha: job.headSha!,
    publicationPolicy: job.publicationPolicy,
    llmProvider: job.llmProvider,
    llmModel: job.llmModel,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error === undefined ? undefined : sanitizePublicError(job.error),
    report: job.result
  };
}

export function filterJobs(jobs: ReviewJob[], query: URLSearchParams): ReviewJob[] {
  const status = query.get("status");
  const repository = query.get("repository")?.trim().toLowerCase();
  const severity = query.get("severity");
  return jobs.filter(job => {
    if (status && job.status !== status) return false;
    if (repository && !job.repository.toLowerCase().includes(repository)) return false;
    if (severity && !job.result?.findings.some(finding => finding.severity === severity)) return false;
    return true;
  });
}

export function recentReports(jobs: ReviewJob[], limit = 10): ReviewReport[] {
  return jobs
    .flatMap(job => job.result ? [job.result] : [])
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

export function buildStats(jobs: ReviewJob[]): StatsResponse {
  const completedDurations = jobs.flatMap(job => {
    if (!job.startedAt || !job.finishedAt) return [];
    return [Math.max(0, new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime())];
  });
  const riskDistribution: Record<RiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const repositoryCounts = new Map<string, number>();
  for (const job of jobs) {
    if (job.result) riskDistribution[job.result.riskLevel] += 1;
    repositoryCounts.set(job.repository, (repositoryCounts.get(job.repository) ?? 0) + 1);
  }
  return {
    totalJobs: jobs.length,
    succeededJobs: jobs.filter(job => job.status === "succeeded").length,
    failedJobs: jobs.filter(job => job.status === "failed" || job.status === "publish_failed").length,
    runningJobs: jobs.filter(job => job.status === "running" || job.status === "awaiting_publish" || job.status === "publishing").length,
    averageDuration: completedDurations.length > 0
      ? completedDurations.reduce((sum, duration) => sum + duration, 0) / completedDurations.length
      : 0,
    riskDistribution,
    topRepositories: [...repositoryCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([repositoryFullName, jobCount]) => ({ repositoryFullName, jobCount }))
  };
}
