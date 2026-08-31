import type { ReviewJob, ReviewReport, StatsResponse } from "@consistency/schema";

export const testReports: ReviewReport[] = [
  {
    jobId: "job_1",
    repositoryFullName: "sk1ua/ConsistenCy",
    pullRequestNumber: 34,
    score: 74,
    riskLevel: "medium",
    riskBand: "medium",
    summary: "Multi-agent review completed for sk1ua/ConsistenCy pull request #34.",
    baseSha: "base1234",
    headSha: "head5678",
    createdAt: "2026-08-14T10:00:00.000Z",
    agentRuns: [
      {
        id: "run_1",
        jobId: "job_1",
        agentName: "Security",
        status: "succeeded",
        startedAt: "2026-08-14T10:00:00.000Z",
        finishedAt: "2026-08-14T10:00:01.000Z",
        inputSummary: "Security analysis",
        findings: []
      }
    ],
    findings: [
      {
        id: "finding_1",
        agent: "Security",
        title: "API authorization check",
        severity: "medium",
        confidence: "hypothesis",
        file: "apps/api/src/http.ts",
        evidence: "Verify token guard.",
        reasoning: "Management routes need protection.",
        recommendation: "Add bearer token.",
        uncertainty: "Deployment proxy not visible.",
        tags: ["api", "security"]
      }
    ]
  },
  {
    jobId: "job_2",
    repositoryFullName: "acme/payments-api",
    pullRequestNumber: 182,
    score: 42,
    riskLevel: "high",
    summary: "Multi-agent review completed for acme/payments-api pull request #182.",
    baseSha: "base2345",
    headSha: "head6789",
    createdAt: "2026-08-14T11:00:00.000Z",
    agentRuns: [],
    findings: []
  }
];

export const testJobs: ReviewJob[] = [
  {
    id: "job_1",
    type: "PR_REVIEW",
    repositoryFullName: "sk1ua/ConsistenCy",
    pullRequestNumber: 34,
    baseSha: "base1234",
    headSha: "head5678",
    status: "succeeded",
    accessMode: "public_read",
    publicationPolicy: "disabled",
    createdAt: "2026-08-14T10:00:00.000Z",
    startedAt: "2026-08-14T10:00:01.000Z",
    finishedAt: "2026-08-14T10:00:05.000Z",
    report: testReports[0]
  },
  {
    id: "job_2",
    type: "PR_REVIEW",
    repositoryFullName: "acme/payments-api",
    pullRequestNumber: 182,
    baseSha: "base2345",
    headSha: "head6789",
    status: "succeeded",
    accessMode: "public_read",
    publicationPolicy: "disabled",
    createdAt: "2026-08-14T11:00:00.000Z",
    startedAt: "2026-08-14T11:00:01.000Z",
    finishedAt: "2026-08-14T11:00:06.000Z",
    report: testReports[1]
  },
  {
    id: "job_3",
    type: "PR_REVIEW",
    repositoryFullName: "sk1ua/ConsistenCy",
    pullRequestNumber: 35,
    baseSha: "base3456",
    headSha: "head7890",
    status: "running",
    accessMode: "public_read",
    publicationPolicy: "disabled",
    createdAt: "2026-08-14T12:00:00.000Z",
    startedAt: "2026-08-14T12:00:01.000Z"
  },
  {
    id: "job_4",
    type: "PR_REVIEW",
    repositoryFullName: "acme/payments-api",
    pullRequestNumber: 183,
    baseSha: "base4567",
    headSha: "head8901",
    status: "queued",
    accessMode: "public_read",
    publicationPolicy: "disabled",
    createdAt: "2026-08-14T13:00:00.000Z"
  },
  {
    id: "job_5",
    type: "PR_REVIEW",
    repositoryFullName: "studio/design-system",
    pullRequestNumber: 76,
    baseSha: "base5678",
    headSha: "head9012",
    status: "failed",
    accessMode: "public_read",
    publicationPolicy: "disabled",
    createdAt: "2026-08-14T14:00:00.000Z",
    error: "Analysis timed out"
  }
];

export const testStats: StatsResponse = {
  totalJobs: 5,
  succeededJobs: 2,
  failedJobs: 1,
  runningJobs: 1,
  averageDuration: 4500,
  riskDistribution: { critical: 0, high: 1, medium: 1, low: 0 },
  topRepositories: [{ repositoryFullName: "sk1ua/ConsistenCy", jobCount: 2 }, { repositoryFullName: "acme/payments-api", jobCount: 2 }]
};
