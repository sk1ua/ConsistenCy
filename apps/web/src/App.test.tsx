import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { App } from "./App";
import { DashboardPage } from "./pages/DashboardPage";
import { JobsPage } from "./pages/JobsPage";
import { ReportPage } from "./pages/ReportPage";
import { SettingsPage } from "./pages/SettingsPage";
import { mockJobs, mockReports, mockStats } from "./demo/mockReports";
import { I18nProvider } from "./i18n";

describe("App", () => {
  it("is a renderable React component", () => {
    expect(App).toBeTypeOf("function");
  });

  it("renders the review operations dashboard", () => {
    const html = renderToString(<App />);

    expect(html).toContain("Dashboard");
    expect(html).toContain("Consisten");
    expect(html).toContain("Loading review workspace");
    expect(html).toContain(">Jobs<");
    expect(html).toContain("Settings");
  });

  it("renders dashboard, jobs, and report detail views", () => {
    expect(renderToString(<DashboardPage stats={mockStats} jobs={mockJobs} reports={mockReports} onOpenJob={() => {}} onOpenJobs={() => {}} />)).toContain("Recent PR review jobs");
    expect(renderToString(<JobsPage jobs={mockJobs} onOpenJob={() => {}} />)).toContain("Search repository or PR");
    expect(renderToString(<ReportPage job={mockJobs[0]} report={mockReports[0]} onBack={() => {}} />)).toContain("Agent runs");
  });

  it("renders the settings editor loading state without exposing configuration", () => {
    const html = renderToString(<SettingsPage health={{
      ok: true,
      service: "consistency-api",
      database: { ok: true },
      worker: { running: true, activeJobs: 0, concurrency: 1 },
      llmProvider: "mock",
      configuration: {
        githubAppConfigured: false,
        webhookSecretConfigured: false,
        databasePath: ".consistency/consistency.db",
        workerConcurrency: 1,
        demoMode: true
      }
    }} />);

    expect(html).toContain("Loading configuration");
    expect(html).not.toContain("API key");
  });

  it("renders the Chinese interface when zh-CN is selected", () => {
    const html = renderToString(<I18nProvider initialLocale="zh-CN"><App /></I18nProvider>);

    expect(html).toContain("仪表盘");
    expect(html).toContain("审查概览");
    expect(html).toContain("中文");
    expect(html).toContain("English");
  });
});
