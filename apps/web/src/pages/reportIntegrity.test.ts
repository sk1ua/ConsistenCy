import { describe, expect, it } from "vitest";
import type { ReviewJob, ReviewReport } from "@consistency/schema";
import { testJobs, testReports } from "../test/testFixtures";
import { bindReportToJob } from "./reportIntegrity";

describe("report integrity binding", () => {
  it("accepts a report only when its stable identity matches the job", () => {
    const job: ReviewJob = testJobs[0]!;
    const report: ReviewReport = testReports[0]!;
    expect(bindReportToJob(job, report)).toEqual({ status: "bound", report });
  });

  it("withholds a stale report after a job switch", () => {
    expect(bindReportToJob(testJobs[1]!, testReports[0]!)).toEqual({ status: "mismatch" });
  });

  it("withholds nested agent runs from another job", () => {
    const job: ReviewJob = testJobs[0]!;
    const report: ReviewReport = testReports[0]!;
    const mismatched: ReviewReport = {
      ...report,
      agentRuns: report.agentRuns.map((run, index) => index === 0 ? { ...run, jobId: "job-other" } : run)
    };

    expect(bindReportToJob(job, mismatched)).toEqual({ status: "mismatch" });
  });
});
