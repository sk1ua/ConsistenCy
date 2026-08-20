import { QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { I18nProvider, type Locale } from "./i18n";
import { DashboardPage } from "./pages/DashboardPage";
import { JobsPage } from "./pages/JobsPage";
import { ReportPage } from "./pages/ReportPage";
import { SettingsPage } from "./pages/SettingsPage";
import { createWorkspaceQueryClient } from "./query/client";
import { testJobs, testReports, testStats } from "./test/testFixtures";

function renderApp(locale: Locale = "en-US", path = "/inbox"): string {
  const queryClient = createWorkspaceQueryClient();
  return renderToString(
    <I18nProvider initialLocale={locale}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>
  );
}

describe("App", () => {
  it("is a renderable React component", () => {
    expect(App).toBeTypeOf("function");
  });

  it("renders the review workbench shell and its preserved destinations", () => {
    const html = renderApp();

    expect(html).toContain("ConsistenCy");
    expect(html).toContain("Inbox");
    expect(html).toContain("Repositories");
    expect(html).toContain("Runs");
    expect(html).toContain("Findings");
    expect(html).toContain("Workflows");
    expect(html).toContain("Settings");
  });

  it("renders dashboard, jobs, and report detail views", () => {
    expect(renderToString(<DashboardPage stats={testStats} jobs={testJobs} reports={testReports} onOpenJob={() => {}} onOpenJobs={() => {}} />)).toContain("Inbox");
    expect(renderToString(<JobsPage jobs={testJobs} onOpenJob={() => {}} />)).toContain("Search repository or PR");
    expect(renderToString(<MemoryRouter><ReportPage job={testJobs[0]} report={testReports[0]} onBack={() => {}} /></MemoryRouter>)).toContain("Findings");
  });

  it("renders the settings editor loading state without exposing configuration", () => {
    const html = renderToString(<SettingsPage health={{
      ok: true,
      service: "consistency-api",
      database: { ok: true },
      worker: { running: true, activeJobs: 0, concurrency: 1 },
      llmProvider: "none",
      configuration: {
        githubAppConfigured: false,
        webhookSecretConfigured: false,
        publicReadTokenConfigured: false,
        storage: { kind: "file", configured: true },
        workerConcurrency: 1
      }
    }} />);

    expect(html).toContain("Loading configuration");
    expect(html).not.toContain("API key");
  });

  it("renders the Chinese workbench labels when zh-CN is selected", () => {
    const html = renderApp("zh-CN");

    expect(html).toContain("收件箱");
    expect(html).toContain("仓库");
    expect(html).toContain("工作流");
    expect(html).toContain("中文");
  });
});
