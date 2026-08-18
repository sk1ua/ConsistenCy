import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { mockJobs, mockReports } from "../demo/mockReports";
import { ReportPage } from "./ReportPage";

function renderOverview(job = mockJobs[0], report = mockReports[0], locale: "en-US" | "zh-CN" = "en-US") {
  return renderToString(
    <MemoryRouter>
      <I18nProvider initialLocale={locale}>
        <ReportPage job={job} report={report} onBack={() => undefined} />
      </I18nProvider>
    </MemoryRouter>
  );
}

describe("ReportPage (Review Overview)", () => {
  it("renders review summary, score badge, findings, and evidence summary without duplicate inner tabs", () => {
    const html = renderOverview();

    // Contains review summary and quality score
    expect(html).toContain("Findings");
    expect(html).toContain("74");
    expect(html).toContain("Decision");

    // Does NOT contain duplicate inner mode tabs
    expect(html).not.toContain("workspace-mode-tabs");
    expect(html).not.toContain("report-detail-tabs");

    // Does NOT contain duplicate back button
    expect(html).not.toContain("Back to jobs");
  });

  it("truthfully identifies fixture reviews without claiming real GitHub App publication", () => {
    const htmlEn = renderOverview(mockJobs[0], mockReports[0], "en-US");
    expect(htmlEn).toContain("FIXTURE");
    expect(htmlEn).toContain("Demo fixture");
    expect(htmlEn).toContain("Not published · Analysis only");
    expect(htmlEn).not.toContain("GitHub comment");

    const htmlZh = renderOverview(mockJobs[0], mockReports[0], "zh-CN");
    expect(htmlZh).toContain("演示数据 · FIXTURE");
    expect(htmlZh).toContain("演示数据");
    expect(htmlZh).toContain("未发布 · 仅分析");
    expect(htmlZh).not.toContain("GitHub 评论");
  });

  it("announces and withholds a report that belongs to another job", () => {
    const html = renderOverview(mockJobs[1], mockReports[0]);

    expect(html).toContain('role="alert"');
    expect(html).toContain("Report integrity check failed");
    expect(html).not.toContain(mockReports[0]!.summary);
  });
});
