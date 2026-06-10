import {
  parseReviewReport,
  riskLevelForScore,
  type LegacyPRReport,
  type ReviewFinding,
  type ReviewReport,
  type Severity
} from "@consistency/schema";

export type LegacyReportMetadata = {
  jobId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  createdAt: string;
};

function recordValue(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function stringValue(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function severityForRisk(risk: number): Severity {
  if (risk >= 0.8) return "critical";
  if (risk >= 0.6) return "high";
  if (risk >= 0.35) return "medium";
  if (risk >= 0.15) return "low";
  return "info";
}

function securityHypotheses(report: LegacyPRReport, metadata: LegacyReportMetadata): ReviewFinding[] {
  return report.security_findings.flatMap((rawFinding, index) => {
    const finding = recordValue(rawFinding);
    const file = stringValue(finding, "file", "filepath", "path");
    if (!file) {
      return [];
    }
    const evidence = stringValue(finding, "evidence", "text", "message") ?? "Legacy security analysis flagged this file.";
    return [{
      id: `${metadata.jobId}:legacy-security:${index}`,
      agent: "PythonCompatibilityAdapter",
      title: stringValue(finding, "title", "rule") ?? "Legacy security signal requires verification",
      severity: "high",
      confidence: "hypothesis",
      file,
      evidence,
      reasoning: "The Python report contains a security signal but does not provide canonical line-level evidence.",
      recommendation: "Inspect the referenced file and confirm the signal before changing code.",
      uncertainty: "Exact source lines and a validated exploit path were not present in the legacy report.",
      tags: ["legacy", "security"]
    } satisfies ReviewFinding];
  });
}

function riskyFileHypotheses(report: LegacyPRReport, metadata: LegacyReportMetadata): ReviewFinding[] {
  return report.top_risky_files.slice(0, 8).map((file, index) => ({
    id: `${metadata.jobId}:legacy-risk:${index}`,
    agent: "PythonCompatibilityAdapter",
    title: `Review elevated risk in ${file.file}`,
    severity: severityForRisk(file.max_risk),
    confidence: "hypothesis",
    file: file.file,
    evidence: `Legacy analysis ranked this file #${file.rank_in_pr} with average risk ${file.avg_risk.toFixed(3)}, maximum risk ${file.max_risk.toFixed(3)}, and dominant signals: ${file.dominant_signals.join(", ") || "none"}.`,
    reasoning: "The historical analyzer detected project-specific drift, but its report does not identify a canonical line range.",
    recommendation: "Review the changed regions in this file, starting with the listed dominant signals.",
    uncertainty: "This compatibility finding is file-level and must not be treated as a confirmed defect without line evidence.",
    tags: ["legacy", ...file.dominant_signals]
  }));
}

export function adaptLegacyReport(
  legacyReport: LegacyPRReport,
  metadata: LegacyReportMetadata
): ReviewReport {
  const score = Math.max(0, Math.min(100, Math.round((1 - legacyReport.avg_risk) * 100)));
  const findings = [...securityHypotheses(legacyReport, metadata), ...riskyFileHypotheses(legacyReport, metadata)];
  const agentRun = {
    id: `${metadata.jobId}:python-compatibility`,
    jobId: metadata.jobId,
    agentName: "PythonCompatibilityAdapter" as const,
    status: "succeeded" as const,
    startedAt: metadata.createdAt,
    finishedAt: metadata.createdAt,
    inputSummary: `Adapted the legacy Python PR report for ${metadata.repositoryFullName}#${metadata.pullRequestNumber}.`,
    findings
  };

  return parseReviewReport({
    jobId: metadata.jobId,
    repositoryFullName: metadata.repositoryFullName,
    pullRequestNumber: metadata.pullRequestNumber,
    baseSha: metadata.baseSha,
    headSha: metadata.headSha,
    summary: `Python compatibility analysis produced ${findings.length} review candidate(s) with a quality score of ${score}/100.`,
    score,
    riskLevel: riskLevelForScore(score),
    agentRuns: [agentRun],
    findings,
    createdAt: metadata.createdAt
  });
}

