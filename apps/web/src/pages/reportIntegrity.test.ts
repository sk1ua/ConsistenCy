import { describe, expect, it } from "vitest";
import { mockJobs, mockReports } from "../demo/mockReports";
import { bindReportToJob } from "./reportIntegrity";

describe("report integrity binding", () => {
  it("accepts a report only when its stable identity matches the job", () => {
    const job = mockJobs[0]!;
    const report = mockReports[0]!;
    expect(bindReportToJob(job, report)).toEqual({ status: "bound", report });
  });

  it("withholds a stale report after a job switch", () => {
    expect(bindReportToJob(mockJobs[1]!, mockReports[0]!)).toEqual({ status: "mismatch" });
  });

  it("withholds nested agent runs from another job", () => {
    const job = mockJobs[0]!;
    const report = mockReports[0]!;
    const mismatched = {
      ...report,
      agentRuns: report.agentRuns.map((run, index) => index === 0 ? { ...run, jobId: "job-other" } : run)
    };

    expect(bindReportToJob(job, mismatched)).toEqual({ status: "mismatch" });
  });
});
