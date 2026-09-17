import { QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { I18nProvider, type Locale } from "./i18n";
import { DashboardPage } from "./pages/DashboardPage";
import { JobsPage } from "./pages/JobsPage";
import { ReportPage } from "./pages/ReportPage";
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

  it("renders the locked three-column review shell", () => {
    const html = renderApp();

    expect(html).toContain("ConsistenCy");
    expect(html).toContain("agent-shell");
    expect(html).toContain("Automation");
    expect(html).toContain("Plugin marketplace");
    expect(html).toContain("Connected repositories");
    expect(html).toContain("Settings");
    expect(html).toContain("Evidence review");
  });

  it("renders dashboard, jobs, and report detail views", () => {
    expect(renderToString(<DashboardPage stats={testStats} jobs={testJobs} reports={testReports} onOpenJob={() => {}} onOpenJobs={() => {}} />)).toContain("Inbox");
    expect(renderToString(<JobsPage jobs={testJobs} onOpenJob={() => {}} />)).toContain("Search repository or PR");
    expect(renderToString(<MemoryRouter><ReportPage job={testJobs[0]} report={testReports[0]} onBack={() => {}} /></MemoryRouter>)).toContain("Findings");
  });

  it("renders the settings gear without exposing configuration values", () => {
    const html = renderApp();
    // The ablated /settings page is gone; settings live in the dialog behind
    // the shell gear and never render configuration plaintext in the shell.
    expect(html).not.toContain("API key");
    expect(html).not.toContain("deepseek");
  });

  it("renders the Chinese workbench labels when zh-CN is selected", () => {
    const html = renderApp("zh-CN");

    expect(html).toContain("自动化");
    expect(html).toContain("插件市场");
    expect(html).toContain("已连接仓库");
    expect(html).toContain("审查工作台");
    expect(html).toContain("中文");
  });

  it("keeps the locale switch recognizable when the phone topbar trims labels", () => {
    const html = renderApp();

    expect(html).toContain("shell-locale-button");
    expect(html).toContain("lucide-languages");
    expect(html).toContain("shell-search-button");
    expect(html).toContain(">English</span>");
    expect(html).toContain('aria-label="切换到中文"');

    const zhHtml = renderApp("zh-CN");
    expect(zhHtml).toContain("shell-locale-button");
    expect(zhHtml).toContain("lucide-languages");
    expect(zhHtml).toContain(">中文</span>");
    expect(zhHtml).toContain('aria-label="Switch to English"');
  });
});
