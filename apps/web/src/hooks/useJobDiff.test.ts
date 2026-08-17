import type { JobDiffResponse } from "@consistency/schema";
import { describe, expect, it } from "vitest";
import { loadJobDiff } from "./useJobDiff";

const availableResponse: JobDiffResponse = {
  jobId: "job-1",
  available: true,
  files: []
};

describe("loadJobDiff", () => {
  it("binds available files to the requested job", async () => {
    await expect(loadJobDiff("job-1", { jobDiff: async () => availableResponse })).resolves.toEqual({
      status: "available",
      jobId: "job-1",
      files: []
    });
  });

  it("does not treat an unavailable or undefined-like result as usable", async () => {
    await expect(loadJobDiff("job-1", {
      jobDiff: async () => ({ ...availableResponse, available: false })
    })).resolves.toEqual({ status: "unavailable", jobId: "job-1" });
  });

  it("withholds a response returned for a different job", async () => {
    const state = await loadJobDiff("job-1", {
      jobDiff: async () => ({ ...availableResponse, jobId: "job-2" })
    });

    expect(state.status).toBe("error");
    expect(state).toMatchObject({ jobId: "job-1" });
  });
});
