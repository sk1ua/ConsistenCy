import {
  demoReviewReport,
  type ReviewJob,
  type ReviewReport,
  type StatsResponse
} from "@consistency/schema";

const definitions = [
  ["job_demo_consistency", "sk1ua/ConsistenCy", 34, 74, "medium"],
  ["job_demo_payments", "acme/payments-api", 182, 42, "high"],
  ["job_demo_design", "studio/design-system", 76, 91, "low"]
] as const;

export const mockReports: ReviewReport[] = definitions.map(([jobId, repositoryFullName, pullRequestNumber, score, riskLevel], index) => ({
  ...demoReviewReport,
  jobId,
  repositoryFullName,
  pullRequestNumber,
  score,
  riskLevel,
  summary: `Multi-agent review completed for ${repositoryFullName} pull request #${pullRequestNumber}.`,
  baseSha: `base${index}1234`,
  headSha: `head${index}5678`,
  createdAt: new Date(Date.now() - index * 3_600_000).toISOString(),
  agentRuns: demoReviewReport.agentRuns.map(run => ({ ...run, id: `${run.id}_${index}`, jobId })),
  findings: demoReviewReport.findings.map(finding => ({ ...finding, id: `${finding.id}_${index}` }))
}));

export const mockJobs: ReviewJob[] = [
  ...mockReports.map((report, index) => ({
    id: report.jobId,
    type: "PR_REVIEW" as const,
    status: "succeeded" as const,
    repositoryFullName: report.repositoryFullName,
    pullRequestNumber: report.pullRequestNumber,
    installationId: 1,
    baseSha: report.baseSha,
    headSha: report.headSha,
    createdAt: report.createdAt,
    startedAt: new Date(new Date(report.createdAt).getTime() - (index + 1) * 12_000).toISOString(),
    finishedAt: report.createdAt,
    report
  })),
  {
    id: "job_demo_running",
    type: "PR_REVIEW",
    status: "running",
    repositoryFullName: "acme/customer-portal",
    pullRequestNumber: 221,
    installationId: 1,
    baseSha: "base-running",
    headSha: "head-running",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString()
  }
];

export const mockStats: StatsResponse = {
  totalJobs: mockJobs.length,
  succeededJobs: 3,
  failedJobs: 0,
  runningJobs: 1,
  averageDuration: 24_000,
  riskDistribution: { critical: 0, high: 1, medium: 1, low: 1 },
  topRepositories: mockJobs.slice(0, 3).map(job => ({ repositoryFullName: job.repositoryFullName, jobCount: 1 }))
};
