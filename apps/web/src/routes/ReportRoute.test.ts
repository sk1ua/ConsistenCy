import { describe, expect, it } from "vitest";
import { runModeFromPath, matchJobRepositoryId } from "./ReportRoute";
import type { ReviewJob, Repository } from "@consistency/schema";

describe("run route modes", () => {
  it("selects each canonical run workbench mode from the pathname", () => {
    expect(runModeFromPath("/runs/run-1/overview")).toBe("overview");
    expect(runModeFromPath("/runs/run-1/diff")).toBe("diff");
    expect(runModeFromPath("/runs/run-1/evidence")).toBe("evidence");
    expect(runModeFromPath("/runs/run-1/notebook")).toBe("notebook");
  });

  it("falls back to overview for compatibility routes", () => {
    expect(runModeFromPath("/reports/run-1")).toBe("overview");
    expect(runModeFromPath("/runs/run-1/unknown")).toBe("overview");
  });
});

describe("matchJobRepositoryId", () => {
  const repo1: Repository = {
    id: "repo-123",
    displayName: "my-display",
    remoteFullName: "owner/my-repo",
    source: "github",
    trustLevel: "untrusted_readonly",
    monitoringEnabled: false,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z"
  };

  const baseJob: ReviewJob = {
    id: "job-1",
    type: "PR_REVIEW",
    status: "succeeded",
    repositoryFullName: "owner/my-repo", // matches remoteFullName
    accessMode: "github_app",
    baseSha: "123",
    headSha: "456",
    publicationPolicy: "disabled",
    createdAt: "2026-08-14T00:00:00.000Z",
    startedAt: "2026-08-14T00:00:00.000Z",
    finishedAt: "2026-08-14T00:00:00.000Z"
  };

  it("matches job to repository using remoteFullName", () => {
    expect(matchJobRepositoryId(baseJob, [repo1])).toBe("repo-123");
  });

  it("matches job to repository using exact ID", () => {
    const jobWithIdMatch = { ...baseJob, repositoryFullName: "repo-123" };
    expect(matchJobRepositoryId(jobWithIdMatch, [repo1])).toBe("repo-123");
  });

  it("never matches using displayName fallback", () => {
    const jobWithDisplay = { ...baseJob, repositoryFullName: "my-display" };
    expect(matchJobRepositoryId(jobWithDisplay, [repo1])).toBeUndefined();
  });

  it("returns undefined if no truthful association is found", () => {
    const jobWithUnknown = { ...baseJob, repositoryFullName: "unknown/repo" };
    expect(matchJobRepositoryId(jobWithUnknown, [repo1])).toBeUndefined();
  });

  it("returns undefined if job is undefined", () => {
    expect(matchJobRepositoryId(undefined, [repo1])).toBeUndefined();
  });
});
