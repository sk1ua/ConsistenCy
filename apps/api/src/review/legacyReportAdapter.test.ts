import { describe, expect, it } from "vitest";
import { parseLegacyPRReport } from "@consistency/schema";
import fixture from "../../../../tests/fixtures/pr_report_minimal.json";
import { adaptLegacyReport } from "./legacyReportAdapter";

const metadata = {
  jobId: "job-test",
  repositoryFullName: "sk1ua/ConsistenCy",
  pullRequestNumber: 34,
  baseSha: "base123",
  headSha: "head456",
  createdAt: "2026-06-10T15:00:00.000Z"
};

describe("adaptLegacyReport", () => {
  it("deterministically converts Python output to the canonical report", () => {
    const report = adaptLegacyReport(parseLegacyPRReport(fixture), metadata);
    expect(report).toMatchObject({
      jobId: "job-test",
      score: 58,
      riskLevel: "high",
      repositoryFullName: "sk1ua/ConsistenCy"
    });
    expect(report.findings[0]?.file).toBe("docs/EVALUATION.md");
    expect(report.agentRuns[0]?.agentName).toBe("PythonCompatibilityAdapter");
  });

  it("never promotes file-level legacy signals to confirmed findings", () => {
    const report = adaptLegacyReport(parseLegacyPRReport(fixture), metadata);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.every(finding => finding.confidence === "hypothesis")).toBe(true);
    expect(report.findings.every(finding => "uncertainty" in finding)).toBe(true);
  });
});
