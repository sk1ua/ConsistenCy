import { describe, expect, it } from "vitest";
import { reviewJobSchema, WORKING_TREE_REV } from "@consistency/schema";
import { toApiJob } from "./jobView";
import type { ReviewJob } from "../jobQueue";

describe("toApiJob", () => {
  it("keeps repoPath for local jobs so the wire schema accepts them", () => {
    const job: ReviewJob = {
      id: "job_local",
      kind: "pull_request",
      status: "queued",
      repository: "ConsistenCy",
      repoPath: "D:/workspaces/ConsistenCy",
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: "a".repeat(40),
      headSha: WORKING_TREE_REV,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z"
    };
    const apiJob = toApiJob(job);
    expect(apiJob.repoPath).toBe("D:/workspaces/ConsistenCy");
    expect(() => reviewJobSchema.parse(apiJob)).not.toThrow();
  });

  it("carries pull request metadata for GitHub jobs", () => {
    const job: ReviewJob = {
      id: "job_pr",
      kind: "pull_request",
      status: "queued",
      repository: "owner/repo",
      pullRequestNumber: 42,
      installationId: 7,
      accessMode: "github_app",
      publicationPolicy: "github_comment",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z"
    };
    const apiJob = toApiJob(job);
    expect(apiJob.pullRequestNumber).toBe(42);
    expect(() => reviewJobSchema.parse(apiJob)).not.toThrow();
  });
});
