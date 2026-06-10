import { parseReviewReport } from "./report";

export const demoReviewReport = parseReviewReport({
  jobId: "job_demo_001",
  repositoryFullName: "sk1ua/ConsistenCy",
  pullRequestNumber: 34,
  baseSha: "8b3fabb",
  headSha: "2894e50",
  summary: "Demo review generated from the canonical ConsistenCy report contract.",
  score: 74,
  riskLevel: "medium",
  agentRuns: [
    {
      id: "run_demo_security",
      jobId: "job_demo_001",
      agentName: "Security",
      status: "succeeded",
      startedAt: "2026-06-10T15:00:00.000Z",
      finishedAt: "2026-06-10T15:00:01.000Z",
      inputSummary: "Reviewed API and webhook changes.",
      findings: [
        {
          id: "finding_demo_001",
          agent: "Security",
          title: "API authorization requires verification",
          severity: "medium",
          confidence: "hypothesis",
          file: "apps/api/src/http.ts",
          evidence: "The current API routes do not expose an authorization guard in the reviewed excerpt.",
          reasoning: "Management endpoints may be reachable without an API token.",
          recommendation: "Add a bearer-token guard before exposing management routes.",
          uncertainty: "The deployment proxy configuration was not available to the reviewer.",
          tags: ["api", "authorization"]
        }
      ]
    }
  ],
  findings: [
    {
      id: "finding_demo_001",
      agent: "Security",
      title: "API authorization requires verification",
      severity: "medium",
      confidence: "hypothesis",
      file: "apps/api/src/http.ts",
      evidence: "The current API routes do not expose an authorization guard in the reviewed excerpt.",
      reasoning: "Management endpoints may be reachable without an API token.",
      recommendation: "Add a bearer-token guard before exposing management routes.",
      uncertainty: "The deployment proxy configuration was not available to the reviewer.",
      tags: ["api", "authorization"]
    }
  ],
  createdAt: "2026-06-10T15:00:02.000Z"
});

