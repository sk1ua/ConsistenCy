import { QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { mockJobs, mockReports, mockStats } from "./demo/mockReports";
import { I18nProvider, type Locale } from "./i18n";
import { DashboardPage } from "./pages/DashboardPage";
import { JobsPage } from "./pages/JobsPage";
import { ReportPage } from "./pages/ReportPage";
import { SettingsPage } from "./pages/SettingsPage";
import { createWorkspaceQueryClient } from "./query/client";
import { legacyRouteFromSearch, migrateLegacyLocation } from "./routes/legacyLocation";

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

  it("renders the audit workbench shell and its preserved destinations", () => {
    const html = renderApp();

    expect(html).toContain("ConsistenCy");
    expect(html).toContain("Inbox");
    expect(html).toContain("Repositories");
    expect(html).toContain("Runs");
    expect(html).toContain("Findings");
    expect(html).toContain("Automations");
    expect(html).toContain("Settings");
    expect(html).toContain("Loading review workspace");
  });

  it("renders dashboard, jobs, and report detail views", () => {
    expect(renderToString(<DashboardPage stats={mockStats} jobs={mockJobs} reports={mockReports} onOpenJob={() => {}} onOpenJobs={() => {}} />)).toContain("Inbox");
    expect(renderToString(<JobsPage jobs={mockJobs} onOpenJob={() => {}} />)).toContain("Search repository or PR");
    expect(renderToString(<MemoryRouter><ReportPage job={mockJobs[0]} report={mockReports[0]} onBack={() => {}} /></MemoryRouter>)).toContain("Findings");
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

    expect(html).toContain("审查收件箱");
    expect(html).toContain("仓库");
    expect(html).toContain("自动化");
    expect(html).toContain("中文");
  });
});

describe("legacy route migration", () => {
  it("maps the legacy report selection into a hash-router destination", () => {
    expect(legacyRouteFromSearch("?view=report&job=job/42&notebook=note+7"))
      .toBe("/runs/job%2F42/notebook?notebook=note%207");
  });

  it("preserves the existing top-level destinations", () => {
    expect(legacyRouteFromSearch("?view=dashboard")).toBe("/inbox");
    expect(legacyRouteFromSearch("?view=jobs")).toBe("/runs");
    expect(legacyRouteFromSearch("?view=workflows")).toBe("/workflows");
    expect(legacyRouteFromSearch("?view=settings")).toBe("/settings");
    expect(legacyRouteFromSearch("?unrelated=1")).toBeNull();
  });

  it("replaces a legacy URL once and leaves an existing hash route untouched", () => {
    const replacements: string[] = [];
    const history = { replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => replacements.push(String(url)) };
    expect(migrateLegacyLocation({ pathname: "/app", search: "?keep=1&view=jobs", hash: "" }, history)).toBe(true);
    expect(replacements).toEqual(["/app?keep=1#/runs"]);
    expect(migrateLegacyLocation({ pathname: "/app", search: "?view=jobs", hash: "#/runs" }, history)).toBe(false);
    expect(replacements).toHaveLength(1);
  });
});
