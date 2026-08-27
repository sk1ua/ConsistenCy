import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { runModeFromPath, matchJobRepositoryId, ReportRoute } from "./ReportRoute";
import type { HealthResponse } from "../api/client";
import type { ReviewJob, Repository } from "@consistency/schema";
import { I18nProvider } from "../i18n";
import { createWorkspaceQueryClient } from "../query/client";
import { testJobs } from "../test/testFixtures";

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

describe("run mode tab visibility", () => {
  const baseHealth: HealthResponse = {
    ok: true,
    service: "consistency-api",
    database: { ok: true },
    worker: { running: false, activeJobs: 0, concurrency: 1 },
    llmProvider: "none",
    configuration: {
      githubAppConfigured: false,
      webhookSecretConfigured: false,
      publicReadTokenConfigured: false,
      storage: { kind: "memory", configured: true },
      workerConcurrency: 1
    }
  };

  function renderRunRoute(health?: HealthResponse): string {
    // Plain createElement calls: this suite stays a .ts file (no JSX transform).
    const runPanelRoute = createElement(Route, {
      path: "/runs/:runId/overview",
      element: createElement(ReportRoute, {
        jobs: testJobs,
        reports: [],
        repositories: [],
        health,
        jobsUnavailable: false,
        reportsUnavailable: false
      })
    });
    const tree = createElement(
      QueryClientProvider,
      { client: createWorkspaceQueryClient() },
      createElement(
        MemoryRouter,
        { initialEntries: ["/runs/job_1/overview"] },
        createElement(Routes, null, runPanelRoute)
      )
    );
    return renderToString(createElement(I18nProvider, { initialLocale: "en-US", children: tree }));
  }

  it("hides the notebook tab when the runtime reports notebook disabled", () => {
    const html = renderRunRoute({ ...baseHealth, notebook: false });
    expect(html).toContain("Overview");
    expect(html).toContain("Runtime");
    expect(html).not.toContain(">Notebook</a>");
  });

  it("keeps the notebook tab when the notebook runtime is enabled or unreported", () => {
    expect(renderRunRoute({ ...baseHealth, notebook: true })).toContain(">Notebook</a>");
    // Legacy health payloads without the flag must not lose the tab.
    expect(renderRunRoute(baseHealth)).toContain(">Notebook</a>");
  });
});
