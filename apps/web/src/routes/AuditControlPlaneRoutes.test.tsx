import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AuditCapabilities, Automation, Repository } from "@consistency/schema";
import { I18nProvider } from "../i18n";
import { WorkflowPage } from "../pages/WorkflowPage";
import { RepositoriesPage } from "./RepositoriesPage";

const repository: Repository = {
  id: "repo-1",
  displayName: "consistency-core",
  source: "local_git",
  trustLevel: "trusted_local",
  monitoringEnabled: true,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z"
};

const automation: Automation = {
  id: "automation-1",
  repositoryId: repository.id,
  name: "PR safety gate",
  trigger: { type: "repository_event", eventTypes: ["pull_request"], debounceMs: 5000 },
  workflowRevisionId: "workflow-revision-1",
  policyRevisionId: "policy-revision-1",
  executionProfile: "static_readonly",
  enabled: true,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z"
};

const capabilities: AuditCapabilities = {
  domainVersion: 2,
  persistence: true,
  repositoryRegistration: true,
  localPathRegistration: false,
  repositoryTimeline: true,
  repositoryMetrics: true,
  workflowValidation: true,
  automationDefinitions: true,
  automationScheduling: false,
  automationHistory: true,
  auditRunDrafts: true,
  auditExecution: false,
  auditRunArtifacts: true,
  auditRunEvents: false,
  auditReports: true,
  auditExport: false,
  issueTriage: true,
  evolutionPersistence: true,
  policyEvaluation: true
};

function render(node: ReactNode): string {
  return renderToString(<I18nProvider initialLocale="en-US"><MemoryRouter>{node}</MemoryRouter></I18nProvider>);
}

describe("audit control-plane routes", () => {
  it("renders only safe repository metadata and gates the folder picker to desktop", () => {
    const html = render(<RepositoriesPage jobs={[]} pulse={null} heartbeatUnavailable={false} jobsUnavailable={false} repositories={[repository]} />);

    expect(html).toContain("consistency-core");
    expect(html).toContain("trusted local");
    expect(html).not.toContain("Select repository");
    expect(html).not.toContain("D:\\private\\checkout");
    expect(html).not.toContain("file://");
  });

  it("repository list renders exactly two semantic primary controls: one button and one anchor", () => {
    const html = render(<RepositoriesPage jobs={[]} pulse={null} heartbeatUnavailable={false} jobsUnavailable={false} repositories={[repository]} />);

    const primaryMatches = html.match(/ds-button ds-button--primary/g) ?? [];
    expect(primaryMatches).toHaveLength(2);
    const anchorMatches = html.match(/<a [^>]*ds-button--primary[^>]*>/g) ?? [];
    expect(anchorMatches).toHaveLength(1);
    const buttonMatches = html.match(/<button [^>]*ds-button--primary[^>]*>/g) ?? [];
    expect(buttonMatches).toHaveLength(1);
  });

  it("shows persisted automation trigger definitions under workflow triggers without pretending scheduling is available", () => {
    const html = renderToString(
      <I18nProvider initialLocale="en-US">
        <MemoryRouter initialEntries={["/workflows?tab=triggers"]}>
          <WorkflowPage automations={[automation]} repositories={[repository]} capabilities={capabilities} />
        </MemoryRouter>
      </I18nProvider>
    );

    expect(html).toContain("PR safety gate");
    expect(html).toContain("Definitions only");
    expect(html).toContain("Static read-only");
    expect(html).not.toContain("Run now");
  });

  it("strictly prohibits non-registered repository IDs from generating navigable routes", () => {
    const pulse = {
      pulseId: "pulse1",
      observedAt: "2026-08-14T00:00:00.000Z",
      pendingEvents: 0,
      state: "idle" as const,
      timestamp: "2026-08-14T00:00:00.000Z",
      dirtyFileCount: 0,
      repository: {
        provider: "local_git" as const,
        root: "unknown_folder",
        branch: "detached",
        dirtyFiles: []
      }
    };

    const html = render(
      <RepositoriesPage
        jobs={[{
          id: "job1",
          type: "PR_REVIEW",
          pullRequestNumber: 1,
          status: "succeeded",
          repositoryFullName: "unknown/source_from_job",
          accessMode: "github_app",
          baseSha: "abc",
          headSha: "def",
          publicationPolicy: "disabled",
          createdAt: "2026-08-14T00:00:00.000Z",
          startedAt: "2026-08-14T00:00:00.000Z",
          finishedAt: "2026-08-14T00:00:00.000Z"
        }]}
        pulse={pulse}
        heartbeatUnavailable={false}
        jobsUnavailable={false}
        repositories={[repository]}
      />
    );

    expect(html).toContain('href="/repositories/repo-1"');

    expect(html).toContain('unknown_folder');
    expect(html).not.toContain('href="/repositories/local:unknown_folder"');
    expect(html).not.toContain('href="/repositories/pulse-unknown_folder"');

    expect(html).toContain('unknown/source_from_job');
    expect(html).not.toContain('href="/repositories/source-unknown%2Fsource_from_job"');
    expect(html).not.toContain('href="/repositories/unknown%2Fsource_from_job"');
  });
});
