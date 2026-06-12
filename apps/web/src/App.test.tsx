import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { App } from "./App";
import { DashboardPage } from "./pages/DashboardPage";
import { JobsPage } from "./pages/JobsPage";
import { ReportPage } from "./pages/ReportPage";
import { mockJobs, mockReports, mockStats } from "./demo/mockReports";

describe("App", () => {
  it("is a renderable React component", () => {
    expect(App).toBeTypeOf("function");
  });

  it("renders the review operations dashboard", () => {
    const html = renderToString(<App />);

    expect(html).toContain("Dashboard");
    expect(html).toContain("PR review operations");
    expect(html).toContain("Loading review workspace");
    expect(html).toContain(">Jobs<");
    expect(html).toContain("Settings");
  });

  it("renders dashboard, jobs, and report detail views", () => {
    expect(renderToString(<DashboardPage stats={mockStats} jobs={mockJobs} reports={mockReports} onOpenJob={() => {}} />)).toContain("Recent review jobs");
    expect(renderToString(<JobsPage jobs={mockJobs} onOpenJob={() => {}} />)).toContain("Search repository or PR");
    expect(renderToString(<ReportPage job={mockJobs[0]} report={mockReports[0]} onBack={() => {}} />)).toContain("Agent runs");
  });
});
