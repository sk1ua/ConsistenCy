import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AuditCapabilities, Automation, Repository } from "@consistency/schema";
import { I18nProvider } from "../i18n";
import { AutomationsPage } from "./AutomationsPage";
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

  it("shows persisted automation definitions without pretending scheduling or execution is available", () => {
    const html = render(<AutomationsPage automations={[automation]} repositories={[repository]} capabilities={capabilities} />);

    expect(html).toContain("PR safety gate");
    expect(html).toContain("Definitions only");
    expect(html).toContain("Static read-only");
    expect(html).not.toContain("Run now");
  });
});
