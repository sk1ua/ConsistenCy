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
  retrieval: {
    strategy: "hybrid_path_symbol_signal_callsite_ownership_local_similarity",
    context_budget_tokens: 2000,
    summary: {
      files_with_evidence: 1,
      total_selected_evidence: 3,
      average_selected_evidence_count: 3,
      average_compression_ratio: 0.31
    },
    packs: [
      {
        file: "apps/api/src/http.ts",
        retrieval_strategy: "hybrid_path_symbol_signal_callsite_ownership_local_similarity",
        context_budget_tokens: 2000,
        query: {
          file: "apps/api/src/http.ts",
          path_terms: ["apps", "api", "src", "http"],
          symbol_terms: ["registerRoutes", "requireAuth"],
          import_terms: ["zod", "pino"],
          risk_terms: ["security", "structural"],
          natural_query: "security structural risk around registerRoutes requireAuth zod pino",
          metadata: { rank_in_pr: 1, primary_risk_region: "L88-L112" }
        },
        selected_evidence: [
          {
            candidate: {
              id: "changed_hunk:demo-auth-route",
              file: "apps/api/src/http.ts",
              kind: "changed_hunk",
              source: "diff_excerpt",
              content: "+ router.post('/jobs', createJobHandler)\n+ router.get('/jobs/:id/report', getReportHandler)",
              metadata: { signal_name: "security" }
            },
            score: {
              total: 0.86,
              path_relevance: 0.25,
              symbol_overlap: 0.16,
              import_overlap: 0,
              risk_signal_overlap: 0.14,
              changed_line_proximity: 0.12,
              severity_boost: 0,
              history_boost: 0,
              security_boost: 0.1,
              local_similarity: 0.09,
              reasons: [
                "matched changed file path",
                "overlaps with security risk signal",
                "security evidence receives override boost",
                "local similarity matched query context"
              ]
            },
            why_selected: [
              "matched changed file path",
              "overlaps with security risk signal",
              "security evidence receives override boost",
              "local similarity matched query context"
            ]
          },
          {
            candidate: {
              id: "agent_finding:demo-auth-evidence",
              file: "apps/api/src/http.ts",
              kind: "agent_finding",
              source: "evidence_chain:security",
              content: "SecurityAgent flagged management routes because the evidence excerpt did not show a bearer-token guard.",
              metadata: { signal_name: "security", confidence: 0.68 }
            },
            score: {
              total: 0.62,
              reasons: ["matched changed file path", "overlaps with security risk signal"]
            },
            why_selected: ["matched changed file path", "overlaps with security risk signal"]
          },
          {
            candidate: {
              id: "history_signal:demo-hotspot",
              file: "apps/api/src/http.ts",
              kind: "history_signal",
              source: "evidence_summary:hotspot_impact",
              content: "Hotspot impact: this API boundary has repeated churn in recent PRs.",
              metadata: { type: "hotspot_impact" }
            },
            score: {
              total: 0.42,
              reasons: ["history evidence supports reviewer prioritization"]
            },
            why_selected: ["history evidence supports reviewer prioritization"]
          }
        ],
        discarded_candidates: [
          {
            candidate_id: "file_snippet:demo-low-overlap",
            kind: "file_snippet",
            score: 0.18,
            why_discarded: ["below selected evidence cutoff"]
          }
        ],
        compression: {
          candidate_count: 7,
          selected_count: 3,
          estimated_input_tokens: 920,
          estimated_output_tokens: 285,
          compression_ratio: 0.31
        }
      }
    ]
  },
  createdAt: "2026-06-10T15:00:02.000Z"
});
