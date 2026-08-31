import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { testJobs, testReports } from "../test/testFixtures";
import { ReportPage } from "./ReportPage";

function renderOverview(job = testJobs[0], report = testReports[0], locale: "en-US" | "zh-CN" = "en-US") {
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
    expect(html).toContain("finding risk: medium");

    // Does NOT contain duplicate inner mode tabs
    expect(html).not.toContain("workspace-mode-tabs");
    expect(html).not.toContain("report-detail-tabs");

    // Does NOT contain duplicate back button
    expect(html).not.toContain("Back to jobs");
  });

  it("truthfully identifies analysis-only reviews without claiming real GitHub App publication", () => {
    const htmlEn = renderOverview(testJobs[0], testReports[0], "en-US");
    expect(htmlEn).toContain("Analysis only");
    expect(htmlEn).not.toContain("GitHub comment");

    const htmlZh = renderOverview(testJobs[0], testReports[0], "zh-CN");
    expect(htmlZh).toContain("仅分析");
    expect(htmlZh).not.toContain("GitHub 评论");
  });

  it("announces and withholds a report that belongs to another job", () => {
    const html = renderOverview(testJobs[1], testReports[0]);

    expect(html).toContain('role="alert"');
    expect(html).toContain("Report integrity check failed");
    expect(html).not.toContain(testReports[0]!.summary);
  });
});
